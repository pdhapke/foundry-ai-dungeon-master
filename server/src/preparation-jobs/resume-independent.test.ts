import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DurableNativePreparationComposer, type NativeStepReceipt } from './durable-native.js';
import type { NativePreparationReviewPackage } from './native-adapter.js';
import { prepareSourceRecords, sourceRecordDraftPackets } from '../preparation/source-drafts.js';
import { hashText } from '../context/hash.js';
import { importApprovedLocalMapAsset } from './local-asset-import.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ExistingWorldDocumentPreparationTransport } from './world-native-transport.js';
import { worldSourceRevision } from '../chatkit/world-document-actions.js';

function fixture() {
 const db=new DatabaseSync(':memory:'); let writes=0, deleted=false;
 const receipts=new Map<string,NativeStepReceipt>();
 const pkg={id:'f'.repeat(64),digest:'original',worldId:'fixture',state:'reviewed',sourceRevisions:{source:'v1'},sceneRequest:{args:{data:{active:false,navigation:false,tokens:[{actorId:'actor',actorLink:false}]}}}} as unknown as NativePreparationReviewPackage;
 const composer=new DurableNativePreparationComposer(db,{authorize:()=>{},assertPrivateStorage:()=>{},currentSourceRevisions:()=>({source:'v1'}),authorizeHumanReview:()=>{}},{
 recover:async step=>deleted&&step.toolId==='foundry_create_scene_token'?undefined:receipts.get(step.id),
 apply:async step=>{writes++;const r={verified:true,worldId:'fixture',targetId:step.toolId==='foundry_create_scene'?'scene':'token',revision:'v1',receiptId:step.id};receipts.set(step.id,r);return r;},
 inspectScene:async()=>({worldId:'fixture',active:false,revision:'v1',preparationId:pkg.id})});
 return {db,pkg,composer,writes:()=>writes,deleteToken:()=>{deleted=true;}};
}
const caller={worldId:'fixture',isGm:true};
test('independent: persisted native package cannot be silently replaced under the same ID',async()=>{
 const f=fixture();try{await f.composer.compose(caller,f.pkg,'human');
 const changed=structuredClone(f.pkg);changed.digest='changed';
 await assert.rejects(f.composer.compose(caller,changed,'human'));
 assert.equal(f.writes(),2);
 }finally{f.db.close();}
});
test('independent: completed replay revalidates previously created token existence',async()=>{
 const f=fixture();try{await f.composer.compose(caller,f.pkg,'human');f.deleteToken();
 await assert.rejects(f.composer.compose(caller,f.pkg,'human'));
 }finally{f.db.close();}
});
test('independent: inventory retains complete private content and packet provenance',()=>{
 const sources=Array.from({length:30},(_,i)=>{const text=`# Source ${i}\n## Premise\nOnly if the gate opens.\n### Qualification\nRumor, not confirmed.\n## Secret\nPrivate clue ${i}`;return {rootId:'fixture',relativePath:`npcs/${i}.md`,sourceUri:`campaign://fixture/npcs/${i}.md`,sourceHash:hashText(text),text};});
 const result=sourceRecordDraftPackets('fixture','review',sources);
 assert.equal(result.inventory.length,30);assert.equal(result.packets.length,2);
 for(const r of result.records){assert.equal(r.visibility,'gm');assert.equal(r.status,'draft');assert.match(r.sections.map(s=>s.text).join('\n'),/Private clue/);assert.match(r.sections[1]!.text,/Qualification/);}
 for(const p of result.packets)for(const r of p.records)for(const ref of r.sources)assert.equal(p.manifest[ref.uri],ref.hash);
 assert.throws(()=>prepareSourceRecords('other',sources));
});
test('independent: local import publishes only reviewed bytes despite source replacement',()=>{
 const root=mkdtempSync(join(tmpdir(),'prep-independent-'));
 try{
 const sources=join(root,'approved'),publicRoot=join(root,'public');mkdirSync(sources);mkdirSync(publicRoot);
 const source=join(sources,'map.png'),bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2]);writeFileSync(source,bytes);
 const sourceHash=createHash('sha256').update(bytes).digest('hex');let checks=0;
 const result=importApprovedLocalMapAsset({worldId:'fixture',sourcePath:source,sourceHash,license:'fixture-only',playerVisibleApproved:true},{worldId:'fixture',approvedSourceRoot:sources,publicAssetRoot:publicRoot,publicUrlPrefix:'worlds/fixture/assets',authorize:()=>{checks++;if(checks===2)writeFileSync(source,'PRIVATE REPLACEMENT');}});
 assert.equal(result.sourceHash,sourceHash);assert.deepEqual(readFileSync(join(publicRoot,readdirSync(publicRoot)[0]!)),bytes);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('independent: stale or unauthorized assets never enter public fixture storage',()=>{
 const root=mkdtempSync(join(tmpdir(),'prep-independent-'));try{
 const source=join(root,'map.png'),pub=join(root,'public');mkdirSync(pub);writeFileSync(source,'PRIVATE');
 const input={worldId:'fixture',sourcePath:source,sourceHash:'0'.repeat(64),license:'fixture',playerVisibleApproved:true as const};
 const config={worldId:'fixture',approvedSourceRoot:root,publicAssetRoot:pub,publicUrlPrefix:'assets',authorize:()=>{}};
 assert.throws(()=>importApprovedLocalMapAsset(input,config));
 assert.throws(()=>importApprovedLocalMapAsset({...input,worldId:'other'},config));
 assert.throws(()=>importApprovedLocalMapAsset(input,{...config,authorize:()=>{throw Error('revoked');}}));
 assert.deepEqual(readdirSync(pub),[]);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('independent: native transport uses scoped CAS primitives and separate readback',async()=>{
 let source:unknown=null;const calls:{name:string,args:Record<string,unknown>}[]=[];let auth=0;
 const transport=new ExistingWorldDocumentPreparationTransport({worldId:'fixture',userId:'gm',authorize:async()=>{auth++;},call:async(name,args)=>{
 calls.push({name,args});if(name==='foundry_apply_world_document'){assert.equal(args.expectedRevision,null);assert.equal(args.operation,'create');source=args.data;return {verified:true,correlationId:args.correlationId,idempotencyKey:args.idempotencyKey,revision:worldSourceRevision(source)};}
 return {worldId:args.worldId,family:args.family,targetId:args.targetId,parentId:args.parentId,source,revision:worldSourceRevision(source)};
 }});
 const step={id:'step-1',toolId:'foundry_create_scene',args:{data:{active:false,flags:{'foundry-ai-dungeon-master':{preparationId:'pkg'}}}},expectedRevision:null,preparationId:'pkg'};
 assert.equal((await transport.apply(step)).verified,true);
 assert.deepEqual(calls.map(c=>c.name),['foundry_get_world_document','foundry_apply_world_document','foundry_get_world_document']);
 assert.ok(auth>=5);await transport.apply(step);assert.equal(calls.filter(c=>c.name==='foundry_apply_world_document').length,1);
 await assert.rejects(transport.apply({...step,toolId:'foundry_delete_scene'}));
});
test('independent: forged native readback scope cannot be recovered',async()=>{
 const transport=new ExistingWorldDocumentPreparationTransport({worldId:'fixture',userId:'gm',authorize:async()=>{},call:async()=>({worldId:'other',family:'scenes',targetId:'forged',source:null,revision:worldSourceRevision(null)})});
 await assert.rejects(transport.recover({id:'step',toolId:'foundry_create_scene',args:{data:{active:false}},expectedRevision:null,preparationId:'pkg'}),/scope/);
});
test('independent: a job cancelled during an awaited native write cannot dispatch the next step',async()=>{
 const db=new DatabaseSync(':memory:');let cancelled=false,writes=0;
 const pkg={id:'c'.repeat(64),digest:'review',worldId:'fixture',state:'reviewed',sourceRevisions:{},sceneRequest:{args:{data:{active:false,tokens:[{actorId:'actor'}]}}}} as unknown as NativePreparationReviewPackage;
 const composer=new DurableNativePreparationComposer(db,{authorize:()=>{if(cancelled)throw Error('Native preparation job changed');},assertPrivateStorage:()=>{},currentSourceRevisions:()=>({}),authorizeHumanReview:()=>{}},{recover:async()=>undefined,apply:async step=>{writes++;await Promise.resolve();cancelled=true;return {verified:true,worldId:'fixture',targetId:'scene',revision:'v1',receiptId:step.id};},inspectScene:async()=>({worldId:'fixture',active:false,revision:'v1',preparationId:pkg.id})});
 try{await assert.rejects(composer.compose(caller,pkg,'human'),/job changed/);assert.equal(writes,1);cancelled=false;assert.equal(composer.status(caller,pkg.id)?.state,'partial');assert.equal(composer.status(caller,pkg.id)?.readiness.population,false);}finally{db.close();}
});
