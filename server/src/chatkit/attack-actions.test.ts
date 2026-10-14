import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ChatKitAttackActions, ATTACK_PROTOCOL } from "./attack-actions.js";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import type { FoundryLocalApiMcpClient } from "../tool-catalog/index.js";
const gm: AiDmAuthenticatedIdentity = { worldId: "world", userId: "gm", clientId: "client", lane: "gm", isGm: true };
const scope = { worldId: "world", userId: "gm", threadId: "thread" };
const authority = { worldControl: { manualRequest: true as const, requestDigest: "a".repeat(64) } };
const action = { mode: "roll" as const, sceneId: "scene", attackerTokenId: "attacker", actorId: "actor", itemId: "item", activityId: "activity", targetTokenId: "target", advantage: "advantage" as const };
function fixture(outcome = "confirmed") {
  const db = new DatabaseSync(":memory:"); let calls = 0, revoked = false;
  let originating = "";
  const client: FoundryLocalApiMcpClient = { listTools: async () => { assert.fail("No attack schema discovery"); }, callTool: async call => {
    calls++; const args = call.arguments as Record<string, AiDmJsonValue>, selected = args["action"] as Record<string, AiDmJsonValue>;
    if (selected["mode"] === "roll") originating = String(args["requestId"]);
    const apply = selected["mode"] === "apply";
    return { ...args, outcome, mutated: true, state: { systemId: "dnd5e", systemVersion: "6.0.3", attackRequestId: originating,
      stage: apply ? "damage-applied" : "damage-rolled", source: { sceneId: "scene", attackerTokenId: "attacker", actorId: "actor", itemId: "item", activityId: "activity", targetTokenId: "target" },
      attackRoll: { formula: "2d20kh + 4", total: 24, result: "20 + 4", isCritical: true, isFumble: false }, hit: true, critical: true,
      damageRolls: [{ formula: "2d6 + 2", total: 10, result: "8 + 2", type: "slashing", properties: [] }], damageRolled: 10, damageApplied: apply ? 5 : null,
      hpBefore: { value: 20, temp: 3, max: 20 }, hpAfter: apply ? { value: 18, temp: 0, max: 20 } : null,
      adjustedDamage: [{ type: "slashing", value: 5, active: true }], decisions: [] } };
  } };
  const authorize = async () => { if (revoked) throw new Error("Permission revoked"); };
  return { db, service: new ChatKitAttackActions(client, db, authorize), get calls() { return calls; }, revoke() { revoked = true; } };
}
void test("native attack recorded once; damage application uses prior scoped evidence, never rerolls", async () => {
  const f = fixture();try {
    const signal = new AbortController().signal;
    const rolled = await f.service.request(gm, scope, { actionId: "attack-one", action }, authority, signal) as Record<string, AiDmJsonValue>;
    assert.equal(rolled["schemaVersion"], ATTACK_PROTOCOL);
    assert.equal((rolled["state"] as Record<string, AiDmJsonValue>)["damageApplied"], null);
    await f.service.request(gm, scope, { actionId: "attack-one", action }, authority, signal);assert.equal(f.calls, 1);
    const applied = await f.service.request(gm, scope, { actionId: "damage-one", action: { mode: "apply", priorAttackRequestId: rolled["requestId"] } }, authority, signal) as Record<string, AiDmJsonValue>;
    assert.equal(applied["outcome"], "confirmed");assert.equal(f.calls, 2);
    await assert.rejects(f.service.request(gm, scope, { actionId: "attack-one", action: { ...action, targetTokenId: "different" } }, authority, signal), /conflict/);
    f.revoke();await assert.rejects(f.service.request(gm, scope, { actionId: "attack-one", action }, authority, signal), /revoked/);
  } finally { f.db.close(); }
});
void test("lost or uncertain attack fences new IDs; model decision flags cannot resolve tickets", async () => {
  const f = fixture("uncertain");try {
    const signal = new AbortController().signal;
    await f.service.request(gm, scope, { actionId: "uncertain", action }, authority, signal);
    await assert.rejects(f.service.request(gm, scope, { actionId: "new-id", action }, authority, signal), /reconcile/);
    await assert.rejects(f.service.request(gm, scope, { actionId: "model-choice", action: { mode: "apply", priorAttackRequestId: "unknown", decisionId: "ticket" } }, authority, signal));
    assert.equal(f.calls, 1);
  } finally { f.db.close(); }
});
