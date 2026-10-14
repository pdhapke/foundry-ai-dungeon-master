import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import type { FoundryLocalApiMcpClient } from "../tool-catalog/index.js";
import { ChatKitAttackActions } from "./attack-actions.js";

const gm: AiDmAuthenticatedIdentity = { worldId: "world", userId: "gm", clientId: "client", lane: "gm", isGm: true };
const scope = { worldId: "world", userId: "gm", threadId: "thread" };
const source = { sceneId: "scene", attackerTokenId: "source", actorId: "actor", itemId: "item", activityId: "attack", targetTokenId: "target" };
const action = { mode: "roll", ...source, advantage: "normal" };
const authority = { worldControl: { manualRequest: true as const, requestDigest: "a".repeat(64) } };
function fixture(patch: Record<string, AiDmJsonValue> = {}, statePatch: Record<string, AiDmJsonValue> = {}) {
  const db = new DatabaseSync(":memory:");
  let calls = 0, revoked = false;
  const client: FoundryLocalApiMcpClient = { listTools: async () => { assert.fail("attack must not discover"); }, callTool: async call => {
    calls++;
    const args = call.arguments as Record<string, AiDmJsonValue>;
    return { ...args, outcome: "confirmed", mutated: true, state: { systemId: "dnd5e", systemVersion: "6.0.3", attackRequestId: args["requestId"]!, stage: "damage-rolled", source, attackRoll: { formula: "1d20+4", total: 19, result: "15+4" }, hit: true, critical: false, damageRolls: [{ formula: "1d6+2", total: 6, result: "4+2" }], damageRolled: 6, damageApplied: null, hpBefore: { value: 20, temp: 3, max: 20 }, hpAfter: null, decisions: [], ...statePatch }, ...patch };
  } };
  const service = new ChatKitAttackActions(client, db, async () => { if (revoked) throw new Error("revoked"); });
  return { db, service, revoke: () => { revoked = true; }, get calls() { return calls; } };
}
void test("independent attack confirmed duplicates persist across reconnect, conflicts and revoked authority never dispatch", async () => {
  const f = fixture();
  try {
    const signal = new AbortController().signal;
    const first = await f.service.request(gm, scope, { actionId: "once", action }, authority, signal);
    const reconnected = new ChatKitAttackActions({ listTools: async () => [], callTool: async () => { assert.fail("duplicate rerolled"); } }, f.db, async () => {});
    assert.deepEqual(await reconnected.request(gm, scope, { actionId: "once", action }, authority, signal), first);
    await assert.rejects(f.service.request(gm, scope, { actionId: "once", action: { ...action, advantage: "advantage" } }, authority, signal), /conflict/);
    f.revoke();
    await assert.rejects(f.service.request(gm, scope, { actionId: "once", action }, authority, signal), /revoked/);
    assert.equal(f.calls, 1);
  } finally { f.db.close(); }
});
void test("independent contradictory source roll identity and applied HP evidence become uncertain and fence new IDs", async () => {
  for (const statePatch of [{ source: { ...source, targetTokenId: "other" } }, { attackRequestId: "different" }, { stage: "damage-applied", damageApplied: 6, hpAfter: { value: 20, temp: 0, max: 20 } }, { stage: "damage-applied", hit: false, damageApplied: 3, hpAfter: { value: 20, temp: 0, max: 20 } }]) {
    const f = fixture({}, statePatch);
    try {
      const signal = new AbortController().signal;
      assert.equal((await f.service.request(gm, scope, { actionId: "once", action }, authority, signal) as Record<string, AiDmJsonValue>)["outcome"], "uncertain");
      await assert.rejects(f.service.request(gm, scope, { actionId: "new", action }, authority, signal), /reconcile/);
      assert.equal(f.calls, 1);
    } finally { f.db.close(); }
  }
});
void test("independent invalid receipt becomes durable uncertain without another dispatch", async () => {
  for (const patch of [{ worldId: "other" }, { userId: "other" }, { schemaVersion: "other" }, { state: null }]) {
    const f = fixture(patch);
    try {
      const signal = new AbortController().signal;
      const result = await f.service.request(gm, scope, { actionId: "once", action }, authority, signal) as Record<string, AiDmJsonValue>;
      assert.equal(result["outcome"], "uncertain");
      assert.deepEqual(await f.service.request(gm, scope, { actionId: "once", action }, authority, signal), result);
      assert.equal(f.calls, 1);
    } finally { f.db.close(); }
  }
});
void test("independent attack rejects nonhuman reaction waiver, wrong world and canceled dispatch", async () => {
  const f = fixture();
  try {
    const signal = new AbortController().signal;
    const receipt = await f.service.request(gm, scope, { actionId: "roll", action }, authority, signal) as Record<string, AiDmJsonValue>;
    await assert.rejects(f.service.request(gm, scope, { actionId: "apply", action: { mode: "apply", priorAttackRequestId: receipt["requestId"], decisionId: "model-made-up" } }, authority, signal), /human/);
    await assert.rejects(f.service.request(gm, { ...scope, worldId: "other" }, { actionId: "another", action }, authority, signal), /GM world/);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(f.service.request(gm, scope, { actionId: "another", action }, authority, aborted.signal));
    assert.equal(f.calls, 1);
  } finally { f.db.close(); }
});
