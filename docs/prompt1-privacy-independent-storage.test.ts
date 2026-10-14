import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync } from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {WorldCampaignContext} from '../server/src/context/world-campaign.ts';
import {CampaignStorage} from '../server/src/context/campaign-storage.ts';
import {assertProtectedCampaignRoot} from '../server/src/context/protected-campaign.ts';
const header='---\nschema_version: 1\nid: overview\nrevision: r1\nvisibility: gm\ncanon_status: canon\n---\n';
const gm={clientId:'c',worldId:'one',userId:'gm',lane:'gm',isGm:true,role:4,connectionId:'c',authorizedAudienceKinds:['gm'],permissionSnapshotRevision:'fixture'} as any;
test('protected context cannot fall back to public campaign; worlds and visibility stay isolated',()=>{
 const root=mkdtempSync(join(tmpdir(),'private-campaign-validator-'));
 try{
  const served=join(root,'Data'),privateRoot=join(root,'protected');mkdirSync(served);mkdirSync(privateRoot);
  for(const base of [served,privateRoot])for(const world of ['one','two'])mkdirSync(join(base,world,'data','campaign'),{recursive:true});
  writeFileSync(join(served,'one','data','campaign','overview.md'),header+'PUBLIC OLD COPY');
  writeFileSync(join(privateRoot,'one','data','campaign','overview.md'),header+'PROTECTED ONE');
  writeFileSync(join(privateRoot,'two','data','campaign','overview.md'),header+'PROTECTED TWO');
  const options={protectedRoot:privateRoot,publicDataRoot:served};
  const context=new WorldCampaignContext(served,options);
  assert.equal((context.overview(gm) as any).text,'PROTECTED ONE');
  assert.equal((context.overview({...gm,worldId:'two'}) as any).text,'PROTECTED TWO');
  assert.notEqual((context.overview({...gm,isGm:false,lane:'player',role:1,authorizedAudienceKinds:['public']}) as any).text,'PROTECTED ONE');
  assert.notEqual((context.overview({...gm,worldId:'missing'}) as any).text,'PUBLIC OLD COPY');
  let revoked=false;
  const storage=new CampaignStorage(served,{authorize:world=>{assert.equal(world,'one');if(revoked)throw Error('Revoked');},assertPrivateStorage:()=>{}},128000,512000,options);
  assert.match(storage.read('one','overview.md')!.text,/PROTECTED ONE/);
  revoked=true;assert.throws(()=>storage.read('one','overview.md'),/Revoked/);
  assert.match(readFileSync(join(served,'one','data','campaign','overview.md'),'utf8'),/PUBLIC OLD COPY/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('protected root rejects actual static-tree destination and junction escapes',()=>{
 const root=mkdtempSync(join(tmpdir(),'private-campaign-junction-'));
 try{
  const served=join(root,'Data');mkdirSync(served);mkdirSync(join(served,'secrets'));
  assert.throws(()=>assertProtectedCampaignRoot({protectedRoot:join(served,'secrets'),publicDataRoot:served}),/public Foundry/);
  const alias=join(root,'privateAlias');symlinkSync(join(served,'secrets'),alias,'junction');
  assert.throws(()=>assertProtectedCampaignRoot({protectedRoot:alias,publicDataRoot:served}),/public Foundry|redirects/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
import request from 'supertest';
import {DatabaseSync} from 'node:sqlite';
import {ChatKitCampaignActions} from '../server/src/chatkit/campaign-actions.ts';
import {ChatKitReadTools} from '../server/src/chatkit/read-tools.ts';
import {createAiDmApp} from '../server/src/app.ts';
import {TrustedToolCatalog,FoundryLocalApiProviderAdapter} from '../server/src/tool-catalog/index.ts';
test('HTTP campaign retrieval denies unauthenticated and substituted scopes; authorized GM remains current',async()=>{
 const root=mkdtempSync(join(tmpdir(),'private-campaign-http-'));
 const db=new DatabaseSync(':memory:');
 try{
  const served=join(root,'Data'),privateRoot=join(root,'protected');mkdirSync(served);mkdirSync(join(privateRoot,'one','data','campaign'),{recursive:true});writeFileSync(join(privateRoot,'one','data','campaign','overview.md'),header+'GM SECRET SENTINEL');
  const options={protectedRoot:privateRoot,publicDataRoot:served};let revoked=false;
  const authorize=async()=>{if(revoked)throw Error('Revoked');};
  const actions=new ChatKitCampaignActions(db,authorize,{worldsRoot:served,protectedCampaign:options});
  const client={listTools:async()=>[],callTool:async()=>{throw Error('No external reads');}} as any;
  const catalog=new TrustedToolCatalog(new FoundryLocalApiProviderAdapter({client,providerVersion:'fixture'}),[],'fixture');
  const adapter=new ChatKitReadTools(client,authorize,catalog,{internalSecret:'fixture-secret',campaignActions:actions});
  const run=adapter.begin(gm,{params:{thread_id:'t'}},new AbortController().signal);
  const app=createAiDmApp({readiness:()=>({ready:true,details:{}}),chatkitReadHandler:adapter.handler});
  const body={operation:'campaign_read',arguments:{path:'overview.md'}};
  const headers={'x-chatkit-secret':'fixture-secret','x-chatkit-world':'one','x-chatkit-user':'gm','x-chatkit-thread':'t','x-chatkit-read-run':run.token};
  const anonymous=await request(app).post('/internal/chatkit/read').send(body);assert.equal(anonymous.status,403);assert.doesNotMatch(anonymous.text,/GM SECRET SENTINEL/);
  for(const changed of [{'x-chatkit-world':'other'},{'x-chatkit-user':'other'},{'x-chatkit-thread':'other'},{origin:'https://untrusted.example'}]){const denied=await request(app).post('/internal/chatkit/read').set({...headers,...changed}).send(body);assert.equal(denied.status,403);assert.doesNotMatch(denied.text,/GM SECRET SENTINEL/);}
  const success=await request(app).post('/internal/chatkit/read').set(headers).send(body);assert.equal(success.status,200);assert.match(success.text,/GM SECRET SENTINEL/);
  revoked=true;const denied=await request(app).post('/internal/chatkit/read').set(headers).send(body);assert.equal(denied.status,403);assert.doesNotMatch(denied.text,/GM SECRET SENTINEL/);
  const staticRead=await request(app).get('/campaign-worlds/one/data/campaign/overview.md');assert.equal(staticRead.status,404);assert.doesNotMatch(staticRead.text,/GM SECRET SENTINEL/);
  run.release();
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
