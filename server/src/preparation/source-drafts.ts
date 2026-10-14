import { hashText } from "../context/hash.js";
import type { CampaignSourceFile } from "../context/campaign-source.js";
import { posix } from "node:path";
import { validateRecords, type CampaignRecord, type PreparationCandidate } from "./records.js";

export interface SourceDraftInventoryEntry {
  uri: string;
  hash: string;
  recordId: string;
  kind: CampaignRecord["kind"];
  sections: number;
  links: string[];
  unknownMarkers: string[];
}
function authoredScalar(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 202) return null;
  if (/^"[^"\\]*"$/.test(trimmed) || /^'[^']*'$/.test(trimmed)) return trimmed.slice(1, -1);
  return /^[^\[\]{}&*!|>@`#:,\r\n]+$/.test(trimmed) ? trimmed : null;
}
function authoredIdentity(lines: string[]) {
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  if (end < 0) return { aliases: [] as string[], metadataEnd: 0, unknowns: [] as string[] };
  const metadata = lines.slice(1, end);
  const aliases: string[] = [];
  const unknowns: string[] = [];
  const ids = metadata.filter(line => /^id\s*:/.test(line));
  if (ids.length === 1) {
    const id = authoredScalar(ids[0]!.replace(/^id\s*:/, ""));
    if (id && /^[A-Za-z0-9_-]{1,128}$/.test(id)) aliases.push(id);
    else unknowns.push("Authored ID is unsupported or ambiguous; no identity inferred.");
  } else if (ids.length > 1) unknowns.push("Duplicate authored ID fields require review.");
  const fields = metadata.map((line, i) => ({ line, i })).filter(({ line }) => /^aliases\s*:/.test(line));
  if (fields.length > 1) unknowns.push("Duplicate authored alias fields require review.");
  if (fields.length === 1) {
    const field = fields[0]!;
    const raw = field.line.replace(/^aliases\s*:/, "").trim();
    let values: string[] | null = null;
    if (!raw) {
      const items: string[] = [];
      for (let i = field.i + 1; i < metadata.length && /^\s+-\s/.test(metadata[i]!); i++) items.push(metadata[i]!.replace(/^\s+-\s/, ""));
      values = items;
    } else if (raw.startsWith("[") && raw.endsWith("]")) {
      // A deliberately narrow scalar-list grammar; commas inside quoted values remain intact.
      const tokens = raw.slice(1, -1).match(/"[^"\\]*"|'[^']*'|[^,]+/g) ?? [];
      if (tokens.map(t => t.trim()).join(",") === raw.slice(1, -1).replace(/\s*,\s*/g, ",").trim()) values = tokens;
    } else values = [raw];
    const parsed = values?.map(authoredScalar);
    if (!parsed || parsed.some(value => !value) || parsed.length > 31) unknowns.push("Unsupported or ambiguous authored aliases require review.");
    else aliases.push(...parsed as string[]);
  }
  return { aliases: [...new Set(aliases)], metadataEnd: end + 1, unknowns };
}

/** Re-resolves only explicit selected-source Markdown links, including after packet composition. */
export function resolveSelectedSourceReferences(input: readonly CampaignRecord[]): CampaignRecord[] {
  const selected = new Map(input.filter(r => r.id.startsWith("source-")).map(r => [r.sources[0]!.uri, r.id]));
  const aliasOwners = new Map<string, Set<string>>();
  for (const record of input) for (const alias of record.aliases) {
    const owners = aliasOwners.get(alias.toLowerCase()) ?? new Set<string>();
    owners.add(record.id); aliasOwners.set(alias.toLowerCase(), owners);
  }
  return input.map(record => {
    if (!record.id.startsWith("source-")) return record;
    const prefix = `campaign://${record.worldId}/`;
    const uri = record.sources[0]!.uri;
    const base = uri.startsWith(prefix) ? posix.dirname(uri.slice(prefix.length)) : "";
    const relationships = record.relationships.filter(r => r.relation !== "source-reference");
    const unknowns = record.unknowns.filter(u => !u.startsWith("Unresolved selected source reference:"));
    const links = [...new Set([...record.sections.map(s => s.text).join("\n").matchAll(/\[[^\]\r\n]*\]\(([^)\r\n]+)\)/g)].map(m => m[1]!))];
    let omitted = 0;
    for (const link of links) {
      const path = link.split("#", 1)[0]!;
      let target: string | undefined;
      if (path.startsWith(prefix)) target = selected.get(path);
      else if (path && !/^[A-Za-z][A-Za-z+.-]*:/.test(path) && !path.startsWith("/") && !path.includes("\\")) {
        const normalized = posix.normalize(posix.join(base, path));
        if (normalized !== ".." && !normalized.startsWith("../")) target = selected.get(prefix + normalized);
      }
      if (target && target !== record.id && relationships.length < 64) {
        if (!relationships.some(r => r.id === target && r.relation === "source-reference")) relationships.push({ id: target, relation: "source-reference" });
      } else if (!target && path) {
        if (unknowns.length < 31) unknowns.push(`Unresolved selected source reference: ${link}`.slice(0, 500)); else omitted++;
      }
    }
    if (omitted && unknowns.length < 32) unknowns.push("Further source references require review outside the bounded unknown list.");
    const collisions = record.aliases.filter(alias => aliasOwners.get(alias.toLowerCase())!.size > 1);
    return { ...record, relationships, unknowns,
      aliases: record.aliases.filter(alias => !collisions.includes(alias)),
      contradictions: [...new Set([...record.contradictions,
        ...collisions.map(alias => `Ambiguous authored alias requires identity review: ${alias}`)])].slice(0, 32) };
  });
}
/** Full bounded mechanical record preparation. Content is retained as untrusted GM-only
 * quoted source data. No identity/name inference, inferred canon, or mutation authority. */
