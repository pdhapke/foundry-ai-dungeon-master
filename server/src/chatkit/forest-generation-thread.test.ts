import assert from 'node:assert/strict';
import test from 'node:test';
import type { AiDmAuthenticatedIdentity, AiDmJsonValue } from '@foundry-ai-dungeon-master/shared';
import { ChatKitReadTools } from './read-tools.js';
import { TrustedToolCatalog, type FoundryLocalApiMcpClient } from '../tool-catalog/index.js';

test('generation preparation binds the actual authenticated conversation before workflow dispatch',async()=>{
  const identity:AiDmAuthenticatedIdentity={worldId:'mcp-test',userId:'gm',clientId:'client',lane:'gm',isGm:true};
  const scope={worldId:'mcp-test',userId:'gm',threadId:'actual-thread'};
  const received:AiDmJsonValue[]=[];
  const client:FoundryLocalApiMcpClient={listTools:async()=>[],callTool:async()=>{throw Error('No MCP dispatch authorized in this offline test');}};
  const catalog=new TrustedToolCatalog({snapshot:async()=>({providerId:'offline',providerVersion:'offline',revision:'offline',tools:[]}),invokeSelected:async()=>{throw Error('No provider dispatch authorized in this offline test');}},[],'offline');
  const adapter=new ChatKitReadTools(client,async()=>{},catalog,{internalSecret:'offline',preparationAction:async(_identity,body)=>{received.push(body as AiDmJsonValue);return {};}});
  const controller=new AbortController();const run=adapter.begin(identity,{params:{thread_id:scope.threadId}},controller.signal);
  const execute=(body:unknown)=>adapter.execute(run.token,scope,'preparation_workflow',body,new AbortController().signal);
  try {
    await execute({operation:'battlemap-generation-request',input:{worldId:'mcp-test',prompt:'Gridless player-safe forest',name:'New forest'}});
    assert.equal((received[0] as any).input.threadId,scope.threadId);
    await assert.rejects(execute({operation:'battlemap-generation-status',input:{worldId:'mcp-test',generationId:'a'.repeat(64),threadId:'forged-thread'}}),/THREAD_CHANGED/);
    assert.equal(received.length,1);
    await execute({operation:'battlemap-prepare',input:{worldId:'mcp-test',generationId:'a'.repeat(64),profile:'tv'}});
    assert.equal((received[1] as any).input.threadId,scope.threadId);
  }finally{controller.abort();}
});
