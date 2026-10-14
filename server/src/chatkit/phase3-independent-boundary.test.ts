import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from "@foundry-ai-dungeon-master/shared";
import { ChatKitReadTools } from "./read-tools.js";
import { ChatKitTurns } from "./turns.js";
import { narrationCompletion } from "./narration-request.js";
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

import { expectedNarrationAction, narrationReceiptMatches } from "./narration-request.js";
void test("independent Node boundary rejects unconfirmed requested-state semantics", () => {
 const contract = narrationCompletion(body())!;
 for (const state of [{value:99,max:20}, {}, {value:"12",max:20}]) assert.equal(narrationReceiptMatches(contract, "native_core_action", { schemaVersion:"core-actions-v1", worldId:"w", outcome:"confirmed", mutated:true, correlationId:"receipt", action, state }), false);
 assert.equal(narrationReceiptMatches(contract, "native_core_action", { schemaVersion:"core-actions-v1", worldId:"w", outcome:"confirmed", mutated:true, correlationId:"receipt", action, state:{value:12,max:20} }), true);
});
void test("independent adapter expires old token on release and denies world switch without dispatch", async () => {
 const f=fixture();const signal=f.controller.signal;let releases=0;
 const run=f.adapter.begin(gm,f.request,signal,undefined,undefined,()=>{releases++;});
 await f.adapter.execute(run.token,scope,"native_core_action",{action},signal);
 await assert.rejects(f.adapter.execute(run.token,{...scope,userId:"other"},"release_mutation_capability",{version:1},signal),/scope/);
 await f.adapter.execute(run.token,scope,"release_mutation_capability",{version:1},signal);
 run.release();
 await assert.rejects(f.adapter.execute(run.token,scope,"native_core_action",{action},signal),/expired/);
 assert.equal(releases,1);assert.deepEqual(f.counts(),{calls:1,mcpCalls:0});f.db.close();
});
void test("independent lost durable-write acknowledgement never permits old generic tools", async () => {
 const f=fixture();const signal=f.controller.signal;
 const run=f.adapter.begin(gm,f.request,signal,undefined,undefined,()=>{throw Error("SQLite unavailable");});
 await f.adapter.execute(run.token,scope,"native_core_action",{action},signal);
 await assert.rejects(f.adapter.execute(run.token,scope,"release_mutation_capability",{version:1},signal),/SQLite/);
 for(const operation of ["tool_search","tool_load","tool_execute","world_file_write","campaign_propose","native_attack_action","native_core_move_batch"])
 await assert.rejects(f.adapter.execute(run.token,scope,operation,{},signal),/permanently revoked/);
 assert.deepEqual(f.counts(),{calls:1,mcpCalls:0});run.release();f.db.close();
});



void test("independent completion-state matrix rejects partial door/movement/condition/initiative/combat/roll evidence", () => {
 const cases = [
 ["foundry_set_door_state",{scene_id:"S",door_id:"D",state:"open"},{ds:1},{ds:0}],
 ["foundry_move_token",{scene_id:"S",token_id:"T",x:100,y:200,mode:"walk"},{x:100,y:200},{x:100,y:99}],
 ["foundry_set_actor_condition",{scene_id:"S",actor_id:"A",condition_id:"prone",active:true},{active:true},{active:false}],
 ["foundry_set_initiative",{scene_id:"S",combat_id:"C",combatant_id:"B",value:14},{initiative:14},{initiative:10}],
 ["foundry_advance_combat_turn",{scene_id:"S",combat_id:"C"},{round:1,turn:1,turnCount:2},{round:1,turn:2,turnCount:2}],
 ["foundry_roll_dice",{formula:"1d20"},{formula:"1d20",total:8},{formula:"2d20",total:8}],
 ["foundry_roll_actor",{scene_id:"S",actor_id:"A",roll_type:"save",key:"str"},{systemId:"dnd5e",rollType:"save",key:"str",rolls:[{formula:"1d20",total:8}]},{systemId:"dnd5e",rollType:"save",key:"str",rolls:[]}]
 ] as const;
 for(const [toolName,args,good,bad] of cases){
 const contract={version:1,toolName,arguments:args} as any;
 const receipt={schemaVersion:"core-actions-v1",outcome:"confirmed",mutated:true,correlationId:"r",worldId:"w",action:expectedNarrationAction(contract)!};
 assert.equal(narrationReceiptMatches(contract,"native_core_action",{...receipt,state:good} as any),true,toolName);
 assert.equal(narrationReceiptMatches(contract,"native_core_action",{...receipt,state:bad} as any),false,toolName);
 }
});
