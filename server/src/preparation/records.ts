import { z } from "zod";
import { hashText } from "../context/hash.js";
import type {
  CampaignStorage,
  CampaignFileEdit,
  CampaignFile,
} from "../context/campaign-storage.js";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const sourceReferenceSchema = z
  .object({
    uri: z.string().min(1).max(400),
    hash: digest,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .strict()
  .refine((s) => s.endLine >= s.startLine);
export const campaignRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: identifier,
    worldId: identifier,
    kind: z.enum([
      "overview",
      "index",
      "npc",
      "place",
      "faction",
      "quest",
      "encounter",
      "lore",
      "event",
    ]),
    title: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\r\n]+$/),
    aliases: z.array(z.string().min(1).max(200)).max(32),
    revision: z.number().int().positive(),
    visibility: z.enum(["gm", "player"]),
    status: z.enum(["draft", "confirmed"]),
    epistemic: z.enum(["established", "rumor", "belief", "proposed", "unknown"]),
    sources: z.array(sourceReferenceSchema).max(64),
    relationships: z
      .array(z.object({ id: identifier, relation: z.string().min(1).max(80) }).strict())
      .max(64),
    sections: z
      .array(
        z
          .object({
            heading: z
              .string()
              .min(1)
              .max(200)
              .regex(/^[^\r\n]+$/),
            text: z.string().max(16000),
          })
          .strict(),
      )
      .min(1)
      .max(40),
    unknowns: z.array(z.string().max(500)).max(32),
    contradictions: z.array(z.string().max(500)).max(32),
    eventOrder: z.number().int().optional(),
    inWorldDate: z.string().max(100).optional(),
    generated: z.boolean(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (!r.generated && r.sources.length === 0)
      ctx.addIssue({ code: "custom", message: "Source-derived records require provenance" });
    if (r.generated && r.status === "confirmed" && r.epistemic === "proposed")
      ctx.addIssue({ code: "custom", message: "Proposed content cannot be confirmed" });
  });
