import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { latencyEvent } from "../latency-trace.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AiDmJsonValue, AiDmRunPrincipal } from "@foundry-ai-dungeon-master/shared";
import { CampaignSourceRepository } from "./campaign-source.js";
import { CampaignMarkdownParser, sourceNodeId } from "./markdown-context-parser.js";
import type { ParsedCampaignDocument } from "./types.js";
import { contextAccessDecision } from "./visibility-policy.js";
import { hashText } from "./hash.js";
import { assertProtectedCampaignRoot, type ProtectedCampaignOptions } from "./protected-campaign.js";

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
  if (
    existsSync(resolve(target, ".transaction.json")) ||
    existsSync(resolve(target, ".write-lock"))
  )
    throw new Error("Campaign transaction pending recovery or an active writer; context withheld.");
  return target;
}

interface Index {
  repository: CampaignSourceRepository;
  documents: Map<string, { fingerprint: string; document: ParsedCampaignDocument }>;
}

/** Preserve campaign source URIs while preventing linked-source reads outside the domain. */
class ObservationSourceRepository extends CampaignSourceRepository {
  override load(rootId: string, relativePath: string) {
    const normalized = relativePath.replaceAll("\\", "/");
    if (!normalized.startsWith("observations/") || normalized.split("/").includes(".."))
      throw new Error("Observation source escapes reserved domain");
    return super.load(rootId, relativePath);
  }
}

export interface PlayerDescriptionPlan {
  sourceRevision: string;
  points: Array<{ id: string; x: number; y: number; elevation: number }>;
  descriptions: Array<{ queryId: string; description: string; nodeId: string; revision: string }>;
}

/** Indexes bounded Markdown once, refreshes changed files, searches before retrieving bounded spans. */
export class WorldCampaignContext {
  private readonly indexes = new Map<string, Index>();
  private readonly overviewDocuments = new Map<string, { hash: string; document: ParsedCampaignDocument }>();
  constructor(private readonly worldsRoot: string, private readonly protectedOptions?: ProtectedCampaignOptions) {
    if (protectedOptions) assertProtectedCampaignRoot(protectedOptions);
  }
  private campaignRoot(worldId: string): string {
    return worldCampaignRoot(this.protectedOptions ? assertProtectedCampaignRoot(this.protectedOptions) : this.worldsRoot, worldId);
  }

