import { readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AiDmJsonValue, AiDmRunPrincipal } from "@foundry-ai-dungeon-master/shared";
import { CampaignSourceRepository } from "./campaign-source.js";
import { CampaignMarkdownParser } from "./markdown-context-parser.js";
import type { ParsedCampaignDocument } from "./types.js";
import { contextAccessDecision } from "./visibility-policy.js";

function contained(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

/** Server-configured worlds directory plus a live-authorized world identifier; never a client path. */
export function worldCampaignRoot(worldsRoot: string, worldId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(worldId)) throw new Error("Invalid world identifier");
  const root = realpathSync(worldsRoot);
  const target = realpathSync(resolve(root, worldId, "data", "campaign"));
  if (!contained(root, target)) throw new Error("World campaign escapes worlds directory");
  const world = realpathSync(resolve(root, worldId));
  if (world !== resolve(root, worldId))
    throw new Error("World directory redirects to another path");
  if (!contained(world, target)) throw new Error("Campaign escapes world directory");
  return target;
}

interface Index {
  repository: CampaignSourceRepository;
  documents: Map<string, { fingerprint: string; document: ParsedCampaignDocument }>;
}

/** Indexes bounded Markdown once, refreshes changed files, searches before retrieving bounded spans. */
export class WorldCampaignContext {
  private readonly indexes = new Map<string, Index>();
  constructor(private readonly worldsRoot: string) {}

