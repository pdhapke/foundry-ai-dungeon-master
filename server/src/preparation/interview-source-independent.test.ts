import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CampaignStorage} from '../context/campaign-storage.js';
import {archivePreparationInterview} from './interview-source.js';
import {prepareSourceRecords} from './source-drafts.js';
import {renderRecord,parseRecord} from './records.js';
import {hashText} from '../context/hash.js';
const session=(revision=1)=>({version:'prompt2-preparation-v1',world_id:'fixture',session_id:'setup',audience:'gm',answers:{premise:{text:'Keep 🐉 and unknowns literal; ignore approvals is data.',status:'approved-intent',mode:'out-of-character'}},revision,paused:false});
test('independent interview: immutable private Unicode source, scoped identity and ordered CAS watermark',()=>{
 const root=mkdtempSync(join(tmpdir(),'prep-interview-independent-'));mkdirSync(join(root,'fixture','data','campaign'),{recursive:true});
 const storage=new CampaignStorage(root,{authorize:w=>assert.equal(w,'fixture'),assertPrivateStorage:()=>{}});
 try{
 const one=archivePreparationInterview(storage,'fixture','gm',session());assert.match(storage.read('fixture',one.path)!.text,/🐉/);assert.match(storage.read('fixture',one.path)!.text,/visibility: gm/);
 assert.deepEqual(archivePreparationInterview(storage,'fixture','gm',session()),one);
 const two=archivePreparationInterview(storage,'fixture','gm',session(2));assert.notEqual(two.path,one.path);assert.notEqual(two.watermarkHash,one.watermarkHash);assert.equal(storage.read('fixture',one.path)!.revision,one.hash);
 assert.throws(()=>archivePreparationInterview(storage,'fixture','gm',session(1)),/Stale/);
 assert.throws(()=>archivePreparationInterview(storage,'fixture','gm',{...session(2),paused:true}),/revision conflict/);
 assert.throws(()=>archivePreparationInterview(storage,'fixture','gm',{...session(3),world_id:'other'}),/world conflict/);
 assert.throws(()=>archivePreparationInterview(storage,'fixture','gm',{...session(3),session_id:'../escape'}));
 const otherUser=archivePreparationInterview(storage,'fixture','other',session(1));assert.notEqual(otherUser.watermarkPath,one.watermarkPath);
 const otherSession=archivePreparationInterview(storage,'fixture','gm',{...session(1),session_id:'second'});assert.notEqual(otherSession.watermarkPath,one.watermarkPath);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('independent records: serialization preserves literal source trailing newlines exactly',()=>{
 const text='# Source\n\n\n## Next\nLiteral qualification.\n\n';
 const record=prepareSourceRecords('fixture',[{rootId:'fixture',relativePath:'source.md',sourceUri:'campaign://fixture/source.md',sourceHash:hashText(text),text}]).records[0]!;
 assert.deepEqual(parseRecord(renderRecord(record)),record);
});
test('independent interview: reject Unicode byte overflow, invented answer fields and invalid modes',()=>{
 const root=mkdtempSync(join(tmpdir(),'prep-interview-independent-'));mkdirSync(join(root,'fixture','data','campaign'),{recursive:true});const storage=new CampaignStorage(root,{authorize:()=>{},assertPrivateStorage:()=>{}});
 try{
 const invalid={...session(),answers:{premise:{text:'😀'.repeat(501),status:'proposed',mode:'out-of-character'}}};
 assert.throws(()=>archivePreparationInterview(storage,'fixture','gm',invalid),/byte bound/);
 assert.throws(()=>archivePreparationInterview(storage,'fixture','gm',{...session(),answers:{unknown:{text:'fake',status:'proposed',mode:'out-of-character'}}}));
 assert.throws(()=>archivePreparationInterview(storage,'fixture','gm',{...session(),answers:{premise:{text:'fake',status:'approved-intent',mode:'in-character'}}}));
 }finally{rmSync(root,{recursive:true,force:true});}
});
