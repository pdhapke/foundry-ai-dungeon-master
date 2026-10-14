import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AiDmAuthenticatedIdentity } from '@foundry-ai-dungeon-master/shared';
import { PreparationService } from './preparation-service.js';
import { hashText } from './context/hash.js';

const identity = { worldId: 'fixture', userId: 'gm', isGm: true, clientId: 'client' } as AiDmAuthenticatedIdentity;
function fixture() {
  const root = mkdtempSync(join(tmpdir(),'preparation-service-')), protectedRoot = join(root,'private'), publicRoot = join(root,'Data'), jobsRoot = join(root,'jobs');
  [join(protectedRoot,'fixture','data','campaign'),publicRoot,jobsRoot].forEach(p=>mkdirSync(p,{recursive:true}));
  const text = '# Reference\n\nA sourced gate.\n';
  writeFileSync(join(protectedRoot,'fixture','data','campaign','source.md'),text);
  const db = new DatabaseSync(':memory:'); const calls: Record<string,unknown>[] = [];
  const service = new PreparationService({ worldsRoot: join(publicRoot,'worlds'), protectedCampaign: { protectedRoot,publicDataRoot:publicRoot }, jobsRoot, database:db,
    sidecarUrl:'http://127.0.0.1:3941',internalSecret:'mock', assertPrivateStorage:()=>{},
    authorize: async value=>{assert.equal(value.clientId,'client');},
    fetch: async (_url,init)=>{const body=JSON.parse(String(init?.body)); calls.push(body); return new Response(JSON.stringify(body.action==='request'?{untrustedInput:body.inputs}:{session:{revision:0,paused:false},questions:[]}));},
  });
  return { service,text,calls,close:()=>{db.close();rmSync(root,{recursive:true,force:true});} };
}
test('actual protected sections replace claimed imported source text and carry hash/URI/span', async()=>{
  const f=fixture(); try {
    const response = await f.service.execute(identity,{operation:'build-request',input:{passId:'inventory', inputs:{worldId:'fixture',sources:[{content:'invented'}]},sourcePaths:[{id:'source',path:'source.md',expectedRevision:hashText(f.text),startLine:1,endLine:3}]}},AbortSignal.timeout(1000));
    const inputs=f.calls[0]!['inputs'] as {sources:Array<Record<string,unknown>>};
    assert.equal(inputs.sources[0]!['content'],f.text.trimEnd()); assert.equal(inputs.sources[0]!['visibility'],'gm'); assert.equal(inputs.sources[0]!['sourceUri'],'campaign://fixture/source.md');
    assert.equal((response as {modelCalls:number}).modelCalls,0);
  } finally { f.close(); }
});
test('unbound source text, foreign worlds, stale sources and self-publication are denied before any sidecar work',async()=>{
  const f=fixture(); try {
    for(const input of [
      {operation:'build-request',input:{passId:'inventory',inputs:{worldId:'fixture',sources:[{id:'fake',content:'invented'}]}}},
      {operation:'build-request',input:{passId:'inventory',inputs:{worldId:'other',sources:[]}}},
      {operation:'build-request',input:{passId:'inventory',inputs:{worldId:'fixture',sources:[]},sourcePaths:[{id:'source',path:'source.md',expectedRevision:'0'.repeat(64),startLine:1,endLine:3}]}},
      {operation:'publish',input:{}},
    ]) await assert.rejects(f.service.execute(identity,input,AbortSignal.timeout(1000)));
    assert.equal(f.calls.length,0);
  } finally {f.close();}
});
test('DM interview cannot approve setup intent while authenticated browser can save explicit user preference',async()=>{
  const f=fixture();try{
    const raw={operation:'interview',input:{sessionId:'setup',operation:'answer',questionId:'premise',text:'A local adventure',approved:true,expectedRevision:0}};
    await f.service.execute(identity,raw,AbortSignal.timeout(1000),'dm'); assert.equal(f.calls[0]!['approved'],false);
    await f.service.execute(identity,raw,AbortSignal.timeout(1000),'browser'); assert.equal(f.calls[1]!['approved'],true);
  }finally{f.close();}
});
