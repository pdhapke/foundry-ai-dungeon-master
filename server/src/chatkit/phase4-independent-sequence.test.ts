import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {ChatKitAttackSequences} from "./attack-sequences.js";
import type {FoundryLocalApiMcpClient} from "../tool-catalog/index.js";
import type {AiDmAuthenticatedIdentity,AiDmJsonValue} from "@foundry-ai-dungeon-master/shared";
const identity:AiDmAuthenticatedIdentity={worldId:"world",userId:"gm",clientId:"client",lane:"gm",isGm:true},scope={worldId:"world",userId:"gm",threadId:"thread"},authority={worldControl:{manualRequest:true as const,requestDigest:"a".repeat(64)}};
const attack={mode:"roll" as const,sceneId:"scene",attackerTokenId:"attacker",actorId:"actor",itemId:"item",activityId:"activity",targetTokenId:"target",advantage:"normal" as const};
const action={mode:"execute" as const,steps:[{stepId:"one",attack}],maxDurationMs:8000};
function fixture(drift=false,lose=false,mutate:(receipt:any)=>void=()=>{}){const db=new DatabaseSync(":memory:");let calls=0,revoked=false;
 const client:FoundryLocalApiMcpClient={listTools:async()=>[],callTool:async call=>{calls++;if(lose)throw Error("lost");const input=call.arguments as Record<string,AiDmJsonValue>,origin=String(input["requestId"]),rollId=createHash("sha256").update(JSON.stringify([origin,"one","roll"])).digest("hex");
 const roll={schemaVersion:"attack-actions-v1",worldId:"world",userId:"gm",requestId:rollId,correlationId:input["correlationId"],action:attack,outcome:"confirmed",mutated:false,state:{systemId:"dnd5e",systemVersion:"6.0.3",attackRequestId:rollId,stage:"miss",source:{sceneId:"scene",attackerTokenId:"attacker",actorId:"actor",itemId:"item",activityId:"activity",targetTokenId:drift?"other":"target"},attackRoll:{formula:"1d20+4",total:5,result:"1+4"},hit:false,critical:false,damageRolls:[],damageRolled:0,damageApplied:null,hpBefore:{value:20,temp:0,max:20},hpAfter:null,decisions:[]}};
 const receipt = {...input,outcome:"confirmed",mutated:false,state:{sequenceRequestId:origin,plan:action.steps,completedStepCount:1,steps:[{stepId:"one",rollReceipt:roll,applyReceipt:null}],continuation:null,limitations:[]}} as AiDmJsonValue;const isolated=structuredClone(receipt);mutate(isolated);return isolated;}};
 return {db,service:new ChatKitAttackSequences(client,db,async()=>{if(revoked)throw Error("revoked")}),get calls(){return calls},revoke(){revoked=true}};
}

const semanticMutations=[
 ["missing roll",(r:any)=>{r.state.steps[0].rollReceipt.state.attackRoll=null;}],
 ["miss damage",(r:any)=>{r.state.steps[0].rollReceipt.state.damageRolled=7;}],
 ["child correlation",(r:any)=>{r.state.steps[0].rollReceipt.correlationId="wrong";}],
 ["empty resource evidence",(r:any)=>{r.state.steps[0].rollReceipt.state.resourceConsumption={verified:true,before:[],after:[]};}],
 ["mutation mismatch",(r:any)=>{r.state.steps[0].rollReceipt.mutated=true;r.mutated=false;}]
] as const;
for(const[label,mutate]of semanticMutations)void test(`independent semantic sequence rejects ${label}`,async()=>{
 const f=fixture(false,false,mutate);try{const r:any=await f.service.request(identity,scope,{actionId:"invalid",action},authority,new AbortController().signal);assert.equal(r.outcome,"uncertain");assert.equal(f.calls,1);}finally{f.db.close();}
});
void test("independent plan/source/count corruption creates uncertain durable receipt not synthetic success",async()=>{
 for(const mutate of [(r:any)=>{r.state.plan[0].attack.targetTokenId="other";},(r:any)=>{r.state.completedStepCount=0;},(r:any)=>{r.state.steps[0].rollReceipt.requestId="fake";}]){const f=fixture(false,false,mutate);try{const r:any=await f.service.request(identity,scope,{actionId:"invalid",action},authority,new AbortController().signal);assert.equal(r.outcome,"uncertain");await f.service.request(identity,scope,{actionId:"invalid",action},authority,new AbortController().signal);assert.equal(f.calls,1);}finally{f.db.close();}}
});