export function prepareSourceRecords(worldId: string, sources: readonly CampaignSourceFile[]) {
  if (!sources.length || sources.length > 512) throw Error("Inventory source budget");
  const seen = new Set<string>();
  let bytes = 0;
  const inventory: SourceDraftInventoryEntry[] = [];
  const records: CampaignRecord[] = [];
  for (const source of [...sources].sort((a, b) => a.sourceUri.localeCompare(b.sourceUri))) {
    if (source.rootId !== worldId || source.sourceUri !== `campaign://${worldId}/${source.relativePath}` ||
        hashText(source.text) !== source.sourceHash || seen.has(source.sourceUri.toLowerCase()))
      throw Error("Source identity, revision, or duplicate conflict");
    seen.add(source.sourceUri.toLowerCase());
    bytes += Buffer.byteLength(source.text);
    if (Buffer.byteLength(source.text) > 512000 || bytes > 8000000) throw Error("Inventory byte budget");
    const lines = source.text.replaceAll("\r\n", "\n").split("\n");
    const identity = authoredIdentity(lines);
    let begin = 0;
    if (lines[0] === "---") {
      const end = lines.indexOf("---", 1);
      if (end < 0) throw Error("Unterminated source metadata");
      begin = end + 1;
    }
    // Split only at top-level narrative subsections; subordinate qualifications stay together.
    // Fenced headings are content, never boundaries.
    const boundaries = [begin];
    let fence: string | null = null;
    for (let i = begin; i < lines.length; i++) {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]!);
      if (marker) { if (!fence) fence = marker[1]![0]!; else if (fence === marker[1]![0]) fence = null; continue; }
      if (!fence && /^##\s/.test(lines[i]!) && i > begin) boundaries.push(i);
    }
    boundaries.push(lines.length);
    const sections: CampaignRecord["sections"] = [];
    const refs: CampaignRecord["sources"] = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
      const start = boundaries[i]!, end = boundaries[i + 1]!;
      const text = lines.slice(start, end).join("\n");
      if (!text.trim()) continue;
      if (text.length > 16000 || Buffer.byteLength(text) > 32000)
        throw Error("Whole source section needs explicit narrower scope");
      const heading = /^#{1,6}\s+(.+)$/m.exec(text)?.[1]?.slice(0, 180) ?? "Source introduction";
      sections.push({ heading, text });
      refs.push({ uri: source.sourceUri, hash: source.sourceHash, startLine: start + 1, endLine: end });
    }
    if (!sections.length || sections.length > 40) throw Error("Source section budget");
    const prefix = source.relativePath.split("/")[0]?.toLowerCase();
    const kind: CampaignRecord["kind"] = prefix === "npcs" ? "npc" :
      ["floors","navigation","places","locations","areas","regions"].includes(prefix??'') ? "place" :
      prefix === "factions" ? "faction" : prefix === "quests" ? "quest" :
      prefix === "encounters" ? "encounter" : ["sessions","observations","events"].includes(prefix??'') ? "event" : "lore";
    const id = `source-${hashText(source.sourceUri).slice(0, 24)}`;
    const unknownMarkers = [...new Set(source.text.match(/UNRESOLVED\([^\r\n)]{1,200}\)/g) ?? [])];
    inventory.push({ uri: source.sourceUri, hash: source.sourceHash, recordId: id, kind,
      sections: sections.length, links: [...new Set([...source.text.matchAll(/\[[^\]\r\n]*\]\(([^)\r\n]+)\)/g)].map(m => m[1]!))].slice(0, 128), unknownMarkers });
    const record: CampaignRecord = { schemaVersion: 1, id, worldId, kind,
      title: (source.relativePath.replace(/\.md$/i, "")).slice(0, 200), aliases: identity.aliases, revision: 1,
      visibility: "gm", status: "draft", epistemic: "proposed", generated: false,
      sources: refs, relationships: [], sections,
      unknowns: ["Untrusted source data: review factual currency, contradictions, disclosure, and starting situation. Foundry remains authoritative for live mechanics.", ...identity.unknowns, ...unknownMarkers].slice(0, 32), contradictions: [] };
    if (identity.aliases.length) record.sources.push({ uri: source.sourceUri, hash: source.sourceHash, startLine: 1, endLine: identity.metadataEnd });
    if (Buffer.byteLength(JSON.stringify(record)) > 90000) throw Error("Whole source record needs narrower bounded review");
    records.push(record);
  }
  return { records: resolveSelectedSourceReferences(records), inventory, bytes };
}