export type CampaignRecord = z.infer<typeof campaignRecordSchema>;
export interface PreparationCandidate {
  schemaVersion: 1;
  worldId: string;
  candidateId: string;
  records: CampaignRecord[];
  manifest: Record<string, string>;
  baseRevision: string | null;
}
export function validateRecords(worldId: string, input: unknown[]): CampaignRecord[] {
  identifier.parse(worldId);
  if (input.length > 256) throw Error("Record budget exceeded");
  const records = input.map((r) => campaignRecordSchema.parse(r));
  const ids = new Set<string>();
  for (const r of records) {
    if (r.worldId !== worldId || ids.has(r.id.toLowerCase()))
      throw Error("World or duplicate record conflict");
    ids.add(r.id.toLowerCase());
  }
  for (const r of records)
    for (const link of r.relationships)
      if (!ids.has(link.id.toLowerCase())) throw Error("Unresolved relationship");
  return records;
}
export function renderRecord(record: CampaignRecord): string {
  const r = campaignRecordSchema.parse(record);
  const { sections, ...metadata } = r;
  return `---\nvisibility: gm\ncanon_status: draft\n---\n<!-- preparation-record-v1 ${JSON.stringify(metadata)} -->\n# ${r.title}\n\n${sections.map((s, i) => `<!-- preparation-section-v1 ${i} -->\n## ${s.heading}\n\n${s.text}`).join("\n\n")}\n`;
}
export function parseRecord(text: string): CampaignRecord {
  const m =
    /^---\nvisibility: gm\ncanon_status: draft\n---\n<!-- preparation-record-v1 (.*) -->\n# ([^\n]+)\n\n/.exec(
      text,
    );
  if (!m?.[1]) throw Error("Invalid record envelope");
  const metadata = JSON.parse(m[1]) as Record<string, unknown>;
  if (metadata["title"] !== m[2]) throw Error("Record title conflict");
  const body = text.slice(m[0].length);
  const matches = [...body.matchAll(/^<!-- preparation-section-v1 (\d+) -->\n## ([^\n]+)\n\n/gm)];
  if (matches.some((m, i) => Number(m[1]) !== i)) throw Error("Invalid record section markers");
  const sections = matches.map((match, i) => {
    const framed=body.slice(match.index!+match[0].length,matches[i+1]?.index??body.length);
    const suffix=matches[i+1]?'\n\n':'\n';
    if(!framed.endsWith(suffix))throw Error('Invalid record section framing');
    return {heading:match[2]!,text:framed.slice(0,-suffix.length)};
  });
  return campaignRecordSchema.parse({ ...metadata, sections });
}
function versionRecordPath(candidateId: string, recordId: string) {
  return `preparation/versions/${candidateId}/${hashText(recordId)}.md`;
}
const activePath = "preparation/active.md";
function snapshot(candidate: PreparationCandidate): string {
  const { records, ...metadata } = candidate;
  return `---\nvisibility: gm\ncanon_status: draft\n---\n<!-- preparation-version-v2 -->\n${JSON.stringify({ ...metadata, recordManifest: records.map(record=>({id:record.id,hash:hashText(renderRecord(record))})) })}\n`;
}
function decode(text: string, load?: (worldId:string,candidateId:string,id:string)=>string): PreparationCandidate {
  const base = "---\nvisibility: gm\ncanon_status: draft\n---\n";
  const v2 = text.startsWith(base + "<!-- preparation-version-v2 -->\n");
  const prefix = base + `<!-- preparation-version-v${v2?2:1} -->\n`;
  if (!text.startsWith(prefix)) throw Error("Invalid preparation snapshot");
  const parsed = JSON.parse(text.slice(prefix.length)) as PreparationCandidate & {recordManifest?:{id:string;hash:string}[]};
  const c = { ...parsed };
  identifier.parse(c.worldId);
  z.string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .parse(c.candidateId);
  if (c.schemaVersion !== 1) throw Error("Invalid snapshot version");
  digest.nullable().parse(c.baseRevision);
  if (Object.keys(c.manifest).length > 512) throw Error("Manifest budget");
  if(v2) {
    const entries=z.array(z.object({id:identifier,hash:digest}).strict()).max(256).parse(c.recordManifest);
    if(!load)throw Error('Record loader required');
    c.records=entries.map(entry=>{const text=load(c.worldId,c.candidateId,entry.id);if(hashText(text)!==entry.hash)throw Error('Editable record revision conflict');return parseRecord(text);});
    delete c.recordManifest;
  }
  c.records = validateRecords(c.worldId, c.records);
  for (const [uri, hash] of Object.entries(c.manifest)) {
    if (uri.length > 400) throw Error("Manifest budget");
    digest.parse(hash);
  }
  return c;
}
/** Uses existing authenticated, private, journaled CAS storage. Legacy source records are preserved. */
export class PreparationRecordStore {
  constructor(
    private readonly storage: CampaignStorage,
    private readonly authorizeReview: (worldId: string, candidateId: string) => void,
    private readonly currentSourceHash: (worldId: string, uri: string) => string | null,
  ) {}
  private decode(text:string) {
    return decode(text,(worldId,candidateId,id)=>{
      const file=this.storage.read(worldId,versionRecordPath(candidateId,id));
      if(!file)throw Error('Editable record revision conflict');return file.text;
    });
  }
  private companion(candidate: PreparationCandidate, kind: "overview" | "index"): string {
    const record = candidate.records.find((r) => r.kind === kind);
    if (!record || record.status !== "confirmed")
      throw Error("Confirmed overview and index records required for publication");
    return `---\nschema_version: 1\nid: ${record.id}\nrevision: ${candidate.candidateId}-${record.revision}\nvisibility: gm\ncanon_status: canon\n---\n# ${record.title}\n\n${record.sections.map((s) => `## ${s.heading}\n\n${s.text}`).join("\n\n")}\n`;
  }
  assertCompanionsCurrent(worldId:string,candidate:PreparationCandidate):void {
    for(const kind of ['overview','index'] as const)if(this.storage.read(worldId,`${kind}.md`)?.text!==this.companion(candidate,kind))throw Error('Manual companion edit conflict');
  }
  activeRevision(worldId:string):string|null { return this.readOptional(worldId,activePath)?.revision??null; }
  fingerprint(worldId:string,candidate:PreparationCandidate):string {
    if(candidate.worldId!==worldId)throw Error('World conflict');
    return this.storage.fingerprint(worldId,[activePath,'overview.md','index.md',...candidate.records.map(record=>versionRecordPath(candidate.candidateId,record.id))]);
  }
  private readOptional(worldId: string, path: string): CampaignFile | null {
    try {
      return this.storage.read(worldId, path);
    } catch (error) {
      if (error instanceof Error && error.message === "Campaign path does not exist.") return null;
      throw error;
    }
  }
  active(worldId: string): { candidate: PreparationCandidate; revision: string } | null {
    const f = this.readOptional(worldId, activePath);
    if (!f) return null;
    const c = this.decode(f.text);
    if (c.worldId !== worldId) throw Error("World conflict");
    for (const record of c.records) {
      const file = this.storage.read(worldId, versionRecordPath(c.candidateId, record.id));
      if (!file || file.text !== renderRecord(record))
        throw Error("Editable record revision conflict");
      parseRecord(file.text);
    }
    return { candidate: c, revision: f.revision };
  }
  candidate(worldId: string, candidateId: string): PreparationCandidate {
    identifier.parse(worldId); identifier.parse(candidateId);
    const file = this.storage.read(worldId, `preparation/candidates/${candidateId}.md`);
    if (!file) throw Error("Candidate unavailable");
    const c = this.decode(file.text);
    if (c.worldId !== worldId || c.candidateId !== candidateId) throw Error("Candidate conflict");
    for (const record of c.records) {
      const saved = this.storage.read(worldId, versionRecordPath(candidateId, record.id));
      if (!saved || saved.text !== renderRecord(record)) throw Error("Editable record revision conflict");
    }
    return c;
  }
  publicationReceipt(worldId: string, candidateId: string) {
    identifier.parse(worldId); identifier.parse(candidateId);
    return this.storage.receipt(worldId, `publish-${hashText(candidateId)}`);
  }
  stage(candidate: PreparationCandidate) {
    identifier.parse(candidate.candidateId);
    identifier.parse(candidate.worldId);
    if (Object.keys(candidate.manifest).length > 512) throw Error("Manifest budget");
    // Validate against the legacy inline decoder before writing the referenced v2 envelope.
    const c = decode(`---\nvisibility: gm\ncanon_status: draft\n---\n<!-- preparation-version-v1 -->\n${JSON.stringify(candidate)}\n`);
    for (const record of c.records) parseRecord(renderRecord(record));
    for (const record of c.records)
      for (const source of record.sources) {
        if (
          c.manifest[source.uri] !== source.hash ||
          this.currentSourceHash(c.worldId, source.uri) !== source.hash
        )
          throw Error("Record provenance conflict");
      }
    const edits=c.records.map(record=>({path:versionRecordPath(c.candidateId,record.id),expectedRevision:null,text:renderRecord(record)}));
    if(edits.some(edit=>Buffer.byteLength(edit.text)>120000)||Buffer.byteLength(snapshot(c))>120000||edits.reduce((n,e)=>n+Buffer.byteLength(e.text),0)>8000000)throw Error('Candidate storage budget');
    // Persist immutable record batches first. Interrupted staging resumes by exact receipts;
    // the candidate is discoverable only after every referenced record is durable.
    let batch:CampaignFileEdit[]=[],bytes=0,batchId=0;
    const flush=()=>{if(!batch.length)return;this.storage.commit(c.worldId,batch,{transactionId:`stage-${hashText(c.candidateId)}-${batchId++}`,batchDigest:hashText(JSON.stringify(batch))});batch=[];bytes=0;};
    for(const edit of edits){if(bytes+Buffer.byteLength(edit.text)>360000||batch.length>=24)flush();batch.push(edit);bytes+=Buffer.byteLength(edit.text);}flush();
    const receipt=this.storage.commit(c.worldId,[{path:`preparation/candidates/${c.candidateId}.md`,expectedRevision:null,text:snapshot(c)}],{transactionId:`stage-${hashText(c.candidateId)}`,batchDigest:hashText(snapshot(c))});
    this.candidate(c.worldId,c.candidateId);return receipt;
  }
  publish(worldId: string, candidateId: string) {
    identifier.parse(candidateId);
    const file = this.storage.read(worldId, `preparation/candidates/${candidateId}.md`);
    if (!file) throw Error("Candidate unavailable");
    const c = this.decode(file.text);
    if (c.worldId !== worldId || c.candidateId !== candidateId) throw Error("Candidate conflict");
    for (const record of c.records) {
      const file = this.storage.read(worldId, versionRecordPath(c.candidateId, record.id));
      if (!file || file.text !== renderRecord(record))
        throw Error("Editable record revision conflict");
    }
    this.authorizeReview(worldId, candidateId);
    const before = this.readOptional(worldId, activePath);
    const priorReceipt = this.storage.receipt(worldId, `publish-${hashText(candidateId)}`);
    if (priorReceipt) {
      if (!before || JSON.stringify(this.decode(before.text)) !== JSON.stringify(c)) throw Error("Published candidate is no longer active");
      for (const kind of ["overview", "index"] as const)
        if (this.readOptional(worldId, `${kind}.md`)?.text !== this.companion(c, kind))
          throw Error("Manual companion edit conflict");
      return priorReceipt;
    }
    for (const [uri, hash] of Object.entries(c.manifest))
      if (this.currentSourceHash(worldId, uri) !== hash) throw Error("Source revision conflict");
    if ((before?.revision ?? null) !== c.baseRevision) throw Error("Preparation revision conflict");
    const edits: CampaignFileEdit[] = [
      { path: activePath, expectedRevision: c.baseRevision, text: snapshot(c) },
    ];
    for (const kind of ["overview", "index"] as const) {
      const path = `${kind}.md`;
      const current = this.readOptional(worldId, path);
      const expected = c.manifest[`campaign://${worldId}/${path}`] ?? null;
      if ((current?.revision ?? null) !== expected) throw Error("Companion revision conflict");
      edits.push({ path, expectedRevision: expected, text: this.companion(c, kind) });
      if (current)
        edits.push({
          path: `preparation/history/${candidateId}-before-${kind}.md`,
          expectedRevision: null,
          text: current.text,
        });
    }
    if (before) {
      const historyPath = `preparation/history/${before.revision}.md`;
      const history = this.readOptional(worldId, historyPath);
      if (history && history.text !== before.text) throw Error("History conflict");
      if (!history) edits.push({ path: historyPath, expectedRevision: null, text: before.text });
    }
    return this.storage.commit(worldId, edits, {
      transactionId: `publish-${hashText(candidateId)}`,
      batchDigest: hashText(snapshot(c)),
    });
  }
  rollback(worldId: string, revision: string, expectedActiveRevision: string) {
    digest.parse(revision);
    this.authorizeReview(worldId, `rollback-${revision}`);
    const old = this.storage.read(worldId, `preparation/history/${revision}.md`);
    if (!old || old.revision !== revision) throw Error("Rollback unavailable");
    const c = this.decode(old.text);
    if (c.worldId !== worldId) throw Error("World conflict");
    for (const record of c.records) {
      const file = this.storage.read(worldId, versionRecordPath(c.candidateId, record.id));
      if (!file || file.text !== renderRecord(record))
        throw Error("Editable record revision conflict");
    }
    const active = this.readOptional(worldId, activePath);
    if (!active || active.revision !== expectedActiveRevision)
      throw Error("Rollback revision conflict");
    const activeCandidate = this.decode(active.text);
    const edits: CampaignFileEdit[] = [
      { path: activePath, expectedRevision: expectedActiveRevision, text: old.text },
    ];
    for (const kind of ["overview", "index"] as const) {
      const path = `${kind}.md`;
      const current = this.readOptional(worldId, path);
      if (current?.text !== this.companion(activeCandidate, kind))
        throw Error("Manual companion edit conflict");
      edits.push({ path, expectedRevision: current.revision, text: this.companion(c, kind) });
    }
    return this.storage.commit(worldId, edits);
  }
}
