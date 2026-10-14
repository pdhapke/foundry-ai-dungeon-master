import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, rmdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectLegacyCampaign } from './campaign-privacy.js';
function fixture(){const root=mkdtempSync(join(tmpdir(),'privacy-source-')),worlds=join(root,'worlds'),campaign=join(worlds,'w','data','campaign');mkdirSync(campaign,{recursive:true});return{root,worlds,campaign,clean:()=>rmSync(root,{recursive:true,force:true})};}
const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
test('asset-only legacy tree permits source-copy gate without asserting image secrecy',()=>{
 const f=fixture();try{mkdirSync(join(f.campaign,'assets','maps'),{recursive:true});writeFileSync(join(f.campaign,'assets','maps','map.png'),png);const r=inspectLegacyCampaign(f.worlds,'w');assert.equal(r.ready,true);assert.equal(r.publicAssets,1);assert.equal(r.sourceCopies,0);}finally{f.clean();}
});
test('authored files, receipts, unknown files, SVG and incorrectly located media keep source gate closed',()=>{
 for(const path of ['overview.md','state.json','tool.js','.receipt-abc.json','assets/map.svg','assets/map.bin','map.png','assets/fake.png']){
  const f=fixture();try{mkdirSync(join(f.campaign,'assets'));writeFileSync(join(f.campaign,...path.split('/')),path==='map.png'?png:'private authored data');const r=inspectLegacyCampaign(f.worlds,'w');assert.equal(r.ready,false,path);assert.equal(r.sourceCopies,1,path);}finally{f.clean();}
 }
});
test('unexpected empty directories, links and bounded traversal overflow fail closed',()=>{
 const f=fixture();try{mkdirSync(join(f.campaign,'npcs'));assert.equal(inspectLegacyCampaign(f.worlds,'w').ready,false);rmdirSync(join(f.campaign,'npcs'));mkdirSync(join(f.campaign,'assets'));symlinkSync(join(f.root,'worlds'),join(f.campaign,'assets','link'),process.platform==='win32'?'junction':'dir');assert.equal(inspectLegacyCampaign(f.worlds,'w').ready,false);rmdirSync(join(f.campaign,'assets','link'));let p=join(f.campaign,'assets');for(let i=0;i<13;i++){p=join(p,'deep');mkdirSync(p);}assert.equal(inspectLegacyCampaign(f.worlds,'w').ready,false);}finally{f.clean();}
});
test('absent legacy source and invalid world identifier are distinguished',()=>{
 const f=fixture();try{assert.equal(inspectLegacyCampaign(f.worlds,'missing').ready,true);assert.equal(inspectLegacyCampaign(f.worlds,'../other').ready,false);}finally{f.clean();}
});