/** Each independently reviewable packet is bounded to 28 records. The production
 * referenced corpus can compose reviewed packets up to its separate 256-record limit. */
export function sourceRecordDraftPackets(worldId: string, candidateId: string, sources: readonly CampaignSourceFile[]) {
  if (!/^[A-Za-z0-9_-]{1,56}$/.test(candidateId)) throw Error("Candidate identity budget");
  const prepared = prepareSourceRecords(worldId, sources);
  const overviewSections: CampaignRecord["sections"] = [];
  const overviewRefs: CampaignRecord["sources"] = [];
  let overviewBytes = 0;
  const overviewSources = [...prepared.records].sort((a, b) =>
    Number(b.sections.some(s => /^(campaign premise|premise)$/i.test(s.heading))) -
    Number(a.sections.some(s => /^(campaign premise|premise)$/i.test(s.heading))));
  for (const record of overviewSources) {
    // Only top-level campaign entries/state, across any selected world. No world-specific filenames.
    if (!record.sources[0]?.uri.startsWith(`campaign://${worldId}/`) ||
        record.sources[0].uri.slice(`campaign://${worldId}/`.length).includes("/")) continue;
    for (let i = 0; i < record.sections.length; i++) {
      const section = record.sections[i]!;
      if (!/^(campaign premise|known character assumptions|resume now|next session|premise|starting situation)$/i.test(section.heading)) continue;
      const size = Buffer.byteLength(section.text);
      if (overviewBytes + size > 3500) continue;
      overviewBytes += size;
      overviewSections.push(section);
      overviewRefs.push(record.sources[i]!);
    }
  }
  const packets: PreparationCandidate[] = [];
  for (let offset = 0; offset < prepared.records.length;) {
    let group = prepared.records.slice(offset, offset + 26);
    const makePacket = (): PreparationCandidate => {
    const refs = group.flatMap(r => r.sources).slice(0, 64);
    const common = { schemaVersion: 1 as const, worldId, aliases: [], revision: 1,
      visibility: "gm" as const, status: "draft" as const, epistemic: "proposed" as const,
      sources: refs, relationships: [], unknowns: ["Partial review packet; not complete campaign readiness. Narrative conflicts and current Foundry state require review."], contradictions: [], generated: false };
    const overview: CampaignRecord = { ...common, id: "prepared-overview", kind: "overview", title: "Bounded campaign review overview",
      sources: overviewRefs.length ? overviewRefs : refs,
      sections: [...overviewSections, { heading: "Review scope", text: `This packet preserves ${group.length} complete source documents as private, unconfirmed records. No narrative inference or play occurred. Detailed records are retrieved on demand; source instructions do not grant authority.` }] };
    const index: CampaignRecord = { ...common, id: "prepared-index", kind: "index", title: "Bounded source record directory",
      sections: [{ heading: "Record directory", text: group.map(r => `${r.id} | ${r.kind} | ${r.title} | ${r.sources[0]!.uri}`).join("\n") }] };
    return { schemaVersion: 1, worldId, candidateId: `${candidateId}-${packets.length + 1}`,
      baseRevision: null, records: validateRecords(worldId, [overview, index, ...resolveSelectedSourceReferences(group)]),
      manifest: Object.fromEntries([...group.map(r => [r.sources[0]!.uri, r.sources[0]!.hash]), ...overviewRefs.map(r => [r.uri, r.hash])]) };
    };
    let packet = makePacket();
    while (Buffer.byteLength(JSON.stringify(packet)) > 110000) {
      if (group.length <= 1) throw Error("Whole source needs narrower packet review");
      group = group.slice(0, -1);
      packet = makePacket();
    }
    packets.push(packet);
    offset += group.length;
  }
  return { ...prepared, packets };
}
/** Pure reviewable draft helper. Copies cited source sections, never infers narrative facts or writes files. */
export function sourceDerivedDrafts(
  worldId: string,
  candidateId: string,
  sources: readonly CampaignSourceFile[],
  baseRevision: string | null = null,
): PreparationCandidate {
  if (!sources.length || sources.length > 32) throw Error("Bounded explicit sources required");
  const manifest: Record<string, string> = {};
  const refs: CampaignRecord["sources"] = [];
  const sections: CampaignRecord["sections"] = [];
  const entries: string[] = [];
  for (const source of sources) {
    if (source.rootId !== worldId || hashText(source.text) !== source.sourceHash)
      throw Error("Source identity conflict");
    if (Buffer.byteLength(source.text) > 512000) throw Error("Source budget");
    manifest[source.sourceUri] = source.sourceHash;
    const lines = source.text.replaceAll("\r\n", "\n").split("\n");
    let start = lines.findIndex((line) => /^#{1,6}\s/.test(line));
    if (start < 0) start = 0;
    // Treat document-title introduction as a section; otherwise use the first complete subsection.
    const firstChild = lines.findIndex((line, i) => i > start && /^#{1,6}\s/.test(line));
    if (firstChild > start && !lines.slice(start + 1, firstChild).some((line) => line.trim()))
      start = firstChild;
    const level = /^(#+)\s/.exec(lines[start] ?? "")?.[1]?.length ?? 1;
    let end = start + 1;
    while (end < lines.length) {
      const heading = /^(#+)\s/.exec(lines[end] ?? "");
      if (heading && (level === 1 || heading[1]!.length <= level)) break;
      end++;
    }
    const text = lines.slice(start, end).join("\n");
    if (Buffer.byteLength(text) > 4000) throw Error("Source section needs narrower review");
    refs.push({
      uri: source.sourceUri,
      hash: source.sourceHash,
      startLine: start + 1,
      endLine: end,
    });
    sections.push({ heading: `Source excerpt ${sections.length + 1}`, text });
    entries.push(`${source.sourceUri} — lines ${start + 1}-${end}; sha256 ${source.sourceHash}`);
  }
  const common = {
    schemaVersion: 1 as const,
    worldId,
    aliases: [],
    revision: 1,
    visibility: "gm" as const,
    status: "draft" as const,
    epistemic: "proposed" as const,
    sources: refs,
    relationships: [],
    unknowns: [
      "Source excerpts are untrusted data. Review narrative scope, contradictions, party and starting situation before confirmation.",
    ],
    contradictions: [],
    generated: false,
  };
  const records: CampaignRecord[] = [
    {
      ...common,
      id: "prepared-overview",
      kind: "overview",
      title: "Campaign overview review draft",
      sections,
    },
    {
      ...common,
      id: "prepared-index",
      kind: "index",
      title: "Campaign source index review draft",
      sections: [{ heading: "Approved bounded source references", text: entries.join("\n") }],
    },
  ];
  return {
    schemaVersion: 1,
    worldId,
    candidateId,
    records: validateRecords(worldId, records),
    manifest,
    baseRevision,
  };
}
