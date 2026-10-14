import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {captureFirstPublicationBaseline,rollbackFirstPublication} from './preparation-first-publication-rollback.mjs';
const paths=['overview.md','index.md','preparation/active.md'];
function fixture(){
 const base=mkdtempSync(join(tmpdir(),'rollback-independent-')),protectedRoot=join(base,'private'),publicDataRoot=join(base,'Data'),root=join(protectedRoot,'fixture','data','campaign');mkdirSync(join(root,'preparation'),{recursive:true});mkdirSync(publicDataRoot);
 const options={protectedRoot,publicDataRoot,worldId:'fixture',operationId:'operator',authorize:()=>{}},baseline=captureFirstPublicationBaseline(options),expected={};
 for(const path of paths){const text=`PRIVATE FIXTURE ${path}`;writeFileSync(join(root,path),text);expected[path]=createHash('sha256').update(text).digest('hex');}
 return {base,root,options,baseline,expected,publicDataRoot,close:()=>rmSync(base,{recursive:true,force:true})};
}
test('independent rollback: unsafe archive redirect cannot move secrets or strand an owned lock',()=>{
 const f=fixture();try{
 symlinkSync(f.publicDataRoot,join(f.root,'preparation','first-publication-rollbacks'),'junction');
 assert.throws(()=>rollbackFirstPublication(f.options,f.baseline,f.expected),/Redirected/);
 for(const path of paths)assert.equal(readFileSync(join(f.root,path),'utf8'),`PRIVATE FIXTURE ${path}`);
 assert.equal(existsSync(join(f.publicDataRoot,'operator')),false);
 assert.equal(existsSync(join(f.root,'.write-lock')),false);
 }finally{f.close();}
});
test('independent rollback: failed compensation preserves the conflicting file, archive and lock',()=>{
 const f=fixture();try{
 assert.throws(()=>rollbackFirstPublication({...f.options,afterMove:path=>{writeFileSync(join(f.root,path),'Concurrent manual replacement');throw Error('Interrupted');}},f.baseline,f.expected),/compensation failed/);
 assert.equal(readFileSync(join(f.root,'overview.md'),'utf8'),'Concurrent manual replacement');
 assert.ok(existsSync(join(f.root,'.write-lock')));
 assert.equal(readFileSync(join(f.root,'preparation','first-publication-rollbacks','operator','overview.md'),'utf8'),'PRIVATE FIXTURE overview.md');
 }finally{f.close();}
});
test('independent rollback: wrong exact hashes and public storage roots fail closed',()=>{
 const f=fixture();try{
 assert.throws(()=>rollbackFirstPublication(f.options,f.baseline,{...f.expected,'overview.md':'0'.repeat(64)}),/revision conflict/);
 assert.throws(()=>captureFirstPublicationBaseline({...f.options,protectedRoot:f.publicDataRoot}));
 assert.equal(existsSync(join(f.root,'.write-lock')),false);
 for(const path of paths)assert.ok(existsSync(join(f.root,path)));
 }finally{f.close();}
});
