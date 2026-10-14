import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from '@foundry-ai-dungeon-master/shared';
import { worldSourceRevision } from '../chatkit/world-document-actions.js';
import { FOREST_FIXTURE, ForestBattlemapWorkflow } from './forest-battlemap.js';
import { preparationToolSchema } from '../chatkit/preparation-contract.js';
import { validateArguments } from '../tool-catalog/index.js';

function setup(acceptanceFixtures: Record<string, import('../config.js').AcceptanceFixture> = {}) {
  const root=mkdtempSync(join(tmpdir(),'forest-workflow-test-'));
  const db=new DatabaseSync(':memory:');const jobsRoot=join(root,'jobs'),publicDataRoot=join(root,'public');
  const bytes=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.writeUInt32BE(640,16);bytes.writeUInt32BE(640,20);
  const sourceHash=createHash('sha256').update(bytes).digest('hex');
  const fixture={...FOREST_FIXTURE,sourceHash,sourceWidth:640,sourceHeight:640};
  const incoming=join(jobsRoot,'local-assets','mcp-test','incoming');mkdirSync(incoming,{recursive:true});mkdirSync(publicDataRoot);writeFileSync(join(incoming,`${sourceHash}.png`),bytes);
  const identity:AiDmAuthenticatedIdentity={worldId:'mcp-test',userId:'gm',clientId:'ai-dm-gm-client',lane:'gm',isGm:true};
  let world='mcp-test',cssWidth=1280,authorized=true,tv=false,fullscreen=true,dttWidth=955,duplicateGm=false,scene:Object|null=null,applies=0,replay=false,viewedScene='onboarding',preloaded=false,failAfterWrite=false,displayCalls=0;
  const tools=['dtt_get_status','foundry_get_world','foundry_get_capability_report','foundry_get_user_by_id','foundry_get_client_readiness','foundry_get_world_document','foundry_apply_world_document','foundry_preload_scene','foundry_apply_client_viewport'].map(name=>({name,inputSchema:{type:'object'} as AiDmJsonValue}));
  const client={listTools:async()=>tools,callTool:async(request:{name:string;arguments:AiDmJsonValue})=>{
    const args=request.arguments as Record<string,unknown>;
    if(request.name==='dtt_get_status')return {moduleActive:true,settings:{displayWidth:dttWidth}};
    if(request.name==='foundry_get_world')return {id:world,title:'test mcp',system:'dnd5e'};
    if(request.name==='foundry_get_capability_report')return {clients:[{clientId:'gm-client',userId:'gm',lane:'gm',optedIn:true},...(duplicateGm?[{clientId:'other-gm-client',userId:'gm',lane:'gm',optedIn:true}]:[]),...(tv?[{clientId:'tv-client',userId:'tv-user',lane:'tv',optedIn:true}]:[])].map(c=>({...c,foundryVersion:'14.368',systemId:'dnd5e',systemVersion:'6.0.3',moduleVersion:'0.1.0',protocolVersion:2}))};
    if(request.name==='foundry_get_user_by_id')return args['userId']==='gm'?{name:'Gamemaster',role:4}:{name:'TV',role:2};
    if(['foundry_get_client_readiness','foundry_preload_scene','foundry_apply_client_viewport'].includes(request.name)) {
      if(request.name==='foundry_preload_scene'){assert.equal(args['sceneId'],viewedScene);preloaded=true;displayCalls++;}
      if(request.name==='foundry_apply_client_viewport'){
        if(args['viewScene']===true){assert.equal(args['clientId'],'tv-client');assert.equal(args['digitalTabletop'],true);viewedScene=String(args['sceneId']);}
        else assert.equal(preloaded,true);
        assert.equal(args['sceneId'],viewedScene);displayCalls++;
      }
      return {acknowledged:true,replayed:replay,correlationId:args['correlationId'],executingClientId:args['clientId'],clientUserId:args['userId'],activeSceneId:viewedScene,sceneReady:preloaded,incomplete:false,viewport:args['viewport']??null,display:{cssWidth,cssHeight:960,devicePixelRatio:2,canvasReady:true,fullscreen}};
    }
    if(request.name==='foundry_apply_world_document'){
      assert.equal(world,'mcp-test');assert.equal(args['operation'],'create');assert.equal(args['expectedRevision'],null);assert.equal(args['reviewedDestructive'],true);
      assert.equal((args['data'] as Record<string,unknown>)['active'],false);applies++;
      scene={...structuredClone(args['data'] as object),_id:args['targetId']};
      if(failAfterWrite){failAfterWrite=false;throw Error('connection lost after native write');}
      return {verified:true,correlationId:args['correlationId'],idempotencyKey:args['idempotencyKey'],revision:worldSourceRevision(scene)};
    }
    return {worldId:world,family:args['family'],targetId:args['targetId'],source:scene,revision:worldSourceRevision(scene)};
  }};
  const workflow=new ForestBattlemapWorkflow({database:db,jobsRoot,publicDataRoot,fixture,acceptanceFixtures,client:client as any,assertPrivateStorage:()=>{},authorize:async()=>{if(!authorized)throw Error('AUTH_REVOKED');}});
  const execute=(operation:string,input:Record<string,unknown>={},origin:'browser'|'dm'='browser')=>workflow.execute(identity,operation,{worldId:'mcp-test',...input},new AbortController().signal,origin);
  return {root,db,identity,execute,fixture,get applies(){return applies;},get scene(){return scene;},get displayCalls(){return displayCalls;},set view(value:string){viewedScene=value;},set uncertain(value:boolean){failAfterWrite=value;},set world(value:string){world=value;},set width(value:number){cssWidth=value;},set authorized(value:boolean){authorized=value;},set tv(value:boolean){tv=value;},set replay(value:boolean){replay=value;},
    set fullscreen(value:boolean){fullscreen=value;},set dttWidth(value:number){dttWidth=value;},set duplicateGm(value:boolean){duplicateGm=value;},close(){db.close();assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(root.includes('forest-workflow-test-'));rmSync(root,{recursive:true});}};
}

