import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CampaignStorage } from '../context/campaign-storage.js';
import { PreparationRecordStore, type CampaignRecord } from './records.js';
import { PreparationPublicationReviews } from './publication-review.js';
const caller={worldId:'fixture',userId:'gm',clientId:'client',isGm:true};
function fixture() {
 const root=mkdtempSync(join(tmpdir(),'publication-review-')); mkdirSync(join(root,'fixture','data','campaign'),{recursive:true});
 const db=new DatabaseSync(':memory:'); let source='a'.repeat(64), authorized=true;
 const storage=new CampaignStorage(root,{authorize:w=>{if(w!=='fixture'||!authorized)throw Error('Denied');},assertPrivateStorage:()=>{}});
 const queue=new PreparationPublicationReviews(db,c=>{if(!authorized||c.worldId!=='fixture')throw Error('Denied');});
 const records=new PreparationRecordStore(storage,(w,id)=>{assert.equal(w,caller.worldId);queue.assertApproved(caller,id);},()=>source);
 const record=(kind:'overview'|'index'):CampaignRecord=>({schemaVersion:1,id:kind,worldId:'fixture',kind,title:kind,aliases:[],revision:1,visibility:'gm',status:'confirmed',epistemic:'established',sources:[{uri:'campaign://fixture/source.md',hash:source,startLine:1,endLine:2}],relationships:[],sections:[{heading:'Source',text:'Fixture source evidence.'}],unknowns:[],contradictions:[],generated:false});
 records.stage({schemaVersion:1,worldId:'fixture',candidateId:'candidate',records:[record('overview'),record('index')],manifest:{'campaign://fixture/source.md':source},baseRevision:null});
 return {queue,records,storage,db,drift:()=>{source='b'.repeat(64);},revoke:()=>{authorized=false;},close:()=>{db.close();rmSync(root,{recursive:true,force:true});}};
}
test('only exact authenticated browser approval publishes and replay is idempotent',()=>{
 const f=fixture();try{
 const review=f.queue.stage(caller,'candidate',f.records,f.storage);
 assert.throws(()=>f.records.publish('fixture','candidate'));
 assert.throws(()=>f.queue.decide(caller,'candidate',review.reviewDigest,'approve','dm',f.records,f.storage));
 assert.throws(()=>f.queue.decide(caller,'candidate','0'.repeat(64),'approve','browser',f.records,f.storage));
 assert.throws(()=>f.queue.decide({...caller,userId:'other'},'candidate',review.reviewDigest,'approve','browser',f.records,f.storage));
 const result=f.queue.decide(caller,'candidate',review.reviewDigest,'approve','browser',f.records,f.storage);
 assert.equal(result.status,'completed');assert.equal(f.records.active('fixture')?.candidate.candidateId,'candidate');
 assert.deepEqual(f.queue.decide(caller,'candidate',review.reviewDigest,'approve','browser',f.records,f.storage),result);
 }finally{f.close();}
});
test('source edits, canonical manual edits and authorization revocation fail closed',()=>{
 for(const failure of ['source','manual','revoke']){const f=fixture();try{
 const r=f.queue.stage(caller,'candidate',f.records,f.storage);
 if(failure==='source')f.drift();else if(failure==='revoke')f.revoke();else f.storage.commit('fixture',[{path:'overview.md',expectedRevision:null,text:'Manual overview.'}]);
 assert.throws(()=>f.queue.decide(caller,'candidate',r.reviewDigest,'approve','browser',f.records,f.storage));
 if(failure!=='revoke')assert.equal(f.records.active('fixture'),null);
 }finally{f.close();}}
});
test('interrupted SQL completion recovers the matching durable file receipt without republishing',()=>{
 const f=fixture();try{
 const r=f.queue.stage(caller,'candidate',f.records,f.storage);
 const actual=f.records.publish.bind(f.records);let once=true;
 f.records.publish=(w,id)=>{const result=actual(w,id);if(once){once=false;throw Error('interrupted after durable files');}return result;};
 assert.throws(()=>f.queue.decide(caller,'candidate',r.reviewDigest,'approve','browser',f.records,f.storage));
 const before=f.records.active('fixture')?.revision;
 assert.equal(f.queue.decide(caller,'candidate',r.reviewDigest,'approve','browser',f.records,f.storage).status,'completed');
 assert.equal(f.records.active('fixture')?.revision,before);
 }finally{f.close();}
});
