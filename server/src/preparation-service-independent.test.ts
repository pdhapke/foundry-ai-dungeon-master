import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PreparationService} from './preparation-service.js';
import {hashText} from './context/hash.js';
import type {AiDmAuthenticatedIdentity} from '@foundry-ai-dungeon-master/shared';
import {FilePreparationJobStore,SqlitePreparationJobStore,type PreparationJob} from './preparation-jobs/index.js';
import {NativePreparationReviewQueue} from './preparation-jobs/native-adapter.js';
import type {FoundryLocalApiMcpClient} from './tool-catalog/index.js';
import {worldSourceRevision} from './chatkit/world-document-actions.js';
const identity={worldId:'fixture',userId:'gm',clientId:'client',isGm:true} as AiDmAuthenticatedIdentity;
async function executeResult(service:PreparationService,operation:string,input:Record<string,unknown>,origin:'browser'|'dm'='dm'){
 return (await service.execute(identity,{operation,input},new AbortController().signal,origin) as unknown as {result:Record<string,unknown>}).result;
}
function fixture(mcpClient?:FoundryLocalApiMcpClient,fetch?:typeof globalThis.fetch){
 const root=mkdtempSync(join(tmpdir(),'prep-service-independent-')),privateRoot=join(root,'private'),publicRoot=join(root,'Data'),campaign=join(privateRoot,'fixture','data','campaign');mkdirSync(campaign,{recursive:true});mkdirSync(publicRoot);
 const text='# Source\n## Premise\nOnly at dawn.\n### Qualification\nNot otherwise.\n## Secret\nGM fixture secret.';writeFileSync(join(campaign,'source.md'),text);
 const db=new DatabaseSync(':memory:');let authorized=true;
 const service=new PreparationService({worldsRoot:join(publicRoot,'worlds'),protectedCampaign:{protectedRoot:privateRoot,publicDataRoot:publicRoot},jobsRoot:join(root,'jobs'),database:db,...(mcpClient?{mcpClient}:{}),...(fetch?{fetch}:{}),sidecarUrl:'http://localhost',internalSecret:'fixture',assertPrivateStorage:()=>{},authorize:async(c,s)=>{s.throwIfAborted();if(!authorized||c.worldId!=='fixture'||c.clientId!=='client')throw Error('denied');}});
 return {service,text,campaign,publicRoot,root,db,revoke:()=>{authorized=false;},close:()=>{db.close();rmSync(root,{recursive:true,force:true});}};
}
test('independent service: source inventory survives prior request abort and revocation fails closed',async()=>{
 const f=fixture();try{const old=new AbortController();await f.service.execute(identity,{operation:'source-inventory',input:{}},old.signal);old.abort();
 const next=await f.service.execute(identity,{operation:'source-inventory',input:{}},new AbortController().signal);assert.match(JSON.stringify(next),/source.md/);
 f.revoke();await assert.rejects(f.service.execute(identity,{operation:'source-inventory',input:{}},new AbortController().signal));
 }finally{f.close();}
});
test('independent service: cancellation during an actual MCP await fences subsequent dispatch',async()=>{
 let started!:()=>void,release!:()=>void,writes=0;
 const entered=new Promise<void>(r=>{started=r;}),blocked=new Promise<void>(r=>{release=r;});
 const client={listTools:async()=>['foundry_get_world_document','foundry_apply_world_document'].map(name=>({name,inputSchema:{type:'object',additionalProperties:true}})),callTool:async(request:{name:string;arguments:Record<string,unknown>})=>{
 if(request.name==='foundry_apply_world_document'){writes++;throw Error('Unexpected mutation');}
 started();await blocked;const args=request.arguments;return {worldId:args.worldId,family:args.family,targetId:args.targetId,parentId:args.parentId,source:null,revision:worldSourceRevision(null)};
 }} as unknown as FoundryLocalApiMcpClient;
 const f=fixture(client);try{
 const job={version:1,id:'racejob',input:{worldId:'fixture',requestId:'request',areaIds:['area'],sourceRevisions:{},depth:'encounter',maxAreas:1,desiredReadiness:'population'},revision:3,state:'needs-review',stages:{area:{digest:'a',proposals:[{id:'area',title:'Fixture'}]},map:{digest:'m',proposals:[{areaId:'area',width:1000,height:1000,assetRef:'fixture.png',grid:{originX:0,originY:0,size:100,distance:5,units:'ft'}}]},population:{digest:'p',proposals:[{areaId:'area',tokens:[],gmNoteRecordIds:[],traps:[]}]}},readiness:{records:true,map:true,population:true,visibility:false,trapMechanics:false,liveAccepted:false},warnings:[],spending:{requests:0,generationExecuted:false}} as PreparationJob;
 mkdirSync(join(f.root,'jobs'));job.revision=1;const store=new SqlitePreparationJobStore(f.db);store.write(job,null);
 const queue=new NativePreparationReviewQueue(f.db,{authorize:()=>{},assertPrivateStorage:()=>{},currentSourceRevisions:()=>({}),authorizeHumanReview:()=>{}});const pkg=queue.stage({worldId:'fixture',isGm:true},job,'area');
 const approved=await f.service.execute(identity,{operation:'job-native-review',input:{jobId:job.id,packageId:pkg.id,reviewDigest:pkg.digest,decision:'approve'}},new AbortController().signal,'browser') as unknown as {result:{approvalId:string}};
 const running=f.service.execute(identity,{operation:'job-native-apply',input:{jobId:job.id,packageId:pkg.id,approvalId:approved.result.approvalId}},new AbortController().signal,'browser');
 const settled=running.then(value=>({value}),error=>({error}));
 await entered;store.write({...job,revision:2,state:'cancelled'},1);release();const outcome=await settled;
 assert.equal(writes,0);if('value'in outcome)assert.match(JSON.stringify(outcome.value),/partial-or-needs-review/);else assert.match(String(outcome.error),/job changed/);
 }finally{release();f.close();}
});
test('independent service: valid native package needs exact browser review and rejects changed jobs',async()=>{
 const f=fixture();try{
 const job={version:1,id:'job',input:{worldId:'fixture',requestId:'request',areaIds:['area'],sourceRevisions:{},depth:'encounter',maxAreas:1,desiredReadiness:'population'},revision:3,state:'needs-review',stages:{area:{digest:'a',proposals:[{id:'area',title:'Fixture'}]},map:{digest:'m',proposals:[{areaId:'area',width:1000,height:1000,assetRef:'fixture.png',grid:{originX:0,originY:0,size:100,distance:5,units:'ft'}}]},population:{digest:'p',proposals:[{areaId:'area',tokens:[],gmNoteRecordIds:[],traps:[]}]}},readiness:{records:true,map:true,population:true,visibility:false,trapMechanics:false,liveAccepted:false},warnings:[],spending:{requests:0,generationExecuted:false}} as PreparationJob;
 mkdirSync(join(f.root,'jobs'));const store=new FilePreparationJobStore({protectedRoot:join(f.root,'jobs'),publicDataRoot:f.publicRoot});store.write(job,null);
 const queue=new NativePreparationReviewQueue(f.db,{authorize:()=>{},assertPrivateStorage:()=>{},currentSourceRevisions:()=>({}),authorizeHumanReview:()=>{}});
 const pkg=queue.stage({worldId:'fixture',isGm:true},job,'area');
 const raw={operation:'job-native-review',input:{jobId:'job',packageId:pkg.id,reviewDigest:pkg.digest,decision:'approve'}};
 await assert.rejects(f.service.execute(identity,raw,new AbortController().signal,'dm'),/browser/);
 const approved=await f.service.execute(identity,raw,new AbortController().signal,'browser');assert.match(JSON.stringify(approved),/applied":false/);
 const changed={...job,revision:4,state:'cancelled' as const};new SqlitePreparationJobStore(f.db,store).write(changed,3);
 await assert.rejects(f.service.execute(identity,raw,new AbortController().signal,'browser'),/job changed/);
 }finally{f.close();}
});
test('independent service: bounded record preparation stages complete private drafts without canon',async()=>{
 const f=fixture();try{const request={operation:'record-prepare',input:{candidateId:'review',sources:[{path:'source.md',expectedRevision:hashText(f.text)}]}};
 const result=await f.service.execute(identity,request,new AbortController().signal);assert.match(JSON.stringify(result),/private-record-drafts/);assert.match(JSON.stringify(result),/publicationApproved":false/);
 assert.equal(existsSync(join(f.campaign,'overview.md')),false);assert.equal(existsSync(join(f.campaign,'index.md')),false);assert.equal(existsSync(join(f.publicRoot,'worlds','fixture')),false);
 writeFileSync(join(f.campaign,'source.md'),'Changed source');await assert.rejects(f.service.execute(identity,request,new AbortController().signal),/revision conflict/);
 await assert.rejects(f.service.execute({...identity,isGm:false},request,new AbortController().signal));
 }finally{f.close();}
});
test('independent service: DM cannot grant publication or public asset approval',async()=>{
 const f=fixture();try{
 await assert.rejects(f.service.execute(identity,{operation:'candidate-publish',input:{candidateId:'review',reviewDigest:'a'.repeat(64),decision:'approve'}},new AbortController().signal,'dm'),/browser/);
 await assert.rejects(f.service.execute(identity,{operation:'map-local-import',input:{}},new AbortController().signal,'dm'),/browser/);
 for(const operation of ['job-native-review','job-native-apply'])await assert.rejects(f.service.execute(identity,{operation,input:{jobId:'job',packageId:'a'.repeat(64),decision:'approve',approvalId:'fake'}},new AbortController().signal,'dm'));
 assert.equal(existsSync(join(f.publicRoot,'ai-dm-prepared-maps')),false);
 }finally{f.close();}
});
test('independent service: current source spans and metadata-invalidated retrieval survive aborted requests',async()=>{
 const f=fixture();try{
 const span=await executeResult(f.service,'source-read',{path:'source.md',startLine:3,endLine:5});assert.equal(span.sourceUri,'campaign://fixture/source.md');assert.equal(span.revision,hashText(f.text));assert.match(JSON.stringify(span.span),/Only at dawn/);
 await assert.rejects(executeResult(f.service,'source-read',{path:'../other.md'}));
 await executeResult(f.service,'record-prepare',{candidateId:'cache',sources:[{path:'source.md',expectedRevision:hashText(f.text)}]});
 const review=await executeResult(f.service,'candidate-review',{candidateId:'cache-1'});
 const confirmed=await executeResult(f.service,'candidate-confirm',{candidateId:'cache-1',newCandidateId:'cache-canon',reviewDigest:review.reviewDigest},'browser');
 await executeResult(f.service,'candidate-publish',{candidateId:'cache-canon',reviewDigest:confirmed.reviewDigest,decision:'approve'},'browser');
 const old=new AbortController();await f.service.execute(identity,{operation:'records-search',input:{query:'dawn'}},old.signal);old.abort();
 const id=`source-${hashText('campaign://fixture/source.md').slice(0,24)}`;
 assert.match(JSON.stringify(await executeResult(f.service,'record-read',{id})),/Only at dawn/);
 const revisions=await executeResult(f.service,'record-revisions',{ids:[id,'unknown']});assert.match(String((revisions.revisions as Record<string,unknown>)[id]),/^[a-f0-9]{64}$/);assert.equal((revisions.revisions as Record<string,unknown>).unknown,null);
 const path=join(f.campaign,'preparation','versions','cache-canon',`${hashText(id)}.md`);writeFileSync(path,'Manual altered private record');
 await assert.rejects(executeResult(f.service,'records-search',{query:'dawn'}),/revision conflict/);
 }finally{f.close();}
});
test('independent service: interview updates invalidate already confirmed preparation via watermark',async()=>{
 let revision=1;const snapshot=()=>({version:'prompt2-preparation-v1',world_id:'fixture',session_id:'setup',audience:'gm',answers:{premise:{text:`User desired 🐉 premise ${revision}`,status:'approved-intent',mode:'out-of-character'}},revision,paused:false});
 const fetch:typeof globalThis.fetch=async()=>new Response(JSON.stringify({session:snapshot()}));
 const f=fixture(undefined,fetch);try{
 const result=await executeResult(f.service,'record-prepare',{candidateId:'interview',sources:[],interviewSessionId:'setup'});assert.equal(result.sourceCount,1);assert.equal(existsSync(join(f.campaign,'overview.md')),false);
 const review=await executeResult(f.service,'candidate-review',{candidateId:'interview-1'});
 const confirmed=await executeResult(f.service,'candidate-confirm',{candidateId:'interview-1',newCandidateId:'interview-canon',reviewDigest:review.reviewDigest},'browser');
 revision=2;await executeResult(f.service,'interview',{sessionId:'setup',operation:'answer',questionId:'premise',text:'Changed desired premise',approved:true,expectedRevision:1},'browser');
 await assert.rejects(executeResult(f.service,'candidate-publish',{candidateId:'interview-canon',reviewDigest:confirmed.reviewDigest,decision:'approve'},'browser'),/Source revision conflict/);
 assert.equal(existsSync(join(f.campaign,'overview.md')),false);
 }finally{f.close();}
});
test('independent service: changed interview intent invalidates published-source job revisions',async()=>{
 let revision=1;const fetch:typeof globalThis.fetch=async()=>new Response(JSON.stringify({session:{version:'prompt2-preparation-v1',world_id:'fixture',session_id:'setup',audience:'gm',answers:{premise:{text:`Desired premise ${revision}`,status:'approved-intent',mode:'out-of-character'}},revision,paused:false}}));
 const f=fixture(undefined,fetch);try{
 mkdirSync(join(f.root,'jobs'));
 await executeResult(f.service,'record-prepare',{candidateId:'job-interview',sources:[],interviewSessionId:'setup'});
 const review=await executeResult(f.service,'candidate-review',{candidateId:'job-interview-1'});
 const confirmed=await executeResult(f.service,'candidate-confirm',{candidateId:'job-interview-1',newCandidateId:'job-interview-canon',reviewDigest:review.reviewDigest},'browser');
 await executeResult(f.service,'candidate-publish',{candidateId:'job-interview-canon',reviewDigest:confirmed.reviewDigest,decision:'approve'},'browser');
 const id=(confirmed.records as {id:string}[]).find(r=>r.id.startsWith('source-'))!.id;
 const revisions=await executeResult(f.service,'record-revisions',{ids:[id]});
 const job=await executeResult(f.service,'job-create',{worldId:'fixture',requestId:'interview-job',areaIds:[id],sourceRevisions:revisions.revisions,depth:'outline',maxAreas:1,desiredReadiness:'records'});
 revision=2;await executeResult(f.service,'interview',{sessionId:'setup',operation:'answer',questionId:'premise',text:'New user intent',approved:true,expectedRevision:1},'browser');
 await assert.rejects(executeResult(f.service,'job-resume',{jobId:job.id}),/Source revision conflict/);
 }finally{f.close();}
});
test('independent service: mismatched interview identity is rejected before source staging',async()=>{
 const fetch:typeof globalThis.fetch=async()=>new Response(JSON.stringify({session:{version:'prompt2-preparation-v1',world_id:'other',session_id:'other-session',audience:'gm',answers:{},revision:0,paused:false}}));
 const f=fixture(undefined,fetch);try{
 await assert.rejects(executeResult(f.service,'record-prepare',{candidateId:'bad',sources:[],interviewSessionId:'setup'}),/identity conflict/);
 assert.equal(existsSync(join(f.campaign,'preparation')),false);
 }finally{f.close();}
});
