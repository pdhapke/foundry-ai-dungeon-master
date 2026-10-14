import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

import type { AiDmSourceSpan } from "@foundry-ai-dungeon-master/shared";

import { hashText } from "./hash.js";
import { ContextError, type ContextSourceReader } from "./types.js";

export interface CampaignSourceRoot {
  rootId: string;
  path: string;
}

export interface CampaignSourceOptions {
  maxFileBytes?: number;
  maxSourceLines?: number;
  maxSourceCharacters?: number;
}

export interface CampaignSourceFile {
  rootId: string;
  relativePath: string;
  sourceUri: string;
  text: string;
  sourceHash: string;
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function normalizeRelativePath(value: string): string {
  if (!value || value.includes("\0") || isAbsolute(value) || /^[A-Za-z][A-Za-z+.-]*:/.test(value)) {
    throw new ContextError(
      "SOURCE_OUTSIDE_ROOT",
      "The source path must be relative to an allowed root.",
    );
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[:<>"|?*]/.test(part) ||
          [...part].some((character) => character.charCodeAt(0) < 32) ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      )
  )
    throw new ContextError("SOURCE_OUTSIDE_ROOT", "The source contains an unsafe path segment.");
  return normalized;
}

export class CampaignSourceRepository implements ContextSourceReader {
  private readonly roots = new Map<string, string>();
  private readonly maxFileBytes: number;
  private readonly maxSourceLines: number;
  private readonly maxSourceCharacters: number;

  constructor(roots: readonly CampaignSourceRoot[], options: CampaignSourceOptions = {}) {
    if (roots.length === 0) throw new Error("At least one campaign source root is required.");
    for (const root of roots) {
      if (!/^[A-Za-z0-9_-]+$/.test(root.rootId))
        throw new Error(`Invalid source root id ${root.rootId}.`);
      if (this.roots.has(root.rootId)) throw new Error(`Duplicate source root id ${root.rootId}.`);
      this.roots.set(root.rootId, realpathSync(root.path));
    }
    this.maxFileBytes = options.maxFileBytes ?? 512_000;
    this.maxSourceLines = options.maxSourceLines ?? 200;
    this.maxSourceCharacters = options.maxSourceCharacters ?? 32_000;
  }

  load(rootId: string, relativePath: string): CampaignSourceFile {
    const normalized = normalizeRelativePath(relativePath);
    if (extname(normalized).toLowerCase() !== ".md") {
      throw new ContextError("SOURCE_NOT_ALLOWED", "Only Markdown campaign sources are allowed.");
    }
    const root = this.roots.get(rootId);
    if (!root) throw new ContextError("SOURCE_NOT_ALLOWED", `Unknown source root ${rootId}.`);
    const lexicalTarget = resolve(root, normalized);
    if (!contained(root, lexicalTarget)) {
      throw new ContextError("SOURCE_OUTSIDE_ROOT", "The source path escapes its allowed root.");
    }
    let target: string;
    try {
      target = realpathSync(lexicalTarget);
    } catch {
      throw new ContextError("SOURCE_NOT_ALLOWED", "The requested campaign source does not exist.");
    }
    if (!contained(root, target)) {
      throw new ContextError(
        "SOURCE_OUTSIDE_ROOT",
        "The resolved source escapes its allowed root.",
      );
    }
    const stats = statSync(target);
    if (!stats.isFile() || stats.size > this.maxFileBytes) {
      throw new ContextError(
        "SOURCE_NOT_ALLOWED",
        "The campaign source is not an allowed bounded file.",
      );
    }
    const text = readFileSync(target, "utf8");
    const canonicalRelative = relative(root, target).split(sep).join("/");
    return {
      rootId,
      relativePath: canonicalRelative,
      sourceUri: `campaign://${rootId}/${canonicalRelative}`,
      text,
      sourceHash: hashText(text),
    };
  }

  resolveLinkedSource(source: CampaignSourceFile, linkedPath: string): CampaignSourceFile {
    const normalizedLink = normalizeRelativePath(linkedPath.split("#", 1)[0] ?? "");
    // Existing authored sources use campaign/ as a root-relative namespace, not a workspace path.
    if (normalizedLink.startsWith("campaign/"))
      return this.load(source.rootId, normalizedLink.slice("campaign/".length));
    const lastSlash = source.relativePath.lastIndexOf("/");
    const directory = lastSlash >= 0 ? source.relativePath.slice(0, lastSlash + 1) : "";
    return this.load(source.rootId, `${directory}${normalizedLink}`);
  }

  readSource(
    sourceUri: string,
    span: AiDmSourceSpan,
  ): {
    text: string;
    sourceHash: string;
    span: AiDmSourceSpan;
  } {
    const match = /^campaign:\/\/([A-Za-z0-9_-]+)\/(.+)$/.exec(sourceUri);
    if (!match?.[1] || !match[2]) {
      throw new ContextError(
        "SOURCE_NOT_ALLOWED",
        "The source URI is not a registered campaign source.",
      );
    }
    if (
      !Number.isInteger(span.startLine) ||
      !Number.isInteger(span.endLine) ||
      span.startLine < 1 ||
      span.endLine < span.startLine ||
      span.endLine - span.startLine + 1 > this.maxSourceLines
    ) {
      throw new ContextError(
        "SOURCE_NOT_ALLOWED",
        "The requested source span is invalid or too large.",
      );
    }
    const source = this.load(match[1], match[2]);
    const lines = source.text.replaceAll("\r\n", "\n").split("\n");
    if (span.endLine > lines.length) {
      throw new ContextError("SOURCE_NOT_ALLOWED", "The requested source span exceeds the file.");
    }
    const text = lines.slice(span.startLine - 1, span.endLine).join("\n");
    if (text.length > this.maxSourceCharacters) {
      throw new ContextError("SOURCE_NOT_ALLOWED", "The requested source excerpt is too large.");
    }
    return { text, sourceHash: source.sourceHash, span: { ...span } };
  }
}
