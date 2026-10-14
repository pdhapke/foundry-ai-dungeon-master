import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import { hashText, stableJson } from "../context/hash.js";
import { bounded } from "./bounded-call.js";
import { WorldFiles, type WorldFileRequest } from "./world-files.js";
import type { SessionRequestAuthorization } from "./pause-request.js";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const mutation = z.object({ actionId: id, path: z.string().min(1).max(500), expectedRevision: digest.nullable(), encoding: z.enum(["utf8", "base64"]).optional(), content: z.string().max(24000).optional() }).strict();
export type WorldFileScope = { worldId: string; userId: string; threadId: string };
type Operation = "list" | "read" | "write" | "mkdir" | "delete" | "recover";
/** Browser and server review digests use locale-independent binary key ordering. */
export function worldReviewJson(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize) : item && typeof item === "object" ? Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, normalize(child)])) : item;
  return JSON.stringify(normalize(value));
}
type Entry = { kind: "world-file"; scope: WorldFileScope; actionId: string; request: WorldFileRequest; before: AiDmJsonValue; reviewDigest: string; requestDigest: string; status: "pending" | "dispatching" | "completed" | "rejected" | "cancelled" | "stale" | "uncertain"; receipt: AiDmJsonValue | null };
export const WORLD_FILE_SEMANTIC_TOOLS = {
  ai_dm_list_world_files: { operation: "list", purpose: "List bounded active world directory entries" },
  ai_dm_read_world_file: { operation: "read", purpose: "Read bounded active world file or metadata" },
  ai_dm_write_world_file: { operation: "write", purpose: "Write an active world file with expected revision" },
  ai_dm_make_world_directory: { operation: "mkdir", purpose: "Create an active world directory" },
  ai_dm_delete_world_file: { operation: "delete", purpose: "Propose exact human review of world file deletion" },
  ai_dm_recover_world_file: { operation: "recover", purpose: "Propose exact human review of interrupted world file recovery" },
} as const;
/** Trusted host configuration only: the model never supplies a filesystem root or approval. */
export class ChatKitWorldFileActions {
  private readonly files: WorldFiles;
  private readonly grants = new WeakMap<AiDmAuthenticatedIdentity, { request: string; signal: AbortSignal }>();
  constructor(worldsRoot: string, private readonly db: DatabaseSync, private readonly authorize: (identity: AiDmAuthenticatedIdentity, signal: AbortSignal) => Promise<void>, private readonly options: { assertPrivateStorage?: (worldId: string) => Promise<void>; timeoutMs?: number } = {}) {
    const check = async (identity: AiDmAuthenticatedIdentity) => { const grant = this.grants.get(identity); if (!grant) throw new Error("Trusted file call context required"); await this.check(identity, grant.signal); };
    const intent = async (identity: AiDmAuthenticatedIdentity, request: Readonly<WorldFileRequest>) => { await check(identity); if (this.grants.get(identity)?.request !== stableJson(request)) throw new Error("Exact authorized file request required"); };
    this.files = new WorldFiles(worldsRoot, db, { authorize: check, ...(options.assertPrivateStorage ? { assertPrivateStorage: options.assertPrivateStorage } : {}), authorizeWriteIntent: intent, authorizeDeleteIntent: intent }, 12000);
    db.exec("CREATE TABLE IF NOT EXISTS chatkit_world_file_actions(scope_key TEXT PRIMARY KEY,entry_json TEXT NOT NULL)");
  }
  private key(scope: WorldFileScope, actionId: string) { return stableJson([scope.worldId, scope.userId, scope.threadId, actionId]); }
  private load(scope: WorldFileScope, actionId: string): Entry | undefined { const row = this.db.prepare("SELECT entry_json FROM chatkit_world_file_actions WHERE scope_key=?").get(this.key(scope, actionId)); return row ? JSON.parse(String(row["entry_json"])) as Entry : undefined; }
  private view(entry: Entry, reviewComplete = false): AiDmJsonValue {
    const { content, ...summary } = entry.request;
    const request = reviewComplete ? entry.request : { ...summary, ...(content !== undefined ? { contentDigest: hashText(content), encodedContentBytes: Buffer.byteLength(content) } : {}) };
    return { ...entry, request: request as unknown as AiDmJsonValue, before: reviewComplete ? entry.before : { exactBrowserReviewRequired: entry.status === "pending" }, status: entry.status === "dispatching" ? "uncertain" : entry.status, requiresConfirmation: entry.status === "pending", reviewComplete, trust: "untrusted-source-data", narrationAllowed: false };
  }
  recent(scope: WorldFileScope): AiDmJsonValue[] { const prefix = stableJson([scope.worldId, scope.userId, scope.threadId]).slice(0, -1) + ","; return this.db.prepare("SELECT entry_json FROM chatkit_world_file_actions WHERE scope_key>=? AND scope_key<? ORDER BY rowid DESC LIMIT 12").all(prefix, prefix + "\uffff").map(row => JSON.parse(String(row["entry_json"])) as Entry).filter(entry => stableJson(entry.scope) === stableJson(scope)).map(entry => this.view(entry)); }
  private async check(identity: AiDmAuthenticatedIdentity, signal: AbortSignal) { signal.throwIfAborted(); await bounded(this.authorize(identity, signal), signal); signal.throwIfAborted(); }
  private async privatePersistence(identity: AiDmAuthenticatedIdentity, signal: AbortSignal) { await this.check(identity, signal); if (!this.options.assertPrivateStorage) throw new Error("Private world-file persistence is disabled until deployment privacy is verified"); await bounded(this.options.assertPrivateStorage(identity.worldId), signal); await this.check(identity, signal); }
  private async context(identity: AiDmAuthenticatedIdentity, scope: WorldFileScope, outer: AbortSignal) { if (!identity.isGm || identity.worldId !== scope.worldId || identity.userId !== scope.userId) throw new Error("Live GM world scope required"); id.parse(scope.threadId); const signal = AbortSignal.any([outer, AbortSignal.timeout(this.options.timeoutMs ?? 10000)]); const trusted = structuredClone(identity); this.grants.set(trusted, { request: "", signal }); await this.check(trusted, signal); return { identity: trusted, signal }; }
  async request(identity: AiDmAuthenticatedIdentity, scope: WorldFileScope, operation: Operation, raw: unknown, authority: SessionRequestAuthorization | undefined, outerSignal: AbortSignal): Promise<AiDmJsonValue> {
    if (Buffer.byteLength(JSON.stringify(raw)) > 32000) throw new Error("File argument budget exceeded");
    const ctx = await this.context(identity, scope, outerSignal);
    try {
      if (operation === "list") { const input = z.object({ path: z.string().max(500).optional(), after: z.string().max(500).optional(), limit: z.number().int().min(1).max(20).optional() }).strict().parse(raw); return { ...await this.files.list(ctx.identity, input.path, input.after, input.limit ?? 20), trust: "untrusted-source-data", narrationAllowed: false }; }
      if (operation === "read") { const input = z.object({ path: z.string().min(1).max(500), encoding: z.enum(["utf8", "base64", "metadata"]).optional() }).strict().parse(raw); return { ...await this.files.read(ctx.identity, input.path, input.encoding), trust: "untrusted-source-data", narrationAllowed: false }; }
      if (!authority?.worldControl?.manualRequest || !digest.safeParse(authority.worldControl.requestDigest).success) throw new Error("Current ordinary GM request required");
      const input = mutation.parse(raw);
      if (/^data\/campaign(?:\/|$)/i.test(input.path)) throw new Error("Campaign canon requires campaign proposal controls");
      if (operation === "write" ? input.content === undefined || input.encoding === undefined : input.content !== undefined || input.encoding !== undefined) throw new Error("File content/operation mismatch");
      const request: WorldFileRequest = { requestId: hashText(this.key(scope, input.actionId)), operation, path: input.path, expectedRevision: input.expectedRevision, ...(input.encoding ? { encoding: input.encoding } : {}), ...(input.content !== undefined ? { content: input.content } : {}) };
      const prior = this.load(scope, input.actionId); if (prior) { if (stableJson(prior.request) !== stableJson(request) || prior.requestDigest !== authority.worldControl.requestDigest) throw new Error("File action ID conflict"); return this.view(prior); }
      await this.privatePersistence(ctx.identity, ctx.signal);
      let before: AiDmJsonValue = null;
      if (operation === "delete") before = await this.files.read(ctx.identity, input.path, "base64");
      if (operation === "recover") { const rows = this.db.prepare("SELECT journal_json FROM chatkit_world_files WHERE world=? AND owner=? AND state='pending'").all(scope.worldId, scope.userId); before = rows.map(row => JSON.parse(String(row["journal_json"])) as AiDmJsonValue); if (Buffer.byteLength(JSON.stringify(before)) > 96000) throw new Error("Recovery browser review exceeds budget"); }
      const entry: Entry = { kind: "world-file", scope, actionId: input.actionId, request, before, requestDigest: authority.worldControl.requestDigest, reviewDigest: hashText(worldReviewJson({ scope, input: request, before, selectedTarget: request.path })), status: operation === "delete" || operation === "recover" ? "pending" : "dispatching", receipt: null };
      await this.privatePersistence(ctx.identity, ctx.signal); this.db.prepare("INSERT INTO chatkit_world_file_actions VALUES (?,?)").run(this.key(scope, entry.actionId), JSON.stringify(entry));
      return entry.status === "pending" ? this.view(entry) : await this.execute(ctx.identity, entry, ctx.signal);
    } finally { this.grants.delete(ctx.identity); }
  }
  private async execute(identity: AiDmAuthenticatedIdentity, entry: Entry, signal: AbortSignal): Promise<AiDmJsonValue> {
    let dispatched = false;
    try { await this.check(identity, signal); if (entry.request.operation === "recover") { const rows = this.db.prepare("SELECT journal_json FROM chatkit_world_files WHERE world=? AND owner=? AND state='pending'").all(entry.scope.worldId, entry.scope.userId); if (stableJson(rows.map(row => JSON.parse(String(row["journal_json"])) as AiDmJsonValue)) !== stableJson(entry.before)) throw new Error("Stale recovery review"); } this.grants.set(identity, { request: stableJson(entry.request), signal }); const intent = await bounded(this.files.issueIntent(identity, entry.request), signal); await this.check(identity, signal); dispatched = true; const receipt = await bounded(this.files.apply(identity, intent), signal); await this.check(identity, signal); entry.status = "completed"; entry.receipt = receipt as unknown as AiDmJsonValue;
    } catch { entry.status = dispatched ? "uncertain" : signal.aborted ? "cancelled" : "stale"; }
    this.db.prepare("UPDATE chatkit_world_file_actions SET entry_json=? WHERE scope_key=?").run(JSON.stringify(entry), this.key(entry.scope, entry.actionId)); return this.view(entry);
  }
  async browser(identity: AiDmAuthenticatedIdentity, raw: unknown, outerSignal: AbortSignal): Promise<AiDmJsonValue> {
    const input = z.object({ kind: z.literal("world-file"), threadId: id, actionId: id.optional(), reviewDigest: digest.optional(), decision: z.enum(["approve", "reject", "cancel"]).optional() }).strict().parse(raw);
    const scope = { worldId: identity.worldId, userId: identity.userId, threadId: input.threadId }; const ctx = await this.context(identity, scope, outerSignal);
    try { if (!input.actionId) { if (input.decision) throw new Error("Action required"); return this.recent(scope); } const entry = this.load(scope, input.actionId); if (!entry) throw new Error("File proposal unavailable"); if (!input.decision || entry.status !== "pending") return this.view(entry, true); if (input.reviewDigest !== entry.reviewDigest) throw new Error("Exact file review digest required"); await this.privatePersistence(ctx.identity, ctx.signal); const original = JSON.stringify(entry); entry.status = input.decision === "approve" ? "dispatching" : input.decision === "reject" ? "rejected" : "cancelled"; const claim = this.db.prepare("UPDATE chatkit_world_file_actions SET entry_json=? WHERE scope_key=? AND entry_json=?").run(JSON.stringify(entry), this.key(scope, entry.actionId), original); if (!claim.changes) return this.view(this.load(scope, entry.actionId)!, true); return input.decision === "approve" ? await this.execute(ctx.identity, entry, ctx.signal) : this.view(entry, true);
    } finally { this.grants.delete(ctx.identity); }
  }
}



