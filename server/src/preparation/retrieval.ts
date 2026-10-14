import { validateRecords, type CampaignRecord } from "./records.js";
export interface RetrievalCaller {
  worldId: string;
  audience: "gm" | "player";
}
export interface RetrievalHit {
  id: string;
  title: string;
  heading: string;
  excerpt: string;
  revision: number;
  sources: CampaignRecord["sources"];
  visibility: CampaignRecord["visibility"];
  epistemic: CampaignRecord["epistemic"];
  generated: boolean;
  status: CampaignRecord["status"];
}
// Conservative lexical search: whole Unicode words plus English plural normalization.
// No substring, edit-distance or semantic inference; unsupported substantive words remain unknown.
const questionStopwords = new Set([
  "a",
  "an",
  "the",
  "what",
  "who",
  "where",
  "when",
  "why",
  "how",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "do",
  "does",
  "did",
  "can",
  "could",
  "would",
  "should",
  "will",
  "has",
  "have",
  "had",
  "of",
  "for",
  "to",
  "in",
  "on",
  "at",
  "by",
  "with",
  "and",
  "or",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "tell",
  "show",
  "please",
  "about",
]);
function lexicalWords(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}_-]+/gu) ?? []
  );
}
function conservativeWord(word: string): string {
  if (["motivation", "motivations", "motives"].includes(word)) return "motive";
  if (/^[a-z]+$/.test(word) && word.length > 4 && word.endsWith("s") && !/(?:ss|us|is)$/.test(word))
    return word.slice(0, -1);
  return word;
}
/** Disposable deterministic section index; no paid embedding or inference. Each instance is a version cache. */
export class CampaignRetrieval {
  private records: CampaignRecord[];
  constructor(
    worldId: string,
    records: CampaignRecord[],
    private readonly authorize: (caller: RetrievalCaller) => void,
  ) {
    this.records = validateRecords(worldId, records);
    this.worldId = worldId;
  }
  readonly worldId: string;
  private visible(caller: RetrievalCaller) {
    this.authorize(caller);
    if (caller.worldId !== this.worldId) throw Error("Campaign unavailable");
    return this.records.filter(
      (r) => r.status === "confirmed" && (caller.audience === "gm" || r.visibility === "player"),
    );
  }
  private hit(
    caller: RetrievalCaller,
    r: CampaignRecord,
    s: CampaignRecord["sections"][number],
  ): RetrievalHit {
    return {
      id: r.id,
      title: r.title,
      heading: s.heading,
      excerpt: s.text,
      revision: r.revision,
      sources: caller.audience === "gm" ? r.sources.slice(0, 5) : [],
      visibility: r.visibility,
      epistemic: r.epistemic,
      generated: r.generated,
      status: r.status,
    };
  }
  read(
    caller: RetrievalCaller,
    id: string,
    options: { offset?: number | undefined; maxCharacters?: number | undefined } = {},
  ) {
    if (id.length > 128) throw Error("Invalid query");
    const records = this.visible(caller),
      record = records.find((r) => r.id === id);
    if (!record) return null;
    const offset = options.offset ?? 0,
      budget = options.maxCharacters ?? 6000;
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 40 ||
      !Number.isInteger(budget) ||
      budget < 512 ||
      budget > 12000
    )
      throw Error("Invalid retrieval bounds");
    const sections: CampaignRecord["sections"] = [];
    let next = offset;
    for (const section of record.sections.slice(offset)) {
      if (
        Buffer.byteLength(
          JSON.stringify({
            id: record.id,
            title: record.title,
            revision: record.revision,
            epistemic: record.epistemic,
            generated: record.generated,
            status: record.status,
            visibility: record.visibility,
            sections: [...sections, section],
            continuation: 40,
            oversizedSection: false,
            trust: "untrusted-source-data",
          }),
        ) > budget
      )
        break;
      sections.push(section);
      next++;
    }
    this.authorize(caller);
    return {
      id: record.id,
      title: record.title,
      revision: record.revision,
      epistemic: record.epistemic,
      generated: record.generated,
      status: record.status,
      visibility: record.visibility,
      sections,
      continuation: next < record.sections.length ? next : null,
      oversizedSection: sections.length === 0 && next < record.sections.length,
      trust: "untrusted-source-data",
    };
  }
  search(
    caller: RetrievalCaller,
    query: string,
    options: {
      limit?: number | undefined;
      offset?: number | undefined;
      maxCharacters?: number | undefined;
    } = {},
  ) {
    if (!query.trim() || query.length > 200) throw Error("Invalid query");
    const limit = options.limit ?? 5,
      offset = options.offset ?? 0,
      budget = options.maxCharacters ?? 6000;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 10 ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 1000 ||
      !Number.isInteger(budget) ||
      budget < 512 ||
      budget > 12000
    )
      throw Error("Invalid retrieval bounds");
    const q = query.normalize("NFKC").toLowerCase().trim();
    const terms = [
      ...new Set(
        lexicalWords(q)
          .filter((word) => !questionStopwords.has(word))
          .map(conservativeWord),
      ),
    ].slice(0, 16);
    const matches = this.visible(caller)
      .flatMap((r) =>
        r.sections.map((s) => {
          const names = [r.id, r.title, ...r.aliases].map((name) =>
            name.normalize("NFKC").toLowerCase(),
          );
          const nameWords = new Set(names.flatMap(lexicalWords).map(conservativeWord));
          const bodyWords = new Set(lexicalWords(`${s.heading} ${s.text}`).map(conservativeWord));
          const allSupported =
            terms.length > 0 && terms.every((term) => nameWords.has(term) || bodyWords.has(term));
          const score = names.includes(q)
            ? 100
            : allSupported
              ? terms.reduce((n, term) => n + (nameWords.has(term) ? 10 : 1), 0)
              : 0;
          return { r, s, score };
        }),
      )
      .filter((m) => m.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.r.id.localeCompare(b.r.id) ||
          a.s.heading.localeCompare(b.s.heading),
      );
    const hits: RetrievalHit[] = [];
    let cursor = offset,
      oversizedSections = 0;
    for (const { r, s } of matches.slice(offset)) {
      if (hits.length >= limit) break;
      const hit = this.hit(caller, r, s);
      if (
        Buffer.byteLength(
          JSON.stringify({
            hits: [...hits, hit],
            continuation: 1000,
            characters: budget,
            bytes: budget,
            oversizedSections: 256,
            trust: "untrusted-source-data",
          }),
        ) > budget
      ) {
        if (hits.length) break;
        oversizedSections++;
        cursor++;
        continue;
      }
      hits.push(hit);
      cursor++;
    }
    this.authorize(caller);
    const result = {
      hits,
      continuation: cursor < matches.length ? cursor : null,
      characters: 0,
      bytes: 0,
      oversizedSections,
      trust: "untrusted-source-data",
    };
    result.characters = JSON.stringify(result).length;
    result.bytes = Buffer.byteLength(JSON.stringify(result));
    return result;
  }
  related(caller: RetrievalCaller, id: string) {
    const records = this.visible(caller),
      record = records.find((r) => r.id === id);
    const visibleIds = new Set(records.map((r) => r.id));
    this.authorize(caller);
    return record?.relationships.filter((l) => visibleIds.has(l.id)).slice(0, 16) ?? [];
  }
}