test('different AI and companion IDs bind exact same user; ambiguous companions refuse',async()=>{
  const f=setup();try {
    await f.execute('battlemap-import');
    const prepared=await f.execute('battlemap-prepare',{profile:'gm-preview'}) as any;
    assert.equal(prepared.target.clientId,'gm-client');assert.notEqual(prepared.target.clientId,f.identity.clientId);
    assert.equal(prepared.viewport.scale,960/(3760+200));
    f.duplicateGm=true;await assert.rejects(f.execute('battlemap-prepare',{profile:'gm-preview'}),/EXACT_GM/);assert.equal(f.applies,0);
  } finally {f.close();}
});
test('TV requires current Digital Tabletop calibration and fullscreen before scene preparation',async()=>{
  const f=setup();try {
    await f.execute('battlemap-import');f.tv=true;f.fullscreen=false;
    await assert.rejects(f.execute('battlemap-prepare',{profile:'tv'}),/FULLSCREEN_REQUIRED/);
    f.fullscreen=true;f.dttWidth=900;
    await assert.rejects(f.execute('battlemap-prepare',{profile:'tv'}),/955_MM_REQUIRED/);
    assert.equal(f.applies,0);assert.equal(f.displayCalls,0);
  }finally{f.close();}
});
test('new embedded image request records one scoped secure handoff without generation or fixture substitution',async()=>{
  const f=setup();try {
    const request={worldId:'mcp-test',threadId:'new-thread',prompt:'Player-safe gridless forest, overhead view',name:'New forest trial'};
    assert.deepEqual(validateArguments(preparationToolSchema,{operation:'battlemap-generation-request',input:request}),[]);
    const pending=await f.execute('battlemap-generation-request',request,'dm') as any;
    assert.equal(pending.status,'needs-secure-generation-handoff');assert.equal(pending.providerRequests,0);assert.equal(pending.imageInvocationsVerified,false);assert.equal(pending.automaticGenerationAccepted,false);
    const repeated=await f.execute('battlemap-generation-request',request,'dm') as any;assert.equal(repeated.id,pending.id);
    await assert.rejects(f.execute('battlemap-generation-request',{...request,prompt:'Another image'},'dm'),/ONE_GENERATION/);
    await assert.rejects(f.execute('battlemap-generation-complete',{generationId:pending.id,threadId:'new-thread'},'dm'),/BROWSER_COMPLETION/);
    await assert.rejects(f.execute('battlemap-generation-status',{generationId:pending.id,threadId:'wrong-thread'}),/THREAD_CHANGED/);
    await assert.rejects(f.execute('battlemap-prepare',{generationId:pending.id,threadId:'new-thread',profile:'tv'},'dm'),/NOT_COMPLETE/);
    await assert.rejects(f.execute('battlemap-generation-complete',{generationId:pending.id,threadId:'new-thread'}),/SECURE_GENERATION_RECEIPT/);
    assert.equal(f.applies,0);
  }finally{f.close();}
});
test('secure receipt imports separately named new fixture once; native package and exact TV remain bound',async()=>{
  const f=setup();try {
    const pending=await f.execute('battlemap-generation-request',{threadId:'new-thread',prompt:'Player-safe gridless forest',name:'New forest trial'},'dm') as any;
    const input={generationId:pending.id,threadId:'new-thread'};
    const root=join(f.root,'jobs','local-assets','mcp-test','generation-incoming');mkdirSync(root,{recursive:true});
    const bytes=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.writeUInt32BE(800,16);bytes.writeUInt32BE(800,20);
    const sourceHash=createHash('sha256').update(bytes).digest('hex');writeFileSync(join(root,`${pending.id}.png`),bytes);
    const receipt={requestId:pending.id,promptDigest:pending.promptDigest,integration:'secure-imagegen-handoff',imageCount:1,sourceHash,sourceWidth:800,sourceHeight:800,generationRef:'offline-fake-for-contract-test-only',license:'Offline test raster',playerVisibleApproved:true};
    writeFileSync(join(root,`${pending.id}.json`),JSON.stringify({...receipt,imageCount:2}));
    await assert.rejects(f.execute('battlemap-generation-complete',input),/RECEIPT_INVALID/);
    writeFileSync(join(root,`${pending.id}.json`),JSON.stringify(receipt));
    const imported=await f.execute('battlemap-generation-complete',input) as any;
    assert.equal(imported.status,'imported');assert.notEqual(imported.fixture.name,FOREST_FIXTURE.name);assert.notEqual(imported.fixture.sourceHash,FOREST_FIXTURE.sourceHash);
    const retry=await f.execute('battlemap-generation-complete',input) as any;assert.equal(retry.status,'imported');assert.deepEqual(retry.fixture,imported.fixture);
    await assert.rejects(f.execute('battlemap-prepare',{...input,profile:'tv'},'dm'),/EXACT_TV/);
    await f.execute('battlemap-import');const old=await f.execute('battlemap-prepare',{profile:'gm-preview'}) as any;
    await assert.rejects(f.execute('battlemap-status',{...input,packageId:old.package.id}),/FIXTURE_MISMATCH/);
    f.tv=true;const prepared=await f.execute('battlemap-prepare',{...input,profile:'tv'},'dm') as any;
    assert.equal(prepared.package.sourceRevisions.asset,sourceHash);assert.equal(prepared.package.sceneRequest.args.data.name,imported.fixture.name);
    const approved=await f.execute('battlemap-review',{...input,packageId:prepared.package.id,reviewDigest:prepared.package.digest}) as any;
    const created=await f.execute('battlemap-apply',{...input,packageId:prepared.package.id,approvalId:approved.approvalId}) as any;
    assert.equal(f.applies,1);assert.equal((f.scene as any).active,false);
    const display=await f.execute('battlemap-display',{...input,packageId:prepared.package.id});
    assert.equal(display.clientId,'tv-client');assert.equal(display.physicalAcceptance,false);assert.equal(display.providerRequests,0);
    assert.equal(display.scalingIntegration,'digital-tabletops');assert.equal(f.displayCalls,3);
  }finally{f.close();}
});
test('budget button reads existing exact startup allowance only; models and wrong threads refuse',async()=>{
  const f=setup({'forest-test':{worldId:'mcp-test',userId:'gm',threadId:'forest-thread',traceId:'00000000-0000-4000-8000-000000000001',maxModelRequests:6,expiresAt:new Date(Date.now()+60000).toISOString()}});
  try {
    await assert.rejects(f.execute('battlemap-acceptance',{threadId:'forest-thread'},'dm'),/BROWSER_BUDGET/);
    await assert.rejects(f.execute('battlemap-acceptance',{threadId:'other-thread'}),/NOT_CONFIGURED/);
    const binding=await f.execute('battlemap-acceptance',{threadId:'forest-thread'}) as any;
    assert.equal(binding.status,'budget-bound');assert.equal(binding.maxModelRequests,6);assert.equal(binding.providerRequests,0);assert.equal(f.applies,0);
  } finally {f.close();}
});

