import { PreparationPrivacyError } from '../campaign-privacy.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';
import { createAiDmApp } from '../app.js';
import { createChatKitGateway, type ChatKitGatewayOptions } from './gateway.js';
import type { AiDmAuthenticatedIdentity } from '@foundry-ai-dungeon-master/shared';
const gm = { clientId:'c', worldId:'w', userId:'u', lane:'gm', isGm:true } as AiDmAuthenticatedIdentity;
function fixture(overrides: Partial<ChatKitGatewayOptions> = {}) {
 return createAiDmApp({ readiness:()=>({ready:true,details:{}}), chatkitHandler:createChatKitGateway({sidecarUrl:'http://127.0.0.1:3941',internalSecret:'internal',allowedOrigins:[],authenticate:()=>gm,authorize:async()=>{},resolveAuthorization:async()=>({apiKey:'secret-sentinel',model:'test'}),prepareContext:async()=>({status:'prepared',catalogRevision:'r'}),fetch:async(url)=>{assert.equal(new URL(String(url)).pathname,'/context-admission');return Response.json({admissible:true,permanentTokenUpperBound:4000,inputCeiling:24576,reservedToolsAndOutput:8192,remainingInputUnits:20576});},...overrides}) });
}
test('preparation shares concurrent work, retains authorization, and exposes no credential', async()=>{
 let credentials=0, contexts=0, checks=0;
 let bothChecked!:()=>void;const both=new Promise<void>(resolve=>{bothChecked=resolve;});
 let release!:()=>void; const gate=new Promise<void>(resolve=>{release=resolve;});
 const app=fixture({authorize:async()=>{checks++;if(checks===2)bothChecked();},resolveAuthorization:async()=>{credentials++;await gate;return {apiKey:'secret-sentinel',model:'test'};},prepareContext:async()=>{contexts++;await gate;return {status:'prepared'};}});
 const a=request(app).post('/chatkit/prepare').send({}).then(v=>v);
 const b=request(app).post('/chatkit/prepare').send({}).then(v=>v);
 await both; await new Promise(resolve=>setImmediate(resolve)); release();
 const result=await Promise.all([a,b]);
 assert.equal(credentials,1);assert.equal(contexts,1);assert.equal(checks,4);
 for(const r of result){assert.equal(r.status,200);assert.equal(r.body.state,'ready');assert.doesNotMatch(JSON.stringify(r.body),/secret-sentinel/);}
});
test('expired browser credentials and current role changes cannot prepare',async()=>{
 for(const overrides of [{authenticate:()=>{throw Error('Expired');}}, {authorize:async()=>{throw Error('Role changed');}}]) {
  let called=0;const r=await request(fixture({...overrides,resolveAuthorization:async()=>{called++;throw Error('Forbidden');}})).post('/chatkit/prepare').send({});
  assert.ok([401,403].includes(r.status));assert.equal(called,0);
 }
});
test('failed preparation is actionable and retries are backed off without sidecar calls',async()=>{
 let called=0;const app=fixture({resolveAuthorization:async()=>{called++;throw Error('unavailable secret-sentinel');}});
 for(let i=0;i<2;i++){const r=await request(app).post('/chatkit/prepare').send({});assert.equal(r.status,503);assert.equal(r.body.state,'reconnect-required');assert.doesNotMatch(JSON.stringify(r.body),/secret-sentinel/);}
 assert.equal(called,1);
});
test('privacy preparation failure gives action required and never discloses path', async()=>{
 const r=await request(fixture({prepareContext:async()=>{throw new PreparationPrivacyError(['public-campaign-copies','public-operational-store']);}})).post('/chatkit/prepare').send({});
 assert.equal(r.status,503);assert.equal(r.body.reason,'privacy-action-required');assert.deepEqual(r.body.blockers,['public-campaign-copies','public-operational-store']);
});
test('only exact server-configured scoped fixture budgets reach loopback; spoofing is rejected',async()=>{
 const trace='12345678-1234-1234-1234-123456789abc';let observed:Headers|undefined;
 const app=fixture({acceptanceFixtures:{f:{worldId:'w',userId:'u',threadId:'t',traceId:trace,maxModelRequests:1,expiresAt:new Date(Date.now()+60000).toISOString()}},fetch:async(_url,init)=>{observed=new Headers(init?.headers);return Response.json({ok:true});}});
 const body={type:'threads.add_user_message',params:{thread_id:'t',input:{content:[]}}};
 const spoof=await request(app).post('/chatkit').set('x-chatkit-acceptance-fixture','f').send(body);assert.equal(spoof.status,403);assert.equal(observed,undefined);
 const mismatch=await request(app).post('/chatkit').set('x-ai-dm-trace',trace).send({...body,params:{...body.params,thread_id:'other'}});assert.equal(mismatch.status,403);assert.equal(observed,undefined);
 const r=await request(app).post('/chatkit').set('x-ai-dm-trace',trace).send(body);assert.equal(r.status,200);assert.equal(observed!.get('x-chatkit-acceptance-fixture'),'f');
 const ordinary=await request(app).post('/chatkit').send(body);assert.equal(ordinary.status,200);assert.equal(observed!.get('x-chatkit-acceptance-fixture'),null);
});

