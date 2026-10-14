import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatKitWorldFileActions } from "./world-file-actions.js";
import { hashText } from "../context/hash.js";
const gm = { clientId: "client", worldId: "w", userId: "gm", lane: "gm" as const, isGm: true };
const scope = { worldId: "w", userId: "gm", threadId: "thread" };
const authority = { worldControl: { manualRequest: true as const, requestDigest: "a".repeat(64) } };
const signal = () => new AbortController().signal;
function fixture(privateGate = true) {
  const root = mkdtempSync(join(tmpdir(), "file-actions-")); mkdirSync(join(root, "w")); const db = new DatabaseSync(join(root, "actions.sqlite"));
  let revoked = false, interrupt = false;
  const authorize = () => revoked || interrupt && existsSync(join(root, "w", "note.txt")) ? Promise.reject(new Error("revoked")) : Promise.resolve();
  const options = privateGate ? { assertPrivateStorage: async () => {} } : {};
  const create = () => new ChatKitWorldFileActions(root, db, authorize, options);
  return { root, db, create, service: create(), revoke: () => { revoked = true; }, interrupt: () => { interrupt = true; }, restore: () => { revoked = interrupt = false; }, close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}
const write = { actionId: "write", path: "note.txt", expectedRevision: null, encoding: "utf8", content: "hello" };
const object = (v: unknown) => v as Record<string, unknown>;
void test("privacy callback ignoring cancellation cannot hang execution or later write", async () => {
  const f = fixture(); let release: () => void = () => {}; let checks = 0;
  const hanging = new ChatKitWorldFileActions(f.root, f.db, () => Promise.resolve(), { timeoutMs: 50, assertPrivateStorage: () => ++checks === 3 ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve() });
  try { const result = object(await hanging.request(gm, scope, "write", write, authority, signal())); assert.equal(result.status, "cancelled"); assert.equal(existsSync(join(f.root, "w", "note.txt")), false); release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(existsSync(join(f.root, "w", "note.txt")), false); } finally { f.close(); }
});
void test("denied privacy records no proposed bytes and absent gate cannot decide an existing proposal", async () => {
  const f = fixture(); try {
    const denied = new ChatKitWorldFileActions(f.root, f.db, () => Promise.resolve(), { assertPrivateStorage: () => Promise.reject(new Error("privacy denied")) });
    await assert.rejects(denied.request(gm, scope, "write", { ...write, content: "PRIVATE_PROPOSAL" }, authority, signal()), /privacy denied/);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM chatkit_world_file_actions").get()?.["count"], 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM chatkit_world_files").get()?.["count"], 0);
    writeFileSync(join(f.root, "w", "note.txt"), "hello"); const proposal = object(await f.service.request(gm, scope, "delete", { actionId: "delete", path: "note.txt", expectedRevision: hashText("hello") }, authority, signal()));
    const absent = new ChatKitWorldFileActions(f.root, f.db, () => Promise.resolve());
    await assert.rejects(absent.browser(gm, { kind: "world-file", threadId: "thread", actionId: "delete", reviewDigest: proposal.reviewDigest, decision: "approve" }, signal()), /privacy is verified/);
    assert.equal(existsSync(join(f.root, "w", "note.txt")), true); assert.equal(object((await f.service.browser(gm, { kind: "world-file", threadId: "thread", actionId: "delete" }, signal()))).status, "pending");
  } finally { f.close(); }
});
void test("maximum 12k overwrite restart recovery keeps model summaries small and browser review exact", async () => {
  const root = mkdtempSync(join(tmpdir(), "max-file-review-")); mkdirSync(join(root, "w")); const dbPath = join(root, "actions.sqlite"); let db = new DatabaseSync(dbPath); const old = "a".repeat(12000), next = "b".repeat(12000); writeFileSync(join(root, "w", "note.txt"), old); let interrupt = true;
  const authorize = () => interrupt && readFileSync(join(root, "w", "note.txt"), "utf8") === next ? Promise.reject(new Error("interrupted")) : Promise.resolve();
  const create = () => new ChatKitWorldFileActions(root, db, authorize, { assertPrivateStorage: async () => {} });
  try {
    const result = await create().request(gm, scope, "write", { ...write, expectedRevision: hashText(old), content: next }, authority, signal()); assert.equal(object(result).status, "uncertain"); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 24000);
    db.close(); db = new DatabaseSync(dbPath); interrupt = false;
    const proposal = await create().request(gm, scope, "recover", { actionId: "recover", path: "note.txt", expectedRevision: hashText(next) }, authority, signal()); assert.ok(Buffer.byteLength(JSON.stringify(proposal)) < 24000); assert.equal(object(proposal).status, "pending");
    const review = await create().browser(gm, { kind: "world-file", threadId: "thread", actionId: "recover" }, signal()); assert.ok(Buffer.byteLength(JSON.stringify(review)) < 96000);
    const ui: unknown = await import(new URL("../../../module/src/ai-dungeon-master/world-review.ts", import.meta.url).href); await (ui as { validateWorldReview(value: unknown, expectedScope: typeof scope): Promise<unknown> }).validateWorldReview(review, scope);
    const restored = await create().browser(gm, { kind: "world-file", threadId: "thread", actionId: "recover", decision: "approve", reviewDigest: object(review).reviewDigest }, signal()); assert.equal(object(restored).status, "completed"); assert.equal(readFileSync(join(root, "w", "note.txt"), "utf8"), old);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
void test("exact reviewed deletion executes once and replay returns its receipt", async () => { const f = fixture(); try { writeFileSync(join(f.root, "w", "note.txt"), "hello"); const proposal = object(await f.service.request(gm, scope, "delete", { actionId: "delete", path: "note.txt", expectedRevision: hashText("hello") }, authority, signal())); const review = { kind: "world-file", threadId: "thread", actionId: "delete", reviewDigest: proposal.reviewDigest, decision: "approve" }; assert.equal(object(await f.create().browser(gm, review, signal())).status, "completed"); assert.equal(existsSync(join(f.root, "w", "note.txt")), false); writeFileSync(join(f.root, "w", "note.txt"), "external"); assert.equal(object(await f.create().browser(gm, review, signal())).status, "completed"); assert.equal(readFileSync(join(f.root, "w", "note.txt"), "utf8"), "external"); } finally { f.close(); } });
void test("routine write is durable, scoped and replay does not write again", async () => { const f = fixture(); try { const first = object(await f.service.request(gm, scope, "write", write, authority, signal())); assert.equal(first.status, "completed"); assert.equal(readFileSync(join(f.root, "w", "note.txt"), "utf8"), "hello"); writeFileSync(join(f.root, "w", "note.txt"), "external"); const second = object(await f.create().request(gm, scope, "write", write, authority, signal())); assert.equal(second.status, "completed"); assert.equal(readFileSync(join(f.root, "w", "note.txt"), "utf8"), "external"); await assert.rejects(f.service.request(gm, scope, "write", { ...write, content: "different" }, authority, signal()), /conflict/); } finally { f.close(); } });
void test("privacy, forged approval, campaign canon and cancellation fail closed", async () => { const f = fixture(false); try { await assert.rejects(f.service.request(gm, scope, "write", write, authority, signal()), /privacy is verified/); assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM chatkit_world_file_actions").get()?.["count"], 0); assert.equal(existsSync(join(f.root, "w", "note.txt")), false); await assert.rejects(f.service.request(gm, scope, "write", { ...write, approved: true }, authority, signal())); await assert.rejects(f.service.request(gm, scope, "write", { ...write, path: "data/campaign/canon.json" }, authority, signal()), /canon/); await assert.rejects(f.service.request(gm, scope, "write", write, undefined, signal()), /ordinary/); const c = new AbortController(); c.abort(); await assert.rejects(f.service.request(gm, scope, "write", write, authority, c.signal)); } finally { f.close(); } });
void test("exact deletion review persists across restart, rejects stale contents and scope substitution", async () => { const f = fixture(); try { writeFileSync(join(f.root, "w", "note.txt"), "hello"); const raw = { actionId: "delete", path: "note.txt", expectedRevision: hashText("hello") }; const proposal = object(await f.service.request(gm, scope, "delete", raw, authority, signal())); assert.equal(proposal.status, "pending"); const browser = { kind: "world-file", threadId: "thread", actionId: "delete", reviewDigest: proposal.reviewDigest, decision: "approve" }; await assert.rejects(f.service.browser(gm, { ...browser, reviewDigest: "b".repeat(64) }, signal()), /digest/); await assert.rejects(f.service.browser(gm, { ...browser, threadId: "other" }, signal()), /unavailable/); writeFileSync(join(f.root, "w", "note.txt"), "new"); const result = object(await f.create().browser(gm, browser, signal())); assert.equal(result.status, "uncertain"); assert.equal(readFileSync(join(f.root, "w", "note.txt"), "utf8"), "new"); } finally { f.close(); } });
void test("delete requires browser review and cancellation and revocation leave file intact", async () => { const f = fixture(); try { writeFileSync(join(f.root, "w", "note.txt"), "hello"); const proposal = object(await f.service.request(gm, scope, "delete", { actionId: "delete", path: "note.txt", expectedRevision: hashText("hello") }, authority, signal())); f.revoke(); await assert.rejects(f.service.browser(gm, { kind: "world-file", threadId: "thread", actionId: "delete" }, signal()), /revoked/); f.restore(); const cancelled = object(await f.service.browser(gm, { kind: "world-file", threadId: "thread", actionId: "delete", decision: "cancel", reviewDigest: proposal.reviewDigest }, signal())); assert.equal(cancelled.status, "cancelled"); assert.equal(existsSync(join(f.root, "w", "note.txt")), true); const again = object(await f.service.browser(gm, { kind: "world-file", threadId: "thread", actionId: "delete", decision: "approve", reviewDigest: proposal.reviewDigest }, signal())); assert.equal(again.status, "cancelled"); } finally { f.close(); } });
void test("interrupted write is uncertain, never blindly replayed, and exact reviewed recovery completes", async () => { const f = fixture(); try { f.interrupt(); const result = object(await f.service.request(gm, scope, "write", write, authority, signal())); assert.equal(result.status, "uncertain"); f.restore(); assert.equal(object(await f.create().request(gm, scope, "write", write, authority, signal())).status, "uncertain"); const proposal = object(await f.create().request(gm, scope, "recover", { actionId: "recover", path: "note.txt", expectedRevision: hashText("hello") }, authority, signal())); assert.equal(proposal.status, "pending"); const result2 = object(await f.create().browser(gm, { kind: "world-file", threadId: "thread", actionId: "recover", reviewDigest: proposal.reviewDigest, decision: "approve" }, signal())); assert.equal(result2.status, "completed"); assert.equal(existsSync(join(f.root, "w", "note.txt")), false); } finally { f.close(); } });