  /** Public canon at explicitly authored observation points, never scene-wide retrieval. */
  playerDescriptionPlan(principal: AiDmRunPrincipal, sceneId: string): PlayerDescriptionPlan {
    const points: PlayerDescriptionPlan["points"] = [], descriptions: PlayerDescriptionPlan["descriptions"] = [];
    try {
      const root = this.campaignRoot(principal.worldId);
      // A reserved source domain keeps unrelated private campaign validation from
      // disabling approved observations. Presence never permits legacy fallback.
      const scoped = readdirSync(root).includes("observations");
      const indexed = this.index(principal.worldId, scoped ? "observations" : undefined);
      // Partial discovery cannot be used to claim a complete applicable source set.
      if (indexed.partial || indexed.issues.length) throw new Error("Incomplete description sources");
      for (const { document } of indexed.index.documents.values()) {
        const metadata = document.frontmatter;
        if (metadata["schema_version"] !== "1" || metadata["visibility"] !== "public" || metadata["canon_status"] !== "canon" || metadata["foundry_scene_id"] !== sceneId || metadata["observation_scope"] !== "point" || !metadata["id"] || !metadata["revision"]) continue;
        const coordinates = ["observation_x", "observation_y", "observation_elevation"].map(key => metadata[key]);
        if (coordinates.some(value => value === undefined || !/^-?\d+(?:\.\d+)?$/.test(value))) continue;
        const [x, y, elevation] = coordinates.map(Number) as [number, number, number];
        if (![x, y, elevation].every(value => Number.isFinite(value) && Math.abs(value) <= 100000)) continue;
        const queryId = `description-${points.length + 1}`;
        const conditions = new Set(document.records.map(record => record.node.activation.conditionRef).filter((value): value is string => Boolean(value)));
        const approved = document.records.filter(record => ["player-visible", "observable"].includes(record.sectionKind) && contextAccessDecision(record, { view: "presenter", principal: { runPrincipal: principal, resolverCanReadSecrets: false, presenterAudienceScope: { kind: "public" } }, activeConditionRefs: conditions }).allowed);
        let added = false;
        for (const record of approved) {
          const body = record.node.body;
          const text = body && typeof body === "object" && !Array.isArray(body) ? body["text"] : undefined;
          // No raw source heading, links, metadata, node identifiers or source spans.
          if (typeof text !== "string" || !text.trim() || text.length > 1000 || Buffer.byteLength(text) > 1800 || /[`<>]|\]\(|\[\[|^#{1,6}\s|(?:Actor|Scene|JournalEntry|Token)\.[A-Za-z0-9]/m.test(text)) continue;
          descriptions.push({ queryId, description: text.trim(), nodeId: hashText(record.node.nodeId), revision: document.sourceHash });
          added = true;
          if (descriptions.length >= 8) break;
        }
        if (added) points.push({ id: queryId, x, y, elevation });
        if (points.length >= 8 || descriptions.length >= 8) break;
      }
    } catch {
      points.length = 0; descriptions.length = 0;
    }
    return { sourceRevision: hashText(JSON.stringify({ worldId: principal.worldId, sceneId, points, descriptions })), points, descriptions };
  }

  /** A reserved allocation, independent of search rank and section size. Data, never instructions. */
  overview(principal: AiDmRunPrincipal): AiDmJsonValue {
    try {
      // Essential context is read directly: capped discovery cannot exclude overview.md.
      const repository = new CampaignSourceRepository([
        { rootId: principal.worldId, path: this.campaignRoot(principal.worldId) },
      ]);
      const validationStarted = performance.now();
      const source = repository.load(principal.worldId, "overview.md");
      // Cache only source parsing, never live actors or permission decisions. The source is
      // loaded and hashed every use; locks, root changes and permissions remain current.
      const cacheKey = JSON.stringify([principal.worldId, source.sourceUri, principal.permissionSnapshotRevision]);
      const prior = this.overviewDocuments.get(cacheKey);
      latencyEvent("context:overview-cache-validation", performance.now() - validationStarted);
      latencyEvent(prior?.hash === source.sourceHash ? "context:overview-cache-hit" : "context:overview-cache-miss");
      const document = prior?.hash === source.sourceHash ? prior.document : new CampaignMarkdownParser(repository).parse(principal.worldId, "overview.md");
      if (document.sourceHash !== source.sourceHash)
        throw new Error("Overview changed during read");
      if (this.overviewDocuments.size >= 32 && !this.overviewDocuments.has(cacheKey)) this.overviewDocuments.clear();
      this.overviewDocuments.set(cacheKey, { hash: source.sourceHash, document });
      const metadata = document.frontmatter;
      const visibility = metadata["visibility"] ?? "gm";
      const canonStatus = metadata["canon_status"] ?? "unverified";
      const valid = Boolean(
        /^[A-Za-z0-9_-]{1,128}$/.test(metadata["id"] ?? "") &&
        /^[A-Za-z0-9_.:-]{1,128}$/.test(metadata["revision"] ?? "") &&
        metadata["schema_version"] === "1" &&
        ["public", "gm", "secret"].includes(visibility) &&
        ["canon", "draft"].includes(canonStatus),
      );
      if (!valid || canonStatus !== "canon" || (!principal.isGm && visibility !== "public"))
        return {
          status: "unavailable",
          worldId: principal.worldId,
          text: "",
          partyActorIds: [],
          reason: "Overview metadata invalid, draft, or private",
        };
      const body = source.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
      if (visibility === "public" && /^#{1,6}\s+(GM-ONLY|DISCOVERABLE|OBSERVABLE)\b/im.test(body))
        return {
          status: "unavailable",
          worldId: principal.worldId,
          text: "",
          partyActorIds: [],
          reason: "Public overview contains private sections",
        };
      // Byte-bounded even with non-ASCII campaign content.
      let text = body.slice(0, 2000);
      while (Buffer.byteLength(text) > 3000) text = text.slice(0, -1);
      const partyActorIds = (metadata["party_actor_ids"] ?? "")
        .split(/[\s,[\]"']+/)
        .filter((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id))
        .slice(0, 8);
      return {
        schemaVersion: 1,
        status: text.length < body.length ? "partial" : "available",
        worldId: principal.worldId,
        id: metadata["id"]!,
        revision: metadata["revision"]!,
        sourceUri: source.sourceUri,
        sourceHash: source.sourceHash,
        visibility,
        canonStatus,
        narrationAllowed: visibility === "public",
        text,
        truncated: text.length < body.length,
        partyActorIds,
        trust: "untrusted-source-data",
      };
    } catch (error) {
      return {
        status: "unavailable",
        worldId: principal.worldId,
        text: "",
        partyActorIds: [],
        reason:
          error instanceof Error && error.message.startsWith("Campaign transaction pending")
            ? "Campaign transaction pending recovery or an active writer; context withheld."
            : "Campaign overview unavailable",
      };
    }
  }

  private index(worldId: string, scope?: "observations"): { index: Index; partial: boolean; issues: string[] } {
    const root = this.campaignRoot(worldId);
    const discoveryRoot = scope ? resolve(root, scope) : root;
    if (scope) {
      const stats = lstatSync(discoveryRoot);
      if (stats.isSymbolicLink() || !stats.isDirectory() || realpathSync(discoveryRoot) !== discoveryRoot || !contained(root, discoveryRoot))
        throw new Error("Invalid observation source domain");
      if (existsSync(resolve(discoveryRoot, ".transaction.json")) || existsSync(resolve(discoveryRoot, ".write-lock")))
        throw new Error("Observation source domain locked");
    }
    const cacheKey = JSON.stringify([root, scope ?? "all"]);
    let index = this.indexes.get(cacheKey);
    if (!index) {
      if (this.indexes.size >= 4) this.indexes.delete(this.indexes.keys().next().value!);
      index = {
        repository: scope
          ? new ObservationSourceRepository([{ rootId: worldId, path: root }])
          : new CampaignSourceRepository([{ rootId: worldId, path: root }]),
        documents: new Map(),
      };
      this.indexes.set(cacheKey, index);
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
        if (scope) {
          if (entry.isSymbolicLink() || realpathSync(path) !== path || !contained(discoveryRoot, realpathSync(path)))
            throw new Error("Observation source redirects outside discovery");
          if ([".transaction.json", ".write-lock"].includes(entry.name))
            throw new Error("Observation source domain locked");
        }
        if (entry.isSymbolicLink()) continue;
        if (
          entry.isDirectory() &&
          (scope || !["assets", "reports", "tools", "preparation", ".git", "node_modules"].includes(entry.name))
        )
          walk(path, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(".md"))
          files.push(relative(root, path).split(sep).join("/"));
      }
    };
    walk(discoveryRoot, 0);
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
        const fingerprint = hashText(index.repository.load(worldId, path).text);
        if (index.documents.get(path)?.fingerprint !== fingerprint)
          index.documents.set(path, { fingerprint, document: parser.parse(worldId, path) });
        if (scope) {
          if (index.documents.get(path)!.document.sourceHash !== fingerprint)
            throw new Error("Observation source changed during parsing");
          const metadata = index.documents.get(path)!.document.frontmatter;
          if (metadata["schema_version"] !== "1" ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(metadata["id"] ?? "") ||
            !/^[A-Za-z0-9_.:-]{1,128}$/.test(metadata["revision"] ?? "") ||
            !["public", "gm", "secret"].includes(metadata["visibility"] ?? "") ||
            !["canon", "draft"].includes(metadata["canon_status"] ?? ""))
            throw new Error("Invalid observation metadata");
        }
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
    } catch (error) {
      return {
        status: "unavailable",
        reason:
          error instanceof Error && error.message.startsWith("Campaign transaction pending")
            ? "Campaign transaction pending recovery or an active writer; context withheld."
            : "Active world data/campaign is missing or outside its allowed root",
        excerpts: [],
      };
    }
    const { index, issues } = indexed;
    const rawManifest = index.documents.get("index.md")?.document;
    const manifest = principal.isGm || rawManifest?.frontmatter["visibility"] === "public" ? rawManifest : undefined;
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? [])].slice(0, 32);
    const indexedTargets = new Set(
      (manifest?.records ?? [])
        .filter((record) => principal.isGm || contextAccessDecision(record, { view: "presenter", principal: { runPrincipal: principal, resolverCanReadSecrets: false, presenterAudienceScope: { kind: "public" } }, activeConditionRefs: new Set<string>() }).allowed)
        .filter((record) =>
          terms.some((term) => JSON.stringify(record.node.body).toLowerCase().includes(term)),
        )
        .flatMap((record) => record.edges.map((edge) => edge.targetNodeId)),
    );
    if (manifest) {
      const source = index.repository.load(principal.worldId, "index.md");
      for (const record of manifest.records) {
        if (!principal.isGm && !contextAccessDecision(record, { view: "presenter", principal: { runPrincipal: principal, resolverCanReadSecrets: false, presenterAudienceScope: { kind: "public" } }, activeConditionRefs: new Set<string>() }).allowed) continue;
        const body = JSON.stringify(record.node.body);
        const matched = terms.some((term) => body.toLowerCase().includes(term));
        for (const link of [...body.matchAll(/\]\(([^)]+\.md(?:#[^)]*)?)\)/g)].slice(0, 32)) {
          try {
            const target = index.repository.resolveLinkedSource(source, link[1]!);
            if (matched) indexedTargets.add(sourceNodeId(target.rootId, target.relativePath));
          } catch {
            if (!issues.includes("index.md")) issues.push("index.md");
          }
        }
      }
    }
    const rawState = index.documents.get("campaign-state.md")?.document.frontmatter;
    const state = principal.isGm || rawState?.["visibility"] === "public" ? rawState : undefined;
    const currentRoom =
      state?.["current_scene_id"] === sceneId ? state?.["current_room_id"] : undefined;
    const candidates = [...index.documents.values()]
      .flatMap(({ document }) => {
        const documentVisibility = document.frontmatter["visibility"];
        if (documentVisibility && !["public", "gm", "secret"].includes(documentVisibility))
          return [];
        if (documentVisibility && documentVisibility !== "public" && !principal.isGm) return [];
        const canonStatus = document.frontmatter["canon_status"];
        if (canonStatus && canonStatus !== "canon") return [];
        if (document.relativePath === "overview.md") return [];
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
            const narrationAllowed =
              (!documentVisibility || documentVisibility === "public") &&
              contextAccessDecision(record, {
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
              (documentId === currentRoom && currentRoom ? 15 : 0) +
              (indexedTargets.has(document.records[0]?.node.nodeId ?? "") ? 8 : 0);
            const metadata = {
              id: documentId || record.node.nodeId,
              revision: document.frontmatter["revision"] ?? record.node.sourceHash ?? "unknown",
              canonStatus: canonStatus ?? "legacy",
              documentVisibility: document.frontmatter["visibility"] ?? "legacy",
            };
            return {
              record,
              narrationAllowed,
              score,
              resolver,
              summary: document.relativePath === "campaign-state.md",
              metadata,
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
    let bytes = 0;
    let partial = principal.isGm && indexed.partial;
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
          visibility: ["gm", "secret"].includes(item.metadata.documentVisibility)
            ? "secret"
            : item.record.visibility,
          ...item.metadata,
          trust: "untrusted-source-data",
        };
        const size = JSON.stringify(excerpt).length;
        const encodedSize = Buffer.byteLength(JSON.stringify(excerpt));
        if (characters + size > 10000 || bytes + encodedSize > 10000) {
          partial = true;
          continue;
        }
        excerpts.push(excerpt);
        perSource.set(node.sourceUri, (perSource.get(node.sourceUri) ?? 0) + 1);
        if (item.summary) summaries += 1;
        characters += size;
        bytes += encodedSize;
      } catch {
        partial = true;
      }
    }
    return {
      status: principal.isGm && issues.length ? "partial" : "available",
      worldId: principal.worldId,
      query,
      excerpts,
      partial,
      characters,
      bytes,
      sourceIssues: principal.isGm ? issues.slice(0, 10) : [],
      indexStatus: manifest
        ? manifest.frontmatter["schema_version"] === "1" &&
          manifest.frontmatter["id"] &&
          manifest.frontmatter["revision"] &&
          manifest.frontmatter["canon_status"] === "canon"
          ? "available"
          : "legacy-or-invalid-metadata"
        : "missing-legacy-search",
      indexSourceHash: manifest?.records[0]?.node.sourceHash ?? null,
      trust: "untrusted-source-data",
      summaryPolicy:
        "campaign-state excerpts are recorded history, live Foundry state takes precedence",
      utility: {
        name: "campaign_validate_sources",
        input: {},
        effects: ["read"],
        result: {
          indexedDocuments: principal.isGm ? index.documents.size : 0,
          invalidSources: principal.isGm ? issues.slice(0, 10) : [],
          partial: principal.isGm && indexed.partial,
        },
      },
    };
  }
}

