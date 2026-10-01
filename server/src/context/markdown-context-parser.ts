import type {
  AiDmAccessScope,
  AiDmContextActivation,
  AiDmContextNode,
  AiDmVisibility,
} from "@foundry-ai-dungeon-master/shared";

import type { CampaignSourceFile, CampaignSourceRepository } from "./campaign-source.js";
import { revisionOf } from "./hash.js";
import type {
  ContextEdgeRecord,
  ContextNodeRecord,
  ContextSectionKind,
  ParsedCampaignDocument,
} from "./types.js";

interface Section {
  heading: string;
  kind: ContextSectionKind;
  startLine: number;
  endLine: number;
  body: string;
}

const gmScope: AiDmAccessScope = { kind: "gm" };
const publicScope: AiDmAccessScope = { kind: "public" };

const sectionKinds = new Map<string, ContextSectionKind>([
  ["PLAYER-VISIBLE", "player-visible"],
  ["OBSERVABLE", "observable"],
  ["DISCOVERABLE", "discoverable"],
  ["GM-ONLY", "gm-only"],
  ["STATE-CHANGE", "state-change"],
  ["FOUNDRY-SYNC", "foundry-sync"],
  ["NEXT-LOAD", "next-load"],
  ["SOURCE PROVENANCE", "source-provenance"],
]);

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "section"
  );
}

export function sourceNodeId(rootId: string, relativePath: string): string {
  return `source:${rootId}:${revisionOf(relativePath).slice(0, 24)}`;
}

function sectionPolicy(
  kind: ContextSectionKind,
  conditionRef: string,
  documentConditionRef: string,
): {
  visibility: AiDmVisibility;
  readScope: AiDmAccessScope;
  disclosureScope: AiDmAccessScope;
  activation: AiDmContextActivation;
} {
  if (kind === "player-visible") {
    return {
      visibility: "public",
      readScope: publicScope,
      disclosureScope: publicScope,
      activation: { status: "conditional", conditionRef: documentConditionRef },
    };
  }
  if (kind === "observable" || kind === "discoverable") {
    return {
      visibility: "secret",
      readScope: publicScope,
      disclosureScope: publicScope,
      activation: { status: "conditional", conditionRef },
    };
  }
  return {
    visibility: "secret",
    readScope: gmScope,
    disclosureScope: gmScope,
    activation: { status: "active", conditionRef: null },
  };
}

function parseFrontmatter(lines: readonly string[]): {
  values: Record<string, string>;
  endIndex: number;
} {
  if (lines[0]?.trim() !== "---") return { values: {}, endIndex: 0 };
  const closing = lines.slice(1, 258).findIndex((line) => line.trim() === "---");
  if (closing < 0) return { values: {}, endIndex: 0 };
  const endIndex = closing + 1;
  const values: Record<string, string> = {};
  for (const line of lines.slice(1, endIndex)) {
    if (line.length > 2_048 || /^\s/.test(line)) continue;
    const match = /^([A-Za-z0-9_-]{1,80}):\s*(.*?)\s*$/.exec(line);
    if (!match?.[1] || match[2] === undefined || Object.keys(values).length >= 128) continue;
    values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return { values, endIndex: endIndex + 1 };
}

function parseSections(lines: readonly string[], startIndex: number): Section[] {
  const headings: Array<{ index: number; heading: string }> = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const match = /^#{2,4}\s+(.+?)\s*$/.exec(lines[index] ?? "");
    if (match?.[1]) headings.push({ index, heading: match[1] });
  }
  const sections: Section[] = [];
  if (headings[0] && headings[0].index > startIndex) {
    const body = lines.slice(startIndex, headings[0].index).join("\n").trim();
    if (body) {
      sections.push({
        heading: "Unclassified",
        kind: "unclassified",
        startLine: startIndex + 1,
        endLine: headings[0].index,
        body,
      });
    }
  }
  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index];
    if (!current) continue;
    const nextIndex = headings[index + 1]?.index ?? lines.length;
    const normalized = current.heading.trim().toUpperCase();
    sections.push({
      heading: current.heading,
      kind: sectionKinds.get(normalized) ?? "unclassified",
      startLine: current.index + 1,
      endLine: nextIndex,
      body: lines
        .slice(current.index + 1, nextIndex)
        .join("\n")
        .trim(),
    });
  }
  return sections;
}

