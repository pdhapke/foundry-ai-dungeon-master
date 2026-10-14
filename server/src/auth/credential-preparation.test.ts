import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatGptPlanAuth } from './chatgpt-plan-auth.js';
import type { AiDmAuthenticatedIdentity } from '@foundry-ai-dungeon-master/shared';
import type { AiDmLocalSessionProof } from './foundry-session.js';
const gm={worldId:'w',userId:'u',clientId:'c',isGm:true,lane:'gm'} as AiDmAuthenticatedIdentity;
async function fixture(expiry:number, extra?:(input:string,init?:RequestInit)=>Promise<Response>|undefined) {
 const dir=await mkdtemp(join(tmpdir(),'prep-auth-'));let clock=0, models=0,refreshes=0;
 const auth=new ChatGptPlanAuth({path:join(dir,'auth'),encryptionKey:'key',redirectUri:'http://127.0.0.1/callback',validateLocalSessionProof:p=>p,now:()=>clock,modelDiscoveryTimeoutMs:10,idTokenVerifier:async()=>({}),fetch:async(input,init)=>{
 const url=String(input); const result=extra?.(url,init);if(result)return result;
 if(url.endsWith('/models')){models++;return Response.json({models:[{slug:'m',display_name:'M',visibility:'list'}]});}
 if((init?.body as URLSearchParams)?.get('grant_type')==='refresh_token')refreshes++;
 return Response.json({access_token:'access',refresh_token:'refresh',id_token:'identity',expires_in:expiry,scope:'openid chatgpt.tokens.use.direct',client_id:'issued'});
 }});
 await auth.initialize();const started=new URL(auth.begin(gm,{identity:gm,clientId:'c',browserSessionId:'b',moduleVersion:'v',sessionHash:'h',generation:1,expiresAt:'2099-01-01'} as AiDmLocalSessionProof).authorizationUrl);
 await auth.complete('code',started.searchParams.get('state')!,'issued');
 return {auth,setClock:(n:number)=>{clock=n;},counts:()=>({models,refreshes}),clean:()=>rm(dir,{recursive:true})};
}
test('model catalog survives old idle boundary but respects actual token safety margin',async()=>{
 const f=await fixture(120);try{await f.auth.resolveModel('w','m');f.setClock(59000);await f.auth.resolveModel('w','m');assert.deepEqual(f.counts(),{models:1,refreshes:0});f.setClock(61000);await f.auth.resolveModel('w','m');assert.deepEqual(f.counts(),{models:2,refreshes:1});}finally{await f.clean();}
 const g=await fixture(3600);try{await g.auth.resolveModel('w','m');g.setClock(61000);await g.auth.resolveModel('w','m');assert.equal(g.counts().models,1);g.setClock(301000);await g.auth.resolveModel('w','m');assert.equal(g.counts().models,2);}finally{await g.clean();}
});
test('refresh timeout is bounded and subsequent demand is backed off',async()=>{
 let attempts=0;const f=await fixture(1,(_url,init)=>{if((init?.body as URLSearchParams)?.get('grant_type')!=='refresh_token')return;attempts++;return new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(Error('timeout')),{once:true}));});
 try{await assert.rejects(f.auth.accessToken('w'));await assert.rejects(f.auth.accessToken('w'),/backoff/);assert.equal(attempts,1);f.setClock(2100);await assert.rejects(f.auth.accessToken('w'));assert.equal(attempts,2);}finally{await f.clean();}
});
test('invalidating during refresh cannot restore or return revoked credentials',async()=>{
 let release!:(r:Response)=>void;let entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});
 const f=await fixture(1,(_url,init)=>{if((init?.body as URLSearchParams)?.get('grant_type')!=='refresh_token')return;entered();return new Promise<Response>(r=>{release=r;});});
 try{const pending=f.auth.accessToken('w');await started;await f.auth.invalidate('w');release(Response.json({access_token:'new',refresh_token:'new-refresh',expires_in:3600,scope:'chatgpt.tokens.use.direct'}));await assert.rejects(pending,/Reconnect|rejected/);assert.equal(f.auth.providerState('w'),'blocked');}finally{await f.clean();}
});
test('invalidating during model discovery cannot publish stale configuration',async()=>{
 let release!:(r:Response)=>void;let entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});
 const f=await fixture(3600,(url)=>{if(!url.endsWith('/models'))return;entered();return new Promise<Response>(r=>{release=r;});});
 try{const pending=f.auth.resolveModel('w','m');await started;await f.auth.invalidate('w');release(Response.json({models:[{slug:'m',display_name:'M',visibility:'list'}]}));await assert.rejects(pending,/rejected/);assert.equal(f.auth.status('w','u').selectedModel,null);assert.deepEqual(f.auth.status('w','u').availableModels,[]);}finally{await f.clean();}
});