test('context admission uses authenticated loopback model and returns bounded nonsecret metadata', async()=>{
 let calls=0;
 const r=await request(fixture({fetch:async(url,init)=>{
  calls++;assert.equal(String(url),'http://127.0.0.1:3941/context-admission');
  const headers=new Headers(init?.headers);assert.equal(headers.get('x-chatkit-secret'),'internal');
  assert.deepEqual(JSON.parse(Buffer.from(headers.get('x-chatkit-principal')!,'base64').toString()),{worldId:'w',userId:'u',isGm:true});
  assert.equal(headers.get('x-chatkit-api-key'),null);assert.deepEqual(JSON.parse(String(init?.body)),{model:'test'});
  return Response.json({admissible:true,permanentTokenUpperBound:4000,inputCeiling:24576,reservedToolsAndOutput:8192,remainingInputUnits:20576,untrusted:'secret-sentinel'});
 }})).post('/chatkit/prepare').send({});
 assert.equal(calls,1);assert.equal(r.status,200);assert.equal(r.body.contextAdmission.remainingInputUnits,20576);
 assert.match(r.body.meaning,/full conversation admission/);assert.doesNotMatch(JSON.stringify(r.body),/secret-sentinel/);
});
test('unavailable malformed negative and insufficient context admission never report ready',async()=>{
 const valid={admissible:true,permanentTokenUpperBound:4000,inputCeiling:24576,reservedToolsAndOutput:8192,remainingInputUnits:20576};
 const cases=[null,{...valid,admissible:false},{...valid,remainingInputUnits:4095},{...valid,inputCeiling:1},{...valid,reservedToolsAndOutput:-1},{...valid,reservedToolsAndOutput:8191},{...valid,permanentTokenUpperBound:'4000'}];
 for(const result of cases){
  const r=await request(fixture({fetch:async()=>Response.json(result)})).post('/chatkit/prepare').send({});
  assert.equal(r.status,503);assert.equal(r.body.reason,'context-action-required');assert.match(r.body.error,/No inference was sent/);
 }
 for(const fetchMock of [async()=>{throw Error('internal secret-sentinel');},async()=>new Response('invalid-json'),async()=>Response.json(valid,{status:503})]){
  const r=await request(fixture({fetch:fetchMock})).post('/chatkit/prepare').send({});
  assert.equal(r.status,503);assert.equal(r.body.reason,'context-action-required');assert.doesNotMatch(JSON.stringify(r.body),/secret-sentinel/);
 }
});

test('minimum 4096 request headroom and separate 8192 tools output reserve are admissible',async()=>{
 const r=await request(fixture({fetch:async()=>Response.json({admissible:true,permanentTokenUpperBound:20480,inputCeiling:24576,reservedToolsAndOutput:8192,remainingInputUnits:4096})})).post('/chatkit/prepare').send({});
 assert.equal(r.status,200);assert.equal(r.body.contextAdmission.remainingInputUnits,4096);
 assert.equal(r.body.contextAdmission.reservedToolsAndOutput,8192);assert.match(r.body.meaning,/full conversation admission/);
});
