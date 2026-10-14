import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import { ChatKitReadTools } from "./read-tools.js";
import { ChatKitTurns } from "./turns.js";
import { narrationCompletion, narrationReceiptMatches, expectedNarrationAction } from "./narration-request.js";
import type { ChatKitNativeActions } from "./native-actions.js";
import { TrustedToolCatalog, FoundryLocalApiProviderAdapter, type FoundryLocalApiMcpClient } from "../tool-catalog/index.js";
const gm: AiDmAuthenticatedIdentity = { worldId: "w", userId: "gm", clientId: "c", lane: "gm", isGm: true };
const scope = { worldId: "w", userId: "gm", threadId: "t" };
const body = (text = "set actor A hp to 12 in scene S and narrate the result") => ({ type: "threads.add_user_message", params: { thread_id: "t", input: { content: [{ type: "input_text", text }] } } });
const action = { kind: "actor.hp", sceneId: "S", targetId: "A", value: 12 };
function fixture(options: { enabled?: boolean; text?: string; outcome?: string; holdAction?: boolean; holdAuth?: boolean } = {}) {
  const db = new DatabaseSync(":memory:"), queue = new ChatKitTurns(db), controller = new AbortController();
  let calls = 0, mcpCalls = 0, revoked = false, releaseAction!: () => void, releaseAuth!: () => void;
  const client: FoundryLocalApiMcpClient = { listTools: async () => [], callTool: async () => { mcpCalls++; throw Error("unexpected dispatch"); } };
  const catalog = new TrustedToolCatalog(new FoundryLocalApiProviderAdapter({ client, providerVersion: "fake" }), [], "fake");
  const adapter = new ChatKitReadTools(client, async () => {
    if (options.holdAuth) await new Promise<void>(resolve => { releaseAuth = resolve; });
    if (revoked) throw Error("revoked");
  }, catalog, { internalSecret: "fake", allowMutationBoundary: options.enabled ?? true,
    actions: { request: async (_identity: unknown, _scope: unknown, _operation: unknown, args: { action: AiDmJsonValue }) => {
      calls++; if (options.holdAction) await new Promise<void>(resolve => { releaseAction = resolve; });
      return { schemaVersion: "core-actions-v1", worldId: "w", correlationId: "confirmed-call", outcome: options.outcome ?? "confirmed", action: args.action, state: { value: 12, max: 20 }, mutated: true };
    } } as unknown as ChatKitNativeActions,
  });
  return { db, queue, controller, adapter, request: body(options.text), revoke: () => { revoked = true; }, unblockAction: () => releaseAction(), unblockAuth: () => releaseAuth(), counts: () => ({ calls, mcpCalls }) };
}
void test("explicit narration grammar excludes compound, retrieval-first and ordinary completion", () => {
  assert.ok(narrationCompletion(body()));
  assert.ok(narrationCompletion(body("roll 1d20 then narrate the result")));
  for (const text of ["set actor A hp to 12 in scene S", "open door D in scene S and set actor A hp to 12 in scene S and narrate the result", "find actor A then set actor A hp to 12 in scene S and narrate the result", "open the red door and narrate the result", "pause and narrate the result and advance combat"])
    assert.equal(narrationCompletion(body(text)), undefined);
});
void test("all nine eligible tools require confirmed requested-state evidence, not merely an action echo", () => {
  const cases: [string, Record<string, AiDmJsonValue>][] = [
    ["open door D in scene S", { ds: 1 }],
    ["move token T in scene S to 40,60", { x: 40, y: 60 }],
    ["set actor A hp to 12 in scene S", { value: 12 }],
    ["set actor A condition poisoned on in scene S", { active: true }],
    ["set combatant B initiative to 9 in combat C in scene S", { initiative: 9 }],
    ["advance combat C in scene S turn", { round: 1, turn: 1, turnCount: 3 }],
    ["roll 1d20+2", { formula: "1d20 + 2", total: 14 }],
    ["roll actor A save dex in scene S", { systemId: "dnd5e", rollType: "save", key: "dex", rolls: [{ formula: "1d20+2", total: 14 }] }],
  ];
  for (const [text, state] of cases) {
    const contract = narrationCompletion(body(`${text} and narrate the result`)); assert.ok(contract);
    const receipt = { schemaVersion: "core-actions-v1", worldId: "w", correlationId: "c", outcome: "confirmed", action: expectedNarrationAction(contract)!, state, mutated: true };
    assert.equal(narrationReceiptMatches(contract, "native_core_action", receipt), true, text);
    assert.equal(narrationReceiptMatches(contract, "native_core_action", { ...receipt, state: {} }), false, text);
    assert.equal(narrationReceiptMatches(contract, "native_core_action", { ...receipt, state: { value: 99, ds: 0, x: 9, y: 9, active: false, initiative: 0, round: 0, turn: 9, turnCount: 1, formula: "2d6", total: 9, rolls: [] } }), false, text);
    assert.equal(narrationReceiptMatches(contract, "native_core_action", { ...receipt, outcome: "uncertain" }), false, text);
  }
  const pause = narrationCompletion(body("pause and narrate the result")); assert.ok(pause);
  assert.equal(narrationReceiptMatches(pause, "native_set_pause_core", { worldId: "w", correlationId: "c", outcome: "confirmed", paused: true, mutated: false }), true);
  assert.equal(narrationReceiptMatches(pause, "native_set_pause_core", { worldId: "w", correlationId: "c", outcome: "confirmed", paused: false, mutated: true }), false);
});
void test("permanent adapter revocation precedes durable world-slot release, while narration remains open", async () => {
  const f = fixture(), signal = f.controller.signal;
  const first = await f.queue.enter(gm, f.request, signal, "first"); assert.ok(first);
  const run = f.adapter.begin(gm, f.request, signal, undefined, undefined, ack => first.releaseForNarration(ack));
  let nextEntered = false;
  const next = f.queue.enter(gm, body("roll 1d20"), signal, "next").then(lease => { nextEntered = true; return lease; });
  await f.adapter.execute(run.token, scope, "native_core_action", { action }, signal);
  assert.equal(nextEntered, false);
  const ack = await f.adapter.execute(run.token, scope, "release_mutation_capability", { version: 1 }, signal) as Record<string, AiDmJsonValue>;
  assert.equal(ack["mutationCapability"], "permanently-revoked");
  assert.equal((await next) !== undefined, true);
  assert.equal(f.db.prepare("SELECT status FROM chatkit_turns WHERE event='first'").get()!["status"], "narrating");
  assert.equal(f.db.prepare("SELECT count(*) n FROM chatkit_narration_boundaries").get()!["n"], 1);
  for (const operation of ["native_core_action", "native_attack_action", "native_core_move_batch", "tool_execute", "world_file_write", "campaign_propose", "scene", "tool_load"])
    await assert.rejects(f.adapter.execute(run.token, scope, operation, {}, signal), /permanently revoked/);
  assert.deepEqual(await f.adapter.execute(run.token, scope, "release_mutation_capability", { version: 1 }, signal), ack);
  assert.deepEqual(f.counts(), { calls: 1, mcpCalls: 0 });
  first(); (await next)!(); run.release(); f.db.close();
});
void test("default-off gate, uncertain receipt, compound request and active dispatch cannot release", async () => {
  for (const options of [{ enabled: false }, { outcome: "uncertain" }, { text: "set actor A hp to 12 in scene S and open door D in scene S and narrate the result" }]) {
    const f = fixture(options), signal = f.controller.signal; let released = false;
    const run = f.adapter.begin(gm, f.request, signal, undefined, undefined, () => { released = true; });
    await f.adapter.execute(run.token, scope, "native_core_action", { action }, signal);
    await assert.rejects(f.adapter.execute(run.token, scope, "release_mutation_capability", { version: 1 }, signal));
    assert.equal(released, false); run.release(); f.db.close();
  }
  const f = fixture({ holdAction: true }), signal = f.controller.signal;
  const run = f.adapter.begin(gm, f.request, signal, undefined, undefined, () => {});
  const pending = f.adapter.execute(run.token, scope, "native_core_action", { action }, signal);
  await assert.rejects(f.adapter.execute(run.token, scope, "release_mutation_capability", { version: 1 }, signal), /Complete sole/);
  f.unblockAction(); await pending; run.release(); f.db.close();
});
void test("seal blocks delayed calls during authorization; revocation cannot restore mutation capability", async () => {
  const f = fixture({ holdAuth: true }), signal = f.controller.signal;
  let released = false;
  const run = f.adapter.begin(gm, f.request, signal, undefined, undefined, () => { released = true; });
  await f.adapter.execute(run.token, scope, "native_core_action", { action }, signal);
  const pending = f.adapter.execute(run.token, scope, "release_mutation_capability", { version: 1 }, signal);
  await assert.rejects(f.adapter.execute(run.token, scope, "tool_execute", {}, signal), /permanently revoked/);
  f.revoke(); f.unblockAuth(); await assert.rejects(pending, /revoked/);
  assert.equal(released, false);
  await assert.rejects(f.adapter.execute(run.token, scope, "native_core_action", { action }, signal), /permanently revoked/);
  run.release(); f.db.close();
});
void test("cancel, wrong scope, lost acknowledgement and restart never reacquire old mutation authority", async () => {
  const f = fixture(), signal = f.controller.signal;
  const lease = await f.queue.enter(gm, f.request, signal, "old"); assert.ok(lease);
  let attempts = 0;
  const run = f.adapter.begin(gm, f.request, signal, undefined, undefined, ack => { lease.releaseForNarration(ack); if (++attempts === 1) throw Error("ack lost"); });
  await f.adapter.execute(run.token, scope, "native_core_action", { action }, signal);
  await assert.rejects(f.adapter.execute(run.token, { ...scope, worldId: "other" }, "release_mutation_capability", { version: 1 }, signal), /scope/);
  await assert.rejects(f.adapter.execute(run.token, scope, "release_mutation_capability", { version: 1 }, signal), /ack lost/);
  await assert.rejects(f.adapter.execute(run.token, scope, "native_core_action", { action }, signal), /permanently revoked/);
  await f.adapter.execute(run.token, scope, "release_mutation_capability", { version: 1 }, signal);
  assert.equal(f.db.prepare("SELECT count(*) n FROM chatkit_narration_boundaries").get()!["n"], 1);
  new ChatKitTurns(f.db);
  await assert.rejects(f.queue.enter(gm, f.request, signal, "old"), /already recorded/);
  f.controller.abort(); await assert.rejects(f.adapter.execute(run.token, scope, "release_mutation_capability", { version: 1 }, signal), /expired/);
  run.release(); f.db.close();
});
