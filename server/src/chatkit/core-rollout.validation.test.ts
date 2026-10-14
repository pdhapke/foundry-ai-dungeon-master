import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import type { FoundryLocalApiMcpClient } from "../tool-catalog/index.js";
import { ChatKitCoreActions } from "./core-actions.js";
import { ChatKitTurns } from "./turns.js";

const gm: AiDmAuthenticatedIdentity = { worldId: "w", userId: "gm", clientId: "c", lane: "gm", isGm: true };
const scope = { worldId: "w", userId: "gm", threadId: "thread" };
const authority = { worldControl: { manualRequest: true as const, requestDigest: "a".repeat(64) } };
const args = { actionId: "one", action: { kind: "door.state", sceneId: "s", targetId: "door", value: 1 } };
const record = (value: AiDmJsonValue) => value as Record<string, AiDmJsonValue>;
function fixture(transform: (result: Record<string, AiDmJsonValue>) => AiDmJsonValue = r => r) {
  const db = new DatabaseSync(":memory:");
  let calls = 0, revoked = false;
  const client: FoundryLocalApiMcpClient = {
    listTools() { assert.fail("core must not load discovery schemas"); },
    callTool(call) {
      calls++;
      const a = record(call.arguments);
      return Promise.resolve(transform({ outcome: "confirmed", schemaVersion: "core-actions-v1", worldId: "w", correlationId: a["correlationId"]!, action: a["action"]!, state: { ds: 1 }, mutated: true }));
    },
  };
  const authorize = async () => { if (revoked) throw new Error("live revocation"); };
  const service = new ChatKitCoreActions(client, db, authorize);
  return { db, client, service, authorize, revoke: () => { revoked = true; }, get calls() { return calls; } };
}
void test("independent core validates GM scope/manual authority and cancellation before any MCP call", async () => {
  const f = fixture();
  try {
    const signal = new AbortController().signal;
    await assert.rejects(f.service.request({ ...gm, isGm: false }, scope, args, authority, signal));
    await assert.rejects(f.service.request(gm, { ...scope, worldId: "other" }, args, authority, signal));
    await assert.rejects(f.service.request(gm, scope, args, undefined, signal));
    await assert.rejects(f.service.request(gm, scope, { ...args, action: { kind: "chat.post", text: "injected" } }, authority, signal));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.service.request(gm, scope, args, authority, controller.signal));
    assert.equal(f.calls, 0);
  } finally { f.db.close(); }
});
void test("independent core protocol/world/action drift stores uncertain receipt durably without retry", async () => {
  for (const patch of [{ schemaVersion: "unknown" }, { worldId: "other" }, { action: { kind: "door.state", sceneId: "s", targetId: "other", value: 1 } }]) {
    const f = fixture(r => ({ ...r, ...patch }));
    try {
      const signal = new AbortController().signal;
      assert.equal(record(await f.service.request(gm, scope, args, authority, signal))["outcome"], "uncertain");
      const recovered = new ChatKitCoreActions(f.client, f.db, f.authorize);
      assert.equal(record(await recovered.request(gm, scope, args, authority, signal))["outcome"], "uncertain");
      assert.equal(f.calls, 1);
    } finally { f.db.close(); }
  }
});
void test("independent core receipt replay remains authorized and world isolated", async () => {
  const f = fixture();
  try {
    const signal = new AbortController().signal;
    assert.equal(record(await f.service.request(gm, scope, args, authority, signal))["outcome"], "confirmed");
    assert.equal(record(await f.service.request(gm, scope, args, authority, signal))["outcome"], "confirmed");
    assert.equal(f.calls, 1);
    f.revoke();
    await assert.rejects(f.service.request(gm, scope, args, authority, signal));
    assert.equal(f.calls, 1);
  } finally { f.db.close(); }
});

void test("independent direct core controls wait behind existing world inference and respect queued cancellation", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const turns = new ChatKitTurns(db);
    const release = await turns.enter(gm, { type: "threads.add_user_message" }, new AbortController().signal);
    assert.ok(release);
    const abort = new AbortController(); let entered = false;
    const queued = turns.enterAction(gm, { kind: "core", action: args.action }, abort.signal).then(r => { entered = true; r?.(); });
    await new Promise<void>(r => setImmediate(r));
    assert.equal(entered, false);
    abort.abort();
    await assert.rejects(queued);
    release();
    const next = await turns.enterAction(gm, { kind: "core", action: args.action }, new AbortController().signal);
    assert.ok(next); next();
  } finally { db.close(); }
});

void test("independent bounded batch stops uncertain target, preserves partial results and replays without movement", async () => {
  const f = fixture(r => record(r["action"]!)["targetId"] === "second" ? { ...r, outcome: "uncertain", state: null, mutated: false } : r);
  try {
    const signal = new AbortController().signal;
    const batch = { actionId: "batch", sceneId: "s", moves: [{ tokenId: "first", x: 1, y: 2 }, { tokenId: "second", x: 3, y: 4 }, { tokenId: "third", x: 5, y: 6 }] };
    const result = record(await f.service.moveBatch(gm, scope, batch, authority, signal));
    assert.equal(result["atomic"], false);
    assert.equal(result["completedOrAttempted"], 2);
    assert.deepEqual(result["unattempted"], ["third"]);
    assert.equal(f.calls, 2);
    await f.service.moveBatch(gm, scope, batch, authority, signal);
    assert.equal(f.calls, 2);
    await assert.rejects(f.service.moveBatch(gm, scope, { ...batch, moves: [{ tokenId: "first", x: 99, y: 99 }] }, authority, signal), /conflict/i);
    await assert.rejects(f.service.moveBatch(gm, scope, { ...batch, moves: [{ tokenId: "first", x: 1, y: 1 }, { tokenId: "first", x: 2, y: 2 }] }, authority, signal));
    await assert.rejects(f.service.moveBatch(gm, scope, { ...batch, moves: Array.from({ length: 9 }, (_, i) => ({ tokenId: `token${i}`, x: 1, y: 1 })) }, authority, signal));
    assert.equal(f.calls, 2);
  } finally { f.db.close(); }
});
