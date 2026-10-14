import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import request from 'supertest';
import {PreparationService} from '../preparation-service.js';
import {PreparationPublicationReviews} from './publication-review.js';
import {PreparationRecordStore,type CampaignRecord} from './records.js';
import {CampaignStorage} from '../context/campaign-storage.js';
import {hashText} from '../context/hash.js';
import {PreparationRequestError,preparationFailureResponse,preparationResultEffects,markPreparationResult,preparationErrorCode,preparationPhaseEvent} from './outcome.js';
import {configureLatencyTrace,withLatencyTrace} from '../latency-trace.js';
import {createChatKitGateway} from '../chatkit/gateway.js';
import {createAiDmApp} from '../app.js';
import type {AiDmAuthenticatedIdentity,AiDmJsonValue} from '@foundry-ai-dungeon-master/shared';
const identity={worldId:'fixture',userId:'gm',clientId:'client',isGm:true} as AiDmAuthenticatedIdentity;
const caller={worldId:'fixture',userId:'gm',clientId:'client',isGm:true};
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'publication-outcome-independent-')),protectedRoot=join(root,'private'),publicRoot=join(root,'Data'),campaign=join(protectedRoot,'fixture','data','campaign');mkdirSync(campaign,{recursive:true});mkdirSync(publicRoot);
 const db=new DatabaseSync(':memory:');let authCalls=0,denyAt=Infinity;
 const protectedOptions={protectedRoot,publicDataRoot:publicRoot};
 const storage=new CampaignStorage(protectedRoot,{authorize:w=>assert.equal(w,'fixture'),assertPrivateStorage:()=>{}},128000,512000,protectedOptions);
 const reviews=new PreparationPublicationReviews(db,c=>assert.equal(c.worldId,'fixture'));
 const text='# Private fixture source\nSECRET FACT';writeFileSync(join(campaign,'source.md'),text);const sourceHash=hashText(text);
 const records=new PreparationRecordStore(storage,(_w,id)=>reviews.assertApproved(caller,id),()=>sourceHash);
 const record=(kind:'overview'|'index'):CampaignRecord=>({schemaVersion:1,id:kind,worldId:'fixture',kind,title:'PRIVATE TITLE',aliases:[],revision:1,visibility:'gm',status:'confirmed',epistemic:'proposed',sources:[{uri:'campaign://fixture/source.md',hash:sourceHash,startLine:1,endLine:2}],relationships:[],sections:[{heading:'Private',text:'SECRET FACT'}],unknowns:['PRIVATE UNKNOWN'],contradictions:[],generated:false});
 const candidate={schemaVersion:1 as const,worldId:'fixture',candidateId:'candidate',baseRevision:null,records:[record('overview'),record('index')],manifest:{'campaign://fixture/source.md':sourceHash}};
 const service=new PreparationService({worldsRoot:join(publicRoot,'worlds'),protectedCampaign:protectedOptions,jobsRoot:join(root,'jobs'),database:db,sidecarUrl:'http://localhost',internalSecret:'fixture',assertPrivateStorage:()=>{},authorize:async()=>{if(++authCalls>=denyAt)throw Object.assign(Error('PRIVATE FAILURE AND CREDENTIAL'),{code:'PERMISSION_DENIED'});}});
 return {db,service,storage,reviews,records,candidate,campaign,deny:(n:number)=>{denyAt=n;},close:()=>{db.close();rmSync(root,{recursive:true,force:true});}};
}
function seedCompleted(f:ReturnType<typeof fixture>){
 const review={schemaVersion:1,reviewer:caller,candidate:f.candidate,companions:{'overview.md':null,'index.md':null},digest:'a'.repeat(64),status:'completed',receipt:{privateReceipt:'DO NOT LEAK'}};
 f.db.prepare('INSERT INTO preparation_publication_reviews(scope,candidate,body) VALUES(?,?,?)').run(JSON.stringify(['fixture','gm','client']),'candidate',JSON.stringify(review));return review;
}
test('independent outcome: completed status and exact replay authenticate without candidate/files reread',async()=>{
 const f=fixture();try{seedCompleted(f);
 const originalRead=CampaignStorage.prototype.read,originalCandidate=PreparationRecordStore.prototype.candidate,originalActive=PreparationRecordStore.prototype.active;
 CampaignStorage.prototype.read=()=>{throw Error('Forbidden file reread');};PreparationRecordStore.prototype.candidate=()=>{throw Error('Forbidden candidate reread');};PreparationRecordStore.prototype.active=()=>{throw Error('Forbidden active reread');};
 try{
 const read=await f.service.execute(identity,{operation:'candidate-review',input:{candidateId:'candidate'}},new AbortController().signal);
 const result=(read as unknown as {result:{status:string;activeVersionVerified:boolean;completionEvidence:string}}).result;assert.equal(result.status,'completed');assert.equal(result.activeVersionVerified,false);assert.equal(result.completionEvidence,'historical');assert.equal(preparationResultEffects(read),'committed');
 const replay=await f.service.execute(identity,{operation:'candidate-publish',input:{candidateId:'candidate',reviewDigest:'a'.repeat(64),decision:'approve'}},new AbortController().signal,'browser');assert.equal((replay as unknown as {result:{status:string}}).result.status,'completed');
 assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM preparation_publication_reviews').get()!.count,1);
 }finally{CampaignStorage.prototype.read=originalRead;PreparationRecordStore.prototype.candidate=originalCandidate;PreparationRecordStore.prototype.active=originalActive;}
 }finally{f.close();}
});
test('independent outcome: actual commit followed by auth loss reports committed without private response data',async()=>{
 const f=fixture();try{f.records.stage(f.candidate);const review=f.reviews.stage(caller,'candidate',f.records,f.storage);f.deny(3);
 let failure:unknown;try{await f.service.execute(identity,{operation:'candidate-publish',input:{candidateId:'candidate',reviewDigest:review.reviewDigest,decision:'approve'}},new AbortController().signal,'browser');}catch(e){failure=e;}
 assert.ok(failure instanceof PreparationRequestError);assert.equal(failure.effects,'committed');assert.equal(failure.phase,'service-final-authorization');const reply=preparationFailureResponse(failure);assert.equal(reply.status,403);assert.equal(reply.body.state,'committed-revalidation-required');assert.equal(reply.body.currentAuthorizationVerified,false);assert.doesNotMatch(JSON.stringify(reply),/SECRET|PRIVATE|candidate|receipt|source\.md|credential|a{64}/i);
 assert.ok(existsSync(join(f.campaign,'overview.md')));assert.ok(f.records.publicationReceipt('fixture','candidate'));assert.equal(JSON.parse(String(f.db.prepare('SELECT body FROM preparation_publication_reviews').get()!.body)).status,'completed');
 }finally{f.close();}
});
test('independent outcome: pre-dispatch authorization failure cannot claim committed work',async()=>{
 const f=fixture();try{f.records.stage(f.candidate);const review=f.reviews.stage(caller,'candidate',f.records,f.storage);f.deny(2);
 await assert.rejects(f.service.execute(identity,{operation:'candidate-publish',input:{candidateId:'candidate',reviewDigest:review.reviewDigest,decision:'approve'}},new AbortController().signal,'browser'),e=>{assert.ok(e instanceof PreparationRequestError);assert.equal(e.effects,'none');assert.equal(preparationFailureResponse(e).body.state,'authorization-required');return true;});
 assert.equal(existsSync(join(f.campaign,'overview.md')),false);assert.equal(f.records.publicationReceipt('fixture','candidate'),null);
 }finally{f.close();}
});
test('independent outcome: JSON and cloned objects cannot forge trusted effects markers',()=>{
 const fake={effects:'committed',__preparationEffects:'committed',result:{status:'completed',receipt:{secret:true}}};assert.equal(preparationResultEffects(fake),'none');const real=markPreparationResult(fake,'committed');assert.equal(preparationResultEffects(real),'committed');assert.equal(preparationResultEffects(structuredClone(real)),'none');assert.equal(preparationResultEffects(JSON.parse(JSON.stringify(real))),'none');assert.equal(preparationErrorCode({message:'SECRET',code:'SECRET'}),'UNAVAILABLE');
});
test('independent outcome: gateway final auth loss strips receipts and honors only in-process effects',async()=>{
 for(const trusted of [true,false]){
 let auth=0;const value={result:{status:'completed',receipt:'PRIVATE RECEIPT',candidateId:'PRIVATE CANDIDATE'},effects:'committed'};
 const handler=createChatKitGateway({sidecarUrl:'http://localhost',internalSecret:'fixture',allowedOrigins:[],authenticate:()=>identity,authorize:async()=>{if(++auth>=2)throw Error('PRIVATE AUTH ERROR');},resolveAuthorization:async()=>{throw Error('No credentials');},preparationAction:async()=> (trusted?markPreparationResult(value,'committed'):value) as unknown as AiDmJsonValue});
 const app=createAiDmApp({chatkitHandler:handler,readiness:()=>({ready:true,details:{}})});const response=await request(app).post('/chatkit/preparation').send({operation:'candidate-review',input:{}});
 assert.equal(response.status,403);assert.equal(response.body.state,trusted?'committed-revalidation-required':'authorization-required');assert.doesNotMatch(JSON.stringify(response.body),/PRIVATE|receipt|candidate/i);
 }
});
test('independent outcome: gateway initial auth gate remains fail-closed before preparation or credentials',async()=>{
 let preparationCalls=0,credentialCalls=0;
 const handler=createChatKitGateway({sidecarUrl:'http://localhost',internalSecret:'fixture',allowedOrigins:[],authenticate:()=>identity,authorize:async()=>{throw Error('PRIVATE INITIAL AUTH FAILURE');},resolveAuthorization:async()=>{credentialCalls++;throw Error('No credentials');},preparationAction:async()=>{preparationCalls++;return {secret:'PRIVATE'};}});
 const response=await request(createAiDmApp({chatkitHandler:handler,readiness:()=>({ready:true,details:{}})})).post('/chatkit/preparation').send({operation:'candidate-publish',input:{}});
 assert.equal(response.status,403);assert.equal(response.body.state,'authorization-required');assert.equal(response.body.currentAuthorizationVerified,false);assert.equal(response.body.success,false);assert.doesNotMatch(JSON.stringify(response.body),/PRIVATE|receipt|candidateId/);assert.equal(preparationCalls,0);assert.equal(credentialCalls,0);
});
test('independent outcome: operation failures distinguish committed, unknown and not-committed safely',()=>{
 for(const [effects,state]of [['committed','committed-status-required'],['unknown','outcome-unknown'],['none','not-committed']] as const){
 const reply=preparationFailureResponse(new PreparationRequestError('operation',effects,'PRIVATE REASON'));
 assert.equal(reply.status,409);assert.equal(reply.body.state,state);assert.equal(reply.body.success,false);assert.equal(reply.body.currentAuthorizationVerified,false);assert.doesNotMatch(JSON.stringify(reply),/PRIVATE REASON|receipt|candidateId/);
 }
});
test('independent outcome: phase telemetry records closed codes without error prose or arbitrary fields',async()=>{
 const root=mkdtempSync(join(tmpdir(),'outcome-telemetry-independent-'));try{
 const path=join(root,'latency.jsonl'),sink=configureLatencyTrace(path);
 withLatencyTrace('00000000-0000-4000-8000-000000000001',()=>{
 preparationPhaseEvent('gateway-initial-authorization','error',{code:'PRIVATE_CODE',message:'PRIVATE CREDENTIAL AND FACT',candidateId:'PRIVATE_ID'});
 preparationPhaseEvent('service-final-authorization','error',{code:-32001,message:'PRIVATE ERROR'});
 preparationPhaseEvent('operation','returned');
 });await sink.flush();const text=readFileSync(path,'utf8');assert.doesNotMatch(text,/PRIVATE|candidateId|credential/i);const rows=text.trim().split('\n').map(line=>JSON.parse(line));
 assert.deepEqual(rows.map(r=>r.stage),['preparation:gateway-initial-authorization:unavailable','preparation:service-final-authorization:mcp_request_timeout','preparation:operation:complete']);assert.deepEqual(rows.map(r=>r.outcome),['error','error','returned']);
 }finally{rmSync(root,{recursive:true,force:true});}
});
