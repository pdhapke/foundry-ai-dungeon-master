import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CampaignStorage} from '../context/campaign-storage.js';
import {hashText} from '../context/hash.js';
import {PreparationRecordStore} from './records.js';
import {PreparationPublicationReviews} from './publication-review.js';
import {sourceRecordDraftPackets} from './source-drafts.js';
import {composePreparationCandidates} from './record-composition.js';
const caller={worldId:'fixture',userId:'gm',clientId:'client',isGm:true};
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'prep-records-independent-'));mkdirSync(join(root,'fixture','data','campaign'),{recursive:true});
 const db=new DatabaseSync(':memory:'),hashes=new Map<string,string>();
 const storage=new CampaignStorage(root,{authorize:w=>{assert.equal(w,'fixture');},assertPrivateStorage:()=>{}});
 const reviews=new PreparationPublicationReviews(db,c=>{assert.equal(c.worldId,'fixture');});
 const records=new PreparationRecordStore(storage,(_w,id)=>reviews.assertApproved(caller,id),(_w,uri)=>{if(hashes.has(uri))return hashes.get(uri)!;try{return storage.read('fixture',uri.replace('campaign://fixture/',''))?.revision??null;}catch{return null;}});
 const source=(i:number)=>{const text=`# NPC ${i}\n## Motivation\n${'Evidence with qualifications. '.repeat(120)}\n## Rumor\nUnconfirmed fixture claim.`;const sourceUri=`campaign://fixture/npcs/${i}.md`,sourceHash=hashText(text);hashes.set(sourceUri,sourceHash);return {rootId:'fixture',relativePath:`npcs/${i}.md`,sourceUri,sourceHash,text};};
 return {db,storage,reviews,records,source,hashes,close:()=>{db.close();rmSync(root,{recursive:true,force:true});}};
}
test('independent records: large referenced candidate publishes complete corpus, paginates and preserves active records',()=>{
 const f=fixture();try{
 const prepared=sourceRecordDraftPackets('fixture','packet',Array.from({length:60},(_,i)=>f.source(i)));
 for(const packet of prepared.packets)f.records.stage(packet);
 const composed=composePreparationCandidates(f.records,'fixture','composed',prepared.packets.map(p=>p.candidateId));
 assert.ok(Buffer.byteLength(JSON.stringify(composed))>128000);assert.equal(composed.records.length,62);
 f.records.stage(composed);assert.equal(f.records.candidate('fixture','composed').records.length,62);
 const review=f.reviews.stage(caller,'composed',f.records,f.storage);assert.equal(review.records.length,20);assert.equal(review.continuation,20);
 const second=f.reviews.stage(caller,'composed',f.records,f.storage,20);assert.equal(second.records.length,20);assert.notEqual(second.records[0]!.id,review.records[0]!.id);
 assert.throws(()=>f.reviews.confirm(caller,'composed','canon',review.reviewDigest,'dm',f.records,f.storage),/browser/);
 const confirmed=f.reviews.confirm(caller,'composed','canon',review.reviewDigest,'browser',f.records,f.storage);
 f.reviews.decide(caller,'canon',confirmed.reviewDigest,'approve','browser',f.records,f.storage);
 assert.equal(f.records.active('fixture')!.candidate.records.length,62);
 const extra=sourceRecordDraftPackets('fixture','extra',[f.source(60)]).packets[0]!;f.records.stage(extra);
 const next=composePreparationCandidates(f.records,'fixture','incremental',[extra.candidateId]);
 for(const name of ['overview.md','index.md'])next.manifest[`campaign://fixture/${name}`]=f.storage.read('fixture',name)!.revision;
 assert.equal(next.records.length,63);f.records.stage(next);
 const nextReview=f.reviews.stage(caller,'incremental',f.records,f.storage);assert.equal(nextReview.removedFromActiveCount,0);
 const nextConfirmed=f.reviews.confirm(caller,'incremental','next-canon',nextReview.reviewDigest,'browser',f.records,f.storage);
 const before=f.records.active('fixture')!.revision;
 const id=next.records.find(r=>r.kind==='npc')!.id,path=`preparation/versions/next-canon/${hashText(id)}.md`,old=f.storage.read('fixture',path)!;
 f.storage.commit('fixture',[{path,expectedRevision:old.revision,text:old.text+'\nManual change'}]);
 assert.throws(()=>f.reviews.decide(caller,'next-canon',nextConfirmed.reviewDigest,'approve','browser',f.records,f.storage),/revision conflict/);
 assert.equal(f.records.active('fixture')!.revision,before);
 }finally{f.close();}
});
test('independent records: composition resolves only explicit selected links and flags alias collisions',()=>{
 const f=fixture();try{
 const source=(path:string,text:string)=>{const sourceUri=`campaign://fixture/${path}`,sourceHash=hashText(text);f.hashes.set(sourceUri,sourceHash);return{rootId:'fixture',relativePath:path,sourceUri,sourceHash,text};};
 const a=source('npcs/a.md','---\nid: NPC-A\naliases: ["Guide", "Élan"]\n---\n# A\n[Known place](../places/b.md)\n[Foreign](campaign://other/places/b.md)\n[Escape](../../outside.md)');
 const b=source('places/b.md','---\nid: PLACE-B\naliases: ["guide"]\n---\n# B\nAn authored place.');
 const pa=sourceRecordDraftPackets('fixture','a',[a]).packets[0]!,pb=sourceRecordDraftPackets('fixture','b',[b]).packets[0]!;f.records.stage(pa);f.records.stage(pb);
 const composed=composePreparationCandidates(f.records,'fixture','linked',[pa.candidateId,pb.candidateId]);
 const ra=composed.records.find(r=>r.sources[0]?.uri===a.sourceUri&&r.id.startsWith('source-'))!,rb=composed.records.find(r=>r.sources[0]?.uri===b.sourceUri&&r.id.startsWith('source-'))!;
 assert.ok(ra.aliases.includes('NPC-A'));assert.ok(ra.aliases.includes('Élan'));assert.ok(!ra.aliases.includes('Guide'));assert.ok(!rb.aliases.includes('guide'));
 assert.deepEqual(ra.relationships,[{id:rb.id,relation:'source-reference'}]);assert.match(ra.contradictions.join(' '),/Ambiguous authored alias/);assert.match(ra.unknowns.join(' '),/campaign:\/\/other/);assert.match(ra.unknowns.join(' '),/outside.md/);
 assert.ok(ra.sources.some(ref=>ref.startLine===1&&ref.endLine===4));
 }finally{f.close();}
});
test('independent records: interrupted large staging resumes immutable batches before exposing candidate',()=>{
 const f=fixture();try{
 const prepared=sourceRecordDraftPackets('fixture','packet',Array.from({length:60},(_,i)=>f.source(i)));for(const packet of prepared.packets)f.records.stage(packet);
 const candidate=composePreparationCandidates(f.records,'fixture','interrupted',prepared.packets.map(p=>p.candidateId));
 const commit=f.storage.commit.bind(f.storage);let calls=0;
 f.storage.commit=(...args)=>{const receipt=commit(...args);if(++calls===1)throw Error('Fixture interruption after durable batch');return receipt;};
 assert.throws(()=>f.records.stage(candidate),/interruption/);assert.throws(()=>f.records.candidate('fixture','interrupted'));
 f.storage.commit=commit;f.records.stage(candidate);assert.equal(f.records.candidate('fixture','interrupted').records.length,62);assert.equal(f.records.active('fixture'),null);
 }finally{f.close();}
});