function linkedPaths(line: string): string[] {
  const paths: string[] = [];
  for (const match of line.matchAll(/\[[^\]]+\]\(([^)]+\.md(?:#[^)]+)?)\)/gi)) {
    if (match[1]) paths.push(match[1].trim());
  }
  for (const match of line.matchAll(/`([^`]+\.md(?:#[^`]*)?)`/gi)) {
    if (match[1]) paths.push(match[1].trim());
  }
  return [...new Set(paths)];
}

export class CampaignMarkdownParser {
  constructor(private readonly repository: CampaignSourceRepository) {}

  parse(rootId: string, relativePath: string): ParsedCampaignDocument {
    const source = this.repository.load(rootId, relativePath);
    return this.parseLoaded(source);
  }

  private parseLoaded(source: CampaignSourceFile): ParsedCampaignDocument {
    const lines = source.text.replaceAll("\r\n", "\n").split("\n");
    const frontmatter = parseFrontmatter(lines);
    const documentNodeId = sourceNodeId(source.rootId, source.relativePath);
    const documentConditionRef = `activate-document:${documentNodeId}`;
    const title =
      frontmatter.values["title"] ??
      lines
        .find((line) => /^#\s+/.test(line))
        ?.replace(/^#\s+/, "")
        .trim() ??
      source.relativePath;
    const records: ContextNodeRecord[] = [];
    const documentRecord = this.record({
      nodeId: documentNodeId,
      title,
      body: { id: frontmatter.values["id"] ?? null, relativePath: source.relativePath },
      source,
      sectionKind: "frontmatter",
      visibility: "secret",
      readScope: gmScope,
      disclosureScope: gmScope,
      activation: { status: "active", conditionRef: null },
      startLine: 1,
      endLine: Math.max(1, frontmatter.endIndex),
      edges: [],
      kind: source.relativePath.endsWith("campaign-state.md")
        ? "campaign-state"
        : "campaign-source",
    });
    records.push(documentRecord);

    for (const [index, section] of parseSections(lines, frontmatter.endIndex).entries()) {
      const sectionNodeId = `${documentNodeId}:${slug(section.heading)}:${index + 1}`;
      const conditionRef = `reveal:${sectionNodeId}`;
      const policy = sectionPolicy(section.kind, conditionRef, documentConditionRef);
      const edges =
        section.kind === "next-load" ? this.parseNextLoadEdges(source, section, sectionNodeId) : [];
      const record = this.record({
        nodeId: sectionNodeId,
        title: section.heading,
        body: { text: section.body },
        source,
        sectionKind: section.kind,
        ...policy,
        startLine: section.startLine,
        endLine: Math.max(section.startLine, section.endLine),
        edges,
        kind: "campaign-source",
      });
      records.push(record);
      documentRecord.edges.push(...edges);
      documentRecord.node.edges.push(
        ...edges.map(({ relation, targetNodeId, visibility }) => ({
          relation,
          targetNodeId,
          visibility,
        })),
      );
    }
    documentRecord.node.revision = revisionOf({
      ...documentRecord.node,
      revision: undefined,
      edges: documentRecord.node.edges,
    });
    return {
      rootId: source.rootId,
      relativePath: source.relativePath,
      sourceUri: source.sourceUri,
      sourceHash: source.sourceHash,
      frontmatter: frontmatter.values,
      records,
    };
  }

  private parseNextLoadEdges(
    source: CampaignSourceFile,
    section: Section,
    sectionNodeId: string,
  ): ContextEdgeRecord[] {
    const edges: ContextEdgeRecord[] = [];
    const lines = section.body.split("\n");
    for (const [offset, line] of lines.entries()) {
      for (const path of linkedPaths(line)) {
        const target = this.repository.resolveLinkedSource(source, path);
        const targetNodeId = sourceNodeId(target.rootId, target.relativePath);
        const edgeId = `edge:${revisionOf({ sectionNodeId, line, path }).slice(0, 24)}`;
        edges.push({
          edgeId,
          relation: "next-load",
          targetNodeId,
          visibility: "secret",
          conditionRef: `activate:${edgeId}`,
          explicitExpansionRequired: true,
          sourceSpan: {
            startLine: section.startLine + offset + 1,
            endLine: section.startLine + offset + 1,
          },
        });
      }
    }
    return edges;
  }

  private record(input: {
    nodeId: string;
    title: string;
    body: AiDmContextNode["body"];
    source: CampaignSourceFile;
    sectionKind: ContextSectionKind;
    visibility: AiDmVisibility;
    readScope: AiDmAccessScope;
    disclosureScope: AiDmAccessScope;
    activation: AiDmContextActivation;
    startLine: number;
    endLine: number;
    edges: ContextEdgeRecord[];
    kind: AiDmContextNode["kind"];
  }): ContextNodeRecord {
    const node: AiDmContextNode = {
      nodeId: input.nodeId,
      kind: input.kind,
      revision: "",
      authoritative: true,
      authority: "narrative-filesystem",
      readScope: input.readScope,
      disclosureScope: input.disclosureScope,
      activation: input.activation,
      title: input.title,
      contentType: "text/markdown",
      body: input.body,
      sourceUri: input.source.sourceUri,
      sourceHash: input.source.sourceHash,
      sourceSpan: { startLine: input.startLine, endLine: input.endLine },
      edges: input.edges.map(({ relation, targetNodeId, visibility }) => ({
        relation,
        targetNodeId,
        visibility,
      })),
      dependencies: [],
      stale: false,
    };
    node.revision = revisionOf({ ...node, revision: undefined });
    return {
      node,
      visibility: input.visibility,
      sectionKind: input.sectionKind,
      edges: [...input.edges],
    };
  }
}
