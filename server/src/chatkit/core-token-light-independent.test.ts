import test from 'node:test';import assert from 'node:assert/strict';import{DatabaseSync}from'node:sqlite';
import{ChatKitCoreActions}from'./core-actions.js';
import type{SessionRequestAuthorization}from'./pause-request.js';
import type{AiDmAuthenticatedIdentity,AiDmJsonValue}from'@foundry-ai-dungeon-master/shared';
import type{FoundryLocalApiMcpClient}from'../tool-catalog/index.js';
const identity={worldId:'world',userId:'gm',clientId:'client',isGm:true}as AiDmAuthenticatedIdentity;
const scope={worldId:'world',userId:'gm',threadId:'thread'};
const authority:SessionRequestAuthorization={worldControl:{manualRequest:true,requestDigest:'a'.repeat(64)}};
const action={kind:'token.light' as const,sceneId:'S',targetId:'T',light:{bright:20,color:null}};
void test('independent core light authorization and wrong identity fail before native dispatch',async()=>{
 const db=new DatabaseSync(':memory:');let calls=0;const client={listTools:async()=>[],callTool:async()=>{calls++;throw Error('unexpected');}}as FoundryLocalApiMcpClient;const core=new ChatKitCoreActions(client,db,async()=>{});
 try{for(const id of [{...identity,isGm:false},{...identity,worldId:'other'},{...identity,userId:'other'}])await assert.rejects(core.request(id,scope,{actionId:'a',action},authority,AbortSignal.timeout(1000)));await assert.rejects(core.request(identity,scope,{actionId:'a',action},undefined,AbortSignal.timeout(1000)));assert.equal(calls,0);}finally{db.close();}
});
void test('independent partial patch receipt and durable replay use one dispatch',async()=>{
 const db=new DatabaseSync(':memory:');let calls=0;const client={listTools:async()=>[],callTool:async(req)=>{calls++;assert.equal(req.name,'foundry_core_action_confirmed');const a=req.arguments as Record<string,AiDmJsonValue>;assert.deepEqual(a.action,action);return{schemaVersion:'core-actions-v1',worldId:'world',correlationId:a.correlationId!,action,mutated:true,outcome:'confirmed',state:{light:{bright:20,color:null,dim:40,alpha:0.5}}};}}as FoundryLocalApiMcpClient;
 const core=new ChatKitCoreActions(client,db,async()=>{});try{const r=await core.request(identity,scope,{actionId:'a',action},authority,AbortSignal.timeout(1000));const repeated=await core.request(identity,scope,{actionId:'a',action},authority,AbortSignal.timeout(1000));assert.deepEqual(r,repeated);assert.equal(calls,1);await assert.rejects(core.request(identity,scope,{actionId:'a',action:{...action,light:{bright:0,dim:0}}},authority,AbortSignal.timeout(1000)));assert.equal(calls,1);}finally{db.close();}
});
void test('independent unsupported/malformed receipt remains uncertain and cannot replay',async()=>{
 for(const mode of ['unsupported','wrong-world','wrong-state']){const db=new DatabaseSync(':memory:');let calls=0;const client={listTools:async()=>[],callTool:async(req)=>{calls++;if(mode==='unsupported')throw Error('private unsupported details');const a=req.arguments as Record<string,AiDmJsonValue>;return{schemaVersion:'core-actions-v1',worldId:mode==='wrong-world'?'other':'world',correlationId:a.correlationId!,action,mutated:true,outcome:'confirmed',state:{light:{bright:mode==='wrong-state'?0:20,color:null}}};}}as FoundryLocalApiMcpClient;const core=new ChatKitCoreActions(client,db,async()=>{});try{const r=await core.request(identity,scope,{actionId:'a',action},authority,AbortSignal.timeout(1000))as Record<string,AiDmJsonValue>;assert.equal(r.outcome,'uncertain');assert.equal(r.state,null);assert.ok(!JSON.stringify(r).includes('private unsupported details'));await core.request(identity,scope,{actionId:'a',action},authority,AbortSignal.timeout(1000));assert.equal(calls,1);}finally{db.close();}}
});