test('forest budget accepts reduced ceilings including remaining five and refuses invalid ceilings',async()=>{
  for(const ceiling of [1,2,3,4,5,6,0,7,1.5]) {
    const f=setup({'forest-test':{worldId:'mcp-test',userId:'gm',threadId:'forest-thread',traceId:'00000000-0000-4000-8000-000000000001',maxModelRequests:ceiling as any,expiresAt:new Date(Date.now()+60000).toISOString()}});
    try {
      if(Number.isInteger(ceiling)&&ceiling>=1&&ceiling<=6) {
        const binding=await f.execute('battlemap-acceptance',{threadId:'forest-thread'}) as any;
        assert.equal(binding.maxModelRequests,ceiling);assert.equal(binding.providerRequests,0);assert.equal(f.applies,0);
      } else await assert.rejects(f.execute('battlemap-acceptance',{threadId:'forest-thread'}),/NOT_CONFIGURED/);
    } finally {f.close();}
  }
});
test('approved import -> embedded preparation -> exact browser review -> durable inactive v14 apply and recovery',async()=>{
  const f=setup();try {
    assert.equal((await f.execute('battlemap-import')).status,'imported');
    const prepared=await f.execute('battlemap-prepare',{profile:'gm-preview'},'dm') as any;
    assert.equal(prepared.profile,'gm-preview');assert.equal(prepared.physicalAcceptance,false);
    assert.equal(prepared.package.sceneRequest.args.data.width,3760);assert.equal(prepared.package.sceneRequest.args.data.height,3760);
    const packageId=prepared.package.id;
    await assert.rejects(f.execute('battlemap-review',{packageId,reviewDigest:'f'.repeat(64)}),/EXACT_BROWSER/);
    await assert.rejects(f.execute('battlemap-review',{packageId,reviewDigest:prepared.package.digest},'dm'),/EXACT_BROWSER/);
    const approved=await f.execute('battlemap-review',{packageId,reviewDigest:prepared.package.digest}) as any;
    await assert.rejects(f.execute('battlemap-apply',{packageId,approvalId:approved.approvalId},'dm'),/BROWSER_APPLY/);
    const applied=await f.execute('battlemap-apply',{packageId,approvalId:approved.approvalId}) as any;
    assert.equal(applied.result.state,'complete');assert.equal(f.applies,1);assert.equal(applied.providerRequests,0);
    assert.equal((f.scene as any).levels[0].textures.fit,'contain');assert.equal((f.scene as any).active,false);
    const recovered=await f.execute('battlemap-apply',{packageId,approvalId:approved.approvalId}) as any;
    assert.equal(recovered.result.sceneId,applied.result.sceneId);assert.equal(f.applies,1);
  } finally {f.close();}
});
test('viewed owned fixture is required before correlated preload/fit, with no activation or model display authority',async()=>{
  const f=setup();try {
    await f.execute('battlemap-import');const prepared=await f.execute('battlemap-prepare',{profile:'gm-preview'},'dm') as any;
    const packageId=prepared.package.id,approved=await f.execute('battlemap-review',{packageId,reviewDigest:prepared.package.digest}) as any;
    const applied=await f.execute('battlemap-apply',{packageId,approvalId:approved.approvalId}) as any;
    await assert.rejects(f.execute('battlemap-display',{packageId},'dm'),/BROWSER_DISPLAY/);
    await assert.rejects(f.execute('battlemap-display',{packageId}),/VIEW_NAMED_SCENE/);assert.equal(f.displayCalls,0);
    f.view=applied.result.sceneId;const display=await f.execute('battlemap-display',{packageId});
    assert.equal(display.status,'display-ready');assert.equal(display.physicalAcceptance,false);assert.equal(f.displayCalls,2);assert.equal((f.scene as any).active,false);
    (f.scene as any).width=999;await assert.rejects(f.execute('battlemap-display',{packageId}),/SCENE_CHANGED/);assert.equal(f.displayCalls,2);
  } finally {f.close();}
});
test('uncertain native write is recovered by exact document readback, never a duplicate scene',async()=>{
  const f=setup();try {
    await f.execute('battlemap-import');const prepared=await f.execute('battlemap-prepare',{profile:'gm-preview'},'dm') as any;
    const packageId=prepared.package.id,approved=await f.execute('battlemap-review',{packageId,reviewDigest:prepared.package.digest}) as any;
    f.uncertain=true;await assert.rejects(f.execute('battlemap-apply',{packageId,approvalId:approved.approvalId}));assert.equal(f.applies,1);
    const recovered=await f.execute('battlemap-apply',{packageId,approvalId:approved.approvalId}) as any;
    assert.equal(recovered.result.state,'complete');assert.equal(f.applies,1);
  } finally {f.close();}
});
test('world change, revoked authority, unknown input, missing TV and replay refuse without mutation',async()=>{
  const f=setup();try {
    await assert.rejects(f.execute('battlemap-import',{},'dm'),/BROWSER_IMPORT/);
    await f.execute('battlemap-import');
    await assert.rejects(f.execute('battlemap-prepare',{profile:'tv'},'dm'),/EXACT_TV/);
    await assert.rejects(f.execute('battlemap-prepare',{profile:'gm-preview',assetRef:'secret.txt'},'dm'),/INPUT_INVALID/);
    f.replay=true;await assert.rejects(f.execute('battlemap-prepare',{profile:'gm-preview'},'dm'),/FRESH_DISPLAY/);f.replay=false;
    f.world='izzy-campaign';await assert.rejects(f.execute('battlemap-prepare',{profile:'gm-preview'},'dm'),/WORLD_CHANGED/);f.world='mcp-test';
    f.authorized=false;await assert.rejects(f.execute('battlemap-import'),/AUTH_REVOKED/);
    assert.equal(f.applies,0);
  } finally {f.close();}
});
test('resize invalidates reviewed apply; explicit reprepare permits same scene without duplicate create',async()=>{
  const f=setup();try {
    await f.execute('battlemap-import');let prepared=await f.execute('battlemap-prepare',{profile:'gm-preview'},'dm') as any;
    let approved=await f.execute('battlemap-review',{packageId:prepared.package.id,reviewDigest:prepared.package.digest}) as any;
    f.width=1920;await assert.rejects(f.execute('battlemap-apply',{packageId:prepared.package.id,approvalId:approved.approvalId}),/DISPLAY_CHANGED/);assert.equal(f.applies,0);
    prepared=await f.execute('battlemap-prepare',{profile:'gm-preview'},'dm') as any;
    approved=await f.execute('battlemap-review',{packageId:prepared.package.id,reviewDigest:prepared.package.digest}) as any;
    await f.execute('battlemap-apply',{packageId:prepared.package.id,approvalId:approved.approvalId});assert.equal(f.applies,1);
  } finally {f.close();}
});
