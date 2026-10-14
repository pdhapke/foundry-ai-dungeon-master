import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {stageReviewedCandidate} from './preparation-stage-reviewed-candidate.mjs';
test('actual complete corrected review stages through bounded private batches without publishing',()=>{
 const runtime=resolve('../../../../.runtime/foundry-ai-dungeon-master'),original=JSON.parse(readFileSync(join(runtime,'preparation-reviews/izzy-campaign/prompt2-v5-consolidated-review-20261004/candidate.json'),'utf8'));
 const base=mkdtempSync(join(tmpdir(),'reviewed-stage-')),protectedRoot=join(base,'private'),publicDataRoot=join(base,'Data'),campaign=join(protectedRoot,'fixture/data/campaign');mkdirSync(campaign,{recursive:true});mkdirSync(publicDataRoot);
 try{
  const candidate=JSON.parse(JSON.stringify(original).replaceAll('campaign://izzy-campaign/','campaign://fixture/'));candidate.worldId='fixture';for(const record of candidate.records)record.worldId='fixture';
  for(const uri of Object.keys(candidate.manifest)){const path=uri.slice('campaign://fixture/'.length),target=join(campaign,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,readFileSync(join(runtime,'campaign-worlds/izzy-campaign/data/campaign',path)));}
  const text=JSON.stringify(candidate),digest=createHash('sha256').update(text).digest('hex'),options={protectedRoot,publicDataRoot,worldId:'fixture',authorize:world=>assert.equal(world,'fixture')};
  assert.throws(()=>stageReviewedCandidate(options,text,'0'.repeat(64)),/digest/);
  const result=stageReviewedCandidate(options,text,digest);assert.equal(result.recordCount,136);assert.equal(result.publicationApproved,false);
  for(const path of ['overview.md','index.md','preparation/active.md'])assert.equal(existsSync(join(campaign,path)),false);
  assert.equal(stageReviewedCandidate(options,text,digest).candidateId,candidate.candidateId);
  assert.throws(()=>stageReviewedCandidate({...options,authorize:()=>{throw Error('denied');}},text,digest),/denied/);
 }finally{rmSync(base,{recursive:true,force:true});}
});
