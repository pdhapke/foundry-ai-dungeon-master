import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {inspectLegacyCampaign} from '../server/src/campaign-privacy.ts';
const png=Buffer.from([137,80,78,71,13,10,26,10,0,0]);
function fixture(){const root=mkdtempSync(join(tmpdir(),'legacy-source-inspector-validator-')),worlds=join(root,'worlds'),campaign=join(worlds,'w','data','campaign');mkdirSync(join(campaign,'assets'),{recursive:true});return{root,worlds,campaign,clean:()=>rmSync(root,{recursive:true,force:true})};}
test('extension alone or image location alone never clears public source-copy blocker',()=>{
 for(const [path,data] of [['assets/fake.png',Buffer.from('private source text')],['outside.png',png],['assets/secrets.svg',Buffer.from('<svg>secret</svg>')],['assets/source.json',png],['assets/tool.js',png]]){const f=fixture();try{writeFileSync(join(f.campaign,path as string),data as Buffer);const r=inspectLegacyCampaign(f.worlds,'w');assert.equal(r.ready,false);assert.equal(r.sourceCopies,1);assert.equal(r.publicAssets,0);assert.doesNotMatch(JSON.stringify(r),/private source|secret|\.png|\.svg/);}finally{f.clean();}}
});
test('recognized binary media means source-copy gate only; symlink and unknown directories fail closed',()=>{const f=fixture();try{writeFileSync(join(f.campaign,'assets','preview.png'),png);let r=inspectLegacyCampaign(f.worlds,'w');assert.equal(r.ready,true);assert.equal(r.publicAssets,1);mkdirSync(join(f.campaign,'unused'));assert.equal(inspectLegacyCampaign(f.worlds,'w').ready,false);rmSync(join(f.campaign,'unused'),{recursive:true});symlinkSync(f.worlds,join(f.campaign,'assets','linked'),'junction');r=inspectLegacyCampaign(f.worlds,'w');assert.equal(r.ready,false);assert.ok(r.unsafeArtifacts>0);}finally{f.clean();}});
