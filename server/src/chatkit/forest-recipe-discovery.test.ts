import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatKitCatalogTools } from './catalog-tools.js';
import type { AiDmRunPrincipal } from '@foundry-ai-dungeon-master/shared';

const principal:AiDmRunPrincipal={worldId:'mcp-test',userId:'gm',clientId:'gm-client',lane:'gm',isGm:true,
  connectionId:'offline',role:4,authorizedAudienceKinds:['private','gm','selected-users','table'],permissionSnapshotRevision:'offline-1'};

test('forest recipe query discovers and loads only the available reviewed preparation facade',async()=>{
  const signal=new AbortController().signal;
  const client={listTools:async()=>[],callTool:async()=>{throw Error('No raw MCP calls allowed');}};
  const catalog=new ChatKitCatalogTools(client as any,principal,async()=>{},async()=>{throw Error('Discovery must not dispatch');},false,false,true);
  const found=await catalog.execute('tool_search',{query:'forest battlemap preparation image generation',limit:5},signal) as any;
  assert.equal(found.ok,true);
  assert.ok(found.value.descriptors.some((tool:any)=>tool.toolId==='ai_dm_preparation_workflow'));
  const loaded=await catalog.execute('tool_load',{searchId:found.value.searchId,toolId:'ai_dm_preparation_workflow'},signal) as any;
  assert.equal(loaded.ok,true);
  assert.match(JSON.stringify(loaded),/battlemap-generation-request/);
  assert.deepEqual(loaded.value.grant.allowedEffects,['read']);
  assert.match(JSON.stringify(loaded),/A DM tool cannot grant approval, spend or publication/);
  const unavailable=new ChatKitCatalogTools(client as any,principal,async()=>{},async()=>null,false,false,false);
  const denied=await unavailable.execute('tool_search',{query:'forest image generation',limit:5},signal) as any;
  assert.equal(denied.ok,true);assert.equal(denied.value.descriptors.length,0);
});