  private index(worldId: string): { index: Index; partial: boolean; issues: string[] } {
    const root = worldCampaignRoot(this.worldsRoot, worldId);
    let index = this.indexes.get(root);
    if (!index) {
      if (this.indexes.size >= 4) this.indexes.delete(this.indexes.keys().next().value!);
      index = {
        repository: new CampaignSourceRepository([{ rootId: worldId, path: root }]),
        documents: new Map(),
      };
      this.indexes.set(root, index);
    }
    const files: string[] = [];
    let partial = false;
    let entries = 0;
    const walk = (directory: string, depth: number) => {
      if (depth > 6) {
        partial = true;
        return;
      }
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (++entries > 2048 || files.length >= 256) {
          partial = true;
          return;
        }
        const path = resolve(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (
          entry.isDirectory() &&
          !["assets", "reports", "tools", ".git", "node_modules"].includes(entry.name)
        )
          walk(path, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(".md"))
          files.push(relative(root, path).split(sep).join("/"));
      }
    };
    walk(root, 0);
    const issues: string[] = [];
    let bytes = 0;
    const parser = new CampaignMarkdownParser(index.repository);
    const seen = new Set<string>();
    for (const path of files) {
      seen.add(path);
      try {
        const stats = statSync(resolve(root, path));
        bytes += stats.size;
        if (bytes > 4_000_000) {
          partial = true;
          index.documents.delete(path);
          continue;
        }
        const fingerprint = `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
        if (index.documents.get(path)?.fingerprint !== fingerprint)
          index.documents.set(path, { fingerprint, document: parser.parse(worldId, path) });
      } catch {
        index.documents.delete(path);
        issues.push(path);
      }
    }
    for (const path of index.documents.keys()) if (!seen.has(path)) index.documents.delete(path);
    return { index, partial, issues };
  }

  retrieve(principal: AiDmRunPrincipal, query: string, sceneId: string | null): AiDmJsonValue {
    if (query.length > 256) throw new Error("Campaign query exceeds budget");
    let indexed: ReturnType<WorldCampaignContext["index"]>;
    try {
      indexed = this.index(principal.worldId);
    } catch {
      return {
        status: "unavailable",
        reason: "Active world data/campaign is missing or outside its allowed root",
        excerpts: [],
      };
    }
    const { index, issues } = indexed;
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? [])].slice(0, 32);
    const state = index.documents.get("campaign-state.md")?.document.frontmatter;
    const currentRoom =
      state?.["current_scene_id"] === sceneId ? state?.["current_room_id"] : undefined;
    const candidates = [...index.documents.values()]
      .flatMap(({ document }) => {
        const conditions = new Set<string>();
        const boundScene =
          document.frontmatter["foundry_scene_id"] ??
          document.frontmatter["current_scene_id"] ??
          /scene_id:\s*([A-Za-z0-9_-]+)/.exec(document.frontmatter["foundry"] ?? "")?.[1];
        const documentId = document.frontmatter["id"] ?? "";
        if (
          sceneId &&
          (boundScene === sceneId ||
            document.frontmatter["foundry_scene_ids"]?.includes(sceneId)) &&
          (!documentId.startsWith("ROOM-") || documentId === currentRoom)
        )
          conditions.add(`activate-document:${document.records[0]?.node.nodeId}`);
        return document.records
          .filter((record) => record.sectionKind !== "frontmatter")
          .map((record) => {
            const resolver = contextAccessDecision(record, {
              view: "resolver",
              principal: { runPrincipal: principal, resolverCanReadSecrets: principal.isGm },
              activeConditionRefs: conditions,
            }).allowed;
            const narrationAllowed = contextAccessDecision(record, {
              view: "presenter",
              principal: {
                runPrincipal: principal,
                resolverCanReadSecrets: false,
                presenterAudienceScope: { kind: "public" },
              },
              activeConditionRefs: conditions,
            }).allowed;
            const text = JSON.stringify(record.node.body).toLowerCase();
            const score =
              terms.reduce(
                (total, term) =>
                  total +
                  (text.includes(term) ? 1 : 0) +
                  (documentId.toLowerCase() === term ? 12 : 0) +
                  (document.relativePath.toLowerCase().includes(term) ? 3 : 0),
                0,
              ) +
              (boundScene === sceneId && sceneId ? 5 : 0) +
              (documentId === currentRoom && currentRoom ? 15 : 0);
            return {
              record,
              narrationAllowed,
              score,
              resolver,
              summary: document.relativePath === "campaign-state.md",
            };
          });
      })
      .filter((item) => item.resolver && (item.score > 0 || item.summary))
      .sort(
        (a, b) =>
          Number(b.summary) - Number(a.summary) ||
          b.score - a.score ||
          a.record.node.nodeId.localeCompare(b.record.node.nodeId),
      );
    const excerpts: AiDmJsonValue[] = [];
    let characters = 0;
    let partial = indexed.partial;
    let summaries = 0;
    const perSource = new Map<string, number>();
    for (const item of candidates) {
      if (item.summary && summaries >= 1) continue;
      if (excerpts.length >= 6) {
        partial = true;
        break;
      }
      const node = item.record.node;
      if (!node.sourceUri || !node.sourceSpan) continue;
      if ((perSource.get(node.sourceUri) ?? 0) >= 2) continue;
      const span = {
        startLine: node.sourceSpan.startLine,
        endLine: Math.min(node.sourceSpan.endLine, node.sourceSpan.startLine + 39),
      };
      try {
        const source = index.repository.readSource(node.sourceUri, span);
        if (source.sourceHash !== node.sourceHash) {
          partial = true;
          continue;
        }
        const excerpt = {
          sourceUri: node.sourceUri,
          sourceHash: source.sourceHash,
          span,
          title: node.title,
          text: source.text,
          narrationAllowed: item.narrationAllowed,
          visibility: item.record.visibility,
        };
        const size = JSON.stringify(excerpt).length;
        if (characters + size > 10000) {
          partial = true;
          continue;
        }
        excerpts.push(excerpt);
        perSource.set(node.sourceUri, (perSource.get(node.sourceUri) ?? 0) + 1);
        if (item.summary) summaries += 1;
        characters += size;
      } catch {
        partial = true;
      }
    }
    return {
      status: issues.length ? "partial" : "available",
      worldId: principal.worldId,
      query,
      excerpts,
      partial,
      characters,
      sourceIssues: issues.slice(0, 10),
      summaryPolicy:
        "campaign-state excerpts are recorded history, live Foundry state takes precedence",
      utility: {
        name: "campaign_validate_sources",
        input: {},
        effects: ["read"],
        result: {
          indexedDocuments: index.documents.size,
          invalidSources: issues.slice(0, 10),
          partial: indexed.partial,
        },
      },
    };
  }
}
