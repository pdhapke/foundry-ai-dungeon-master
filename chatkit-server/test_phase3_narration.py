"""Installed SDK narration boundary tests; no network, provider, or live-world calls."""
import asyncio
import copy
import json
import unittest
import tempfile
from pathlib import Path
from types import SimpleNamespace
from datetime import datetime, timezone
from unittest.mock import patch
from agents import Runner, RunConfig
from agents.exceptions import ModelBehaviorError
from agents.items import ModelResponse
from agents.usage import Usage
from chatkit.agents import AgentContext, stream_agent_response
from chatkit.types import ThreadMetadata
from openai.types.responses import ResponseFunctionToolCall
from app import SqliteStore, build_agent, PauseTimingHooks, ReceiptHistoryConverter, read_foundry as actual_read_foundry, narration_receipt_boundary, RoutineCompletionContract
from test_routine_completion import CommandModel, CASES

class NarrationModel(CommandModel):
    def __init__(self, name,args,retrieval=False,delayed=False,cancel_narration=False):
        super().__init__(name,args,retrieval)
        self.delayed=delayed
        self.tool_sets=[]
        self.cancel_narration=cancel_narration
        self.narration_started=asyncio.Event()
        self.labels_before_second=[]
    async def get_response(self,*args,**kwargs):
        self.tool_sets.append([tool.name for tool in args[3]])
        if self.calls==1 and hasattr(self,'store'):
            history=await self.store.load_thread_items('thread',None,30,'asc',self.request)
            self.labels_before_second=[item for item in history.data if item.id.startswith('msg_narration_basis_')]
        if self.cancel_narration and self.calls==1:
            self.calls+=1
            self.narration_started.set()
            await asyncio.Event().wait()
        if self.delayed and self.calls==1:
            self.calls+=1
            return ModelResponse(output=[ResponseFunctionToolCall(type='function_call',name=self.name,arguments=json.dumps(self.args),call_id='delayed',id='delayed-tool')],usage=Usage(),response_id='delayed-response')
        return await super().get_response(*args,**kwargs)

class NarrationTests(unittest.IsolatedAsyncioTestCase):
    async def run_case(self,contract=True,outcome='confirmed',retrieval=False,delayed=False,lost_ack=False,path=':memory:',wrong_action=False,bad_ack=False,cancel_narration=False):
        name,args,data=copy.deepcopy(CASES[3])
        receipt={'schemaVersion':'core-actions-v1','outcome':outcome,'worldId':'world','correlationId':'receipt',**data}
        if wrong_action:receipt['action']['targetId']='other'
        request={'worldId':'world','userId':'gm','threadId':'thread','apiKey':'fixture','model':'fixture','readRun':'fixture'}
        if contract:request['narrationContract']={'version':1,'toolName':name,'arguments':args}
        store=SqliteStore(path)
        thread=ThreadMetadata(id='thread',created_at=datetime.now(timezone.utc))
        await store.save_thread(thread,request)
        ctx=AgentContext(thread=thread,store=store,request_context=request)
        model=NarrationModel(name,args,retrieval,delayed,cancel_narration)
        model.store=store;model.request=request
        agent=build_agent(request);agent.model=model
        operations=[]
        async def adapter(context,operation,arguments=None):
            operations.append(operation)
            if operation=='release_mutation_capability':
                history=await store.load_thread_items('thread',None,30,'asc',request)
                self.assertTrue(any(item.type=='assistant_message' for item in history.data))
                self.assertTrue(any(item.type=='hidden_context_item' and isinstance(item.content,dict) and item.content.get('type')=='authoritative_tool_exchange_v1' for item in history.data))
                self.assertTrue(any(item.type=='hidden_context_item' and isinstance(item.content,str) and '"status": "requested"' in item.content for item in history.data))
                self.assertTrue(request['_narrationOnly'])
                self.assertEqual(agent.tools,[])
                if lost_ack:raise asyncio.CancelledError()
                if bad_ack:return {'ok':True,'result':{'version':1,'mutationCapability':'permanently-revoked'}}
                return {'ok':True,'result':{'version':1,'mutationCapability':'permanently-revoked','receiptDigest':'a'*64,'stateRevision':'b'*64,'scope':'confirmed-receipt-observation; may be superseded'}}
            return {'ok':True,'result':receipt}
        run=Runner.run_streamed(agent,'fixture',context=ctx,hooks=PauseTimingHooks(request),run_config=RunConfig(tracing_disabled=True))
        error=None
        with patch('app.read_foundry',side_effect=adapter):
            try:
                if cancel_narration:
                    async def collect():return [e async for e in stream_agent_response(ctx,run)]
                    task=asyncio.create_task(collect())
                    await asyncio.wait_for(model.narration_started.wait(),2)
                    run.cancel()
                    events=await task
                else:events=[e async for e in stream_agent_response(ctx,run)]
            except (ModelBehaviorError,asyncio.CancelledError) as exc:error=exc
        model.sdk_events=locals().get("events",[])
        history=await store.load_thread_items('thread',None,30,'asc',request)
        inputs=await ReceiptHistoryConverter().to_agent_input(history.data)
        store.db.close()
        return request,agent,model,operations,inputs,error

    async def test_complete_durable_mechanics_revoke_before_tool_free_narration(self):
        request,agent,model,ops,inputs,error=await self.run_case()
        self.assertIsNone(error)
        self.assertEqual(ops,['native_core_action','release_mutation_capability'])
        self.assertEqual(model.calls,2)
        self.assertEqual(model.tool_sets[1],[])
        self.assertIn('may supersede',str(inputs))
        self.assertIn('b'*64,agent.instructions)
        self.assertEqual(sum(i.get('type')=='function_call' for i in inputs),1)
        self.assertEqual(sum(i.get('type')=='function_call_output' for i in inputs),1)

    async def test_compound_retrieval_and_uncertainty_hold_original_capability(self):
        for options in ({'contract':False},{'retrieval':True},{'outcome':'uncertain'},{'outcome':'failure'},{'wrong_action':True}):
            request,agent,model,ops,inputs,error=await self.run_case(**options)
            self.assertNotIn('release_mutation_capability',ops)
            self.assertNotIn('_narrationOnly',request)
            self.assertTrue(agent.tools)

    async def test_delayed_mutation_is_not_dispatched_after_boundary(self):
        request,agent,model,ops,inputs,error=await self.run_case(delayed=True)
        self.assertIsInstance(error,ModelBehaviorError)
        self.assertEqual(ops.count('native_core_action'),1)
        response=await actual_read_foundry(request,'native_core_action',{'action':{'kind':'actor.hp'}})
        self.assertEqual(response['error']['code'],'NARRATION_ONLY')
        for operation in ('tool_execute','native_roll_attack','native_apply_attack_damage','native_core_move_batch','initial_context'):
            self.assertEqual((await actual_read_foundry(request,operation))['error']['code'],'NARRATION_ONLY')

    async def test_cancellation_after_remote_revocation_preserves_receipt_and_pending_fence(self):
        request,agent,model,ops,inputs,error=await self.run_case(lost_ack=True)
        self.assertTrue(error is None or isinstance(error,asyncio.CancelledError))
        self.assertEqual(model.calls,1)
        self.assertTrue(request['_narrationBoundaryAttempted'])
        self.assertTrue(request['_narrationOnly'])
        self.assertIn('"status": "requested"',str(inputs))
        self.assertTrue(any(i.get('type')=='function_call_output' for i in inputs))
        self.assertTrue(any(i.get('role')=='assistant' for i in inputs))

    async def test_missing_ack_never_restores_old_run_tools(self):
        request,agent,model,ops,inputs,error=await self.run_case(bad_ack=True)
        self.assertEqual(model.calls,2)
        self.assertEqual(agent.tools,[])
        self.assertTrue(request['_narrationOnly'])
        self.assertNotIn('_narrationBoundary',request)
        self.assertIn('acknowledgement-unavailable',str(inputs))

    async def test_receipt_and_boundary_survive_store_reopen_and_replay_is_inert(self):
        with tempfile.TemporaryDirectory() as directory:
            path=str(Path(directory)/'fixture.sqlite')
            request,agent,model,ops,inputs,error=await self.run_case(path=path)
            store=SqliteStore(path)
            try:
                thread=await store.load_thread('thread',request)
                ctx=AgentContext(thread=thread,store=store,request_context=request)
                with patch('app.read_foundry') as adapter:
                    await narration_receipt_boundary(SimpleNamespace(context=ctx),[],agent)
                    adapter.assert_not_awaited()
                history=await store.load_thread_items('thread',None,30,'asc',request)
                reconstructed=await ReceiptHistoryConverter().to_agent_input(history.data)
                self.assertEqual(sum(i.get('type')=='function_call' for i in reconstructed),1)
                self.assertEqual(sum(i.get('type')=='function_call_output' for i in reconstructed),1)
                self.assertEqual(sum(item.type=='assistant_message' for item in history.data),2)
                self.assertIn('"status": "confirmed"',str(reconstructed))
            finally:store.db.close()

    def test_narration_contract_version_never_accepts_boolean(self):
        with self.assertRaises(ValueError):
            RoutineCompletionContract.model_validate({'version':True,'toolName':'foundry_set_pause_state','arguments':{'paused':True}})

    async def test_cancelled_narration_retains_confirmed_boundary_and_receipt(self):
        request,agent,model,ops,inputs,error=await self.run_case(cancel_narration=True)
        self.assertEqual(model.calls,2)
        self.assertTrue(request['_narrationOnly'])
        self.assertIn('"status": "confirmed"',str(inputs))
        self.assertEqual(ops.count('native_core_action'),1)
        self.assertEqual(ops.count('release_mutation_capability'),1)
        self.assertTrue(any(i.get('type')=='function_call_output' for i in inputs))

    async def test_next_turn_accepts_complete_persisted_protocol_without_old_capability(self):
        _,_,_,_,inputs,_=await self.run_case()
        request={'apiKey':'fixture','model':'fixture'}
        agent=build_agent(request)
        model=CommandModel('foundry_set_pause_state',{'paused':False});model.calls=1
        agent.model=model
        await Runner.run(agent,inputs+[{'role':'user','content':'What happened?'}],run_config=RunConfig(tracing_disabled=True))
        self.assertNotIn('_narrationOnly',request)
        self.assertTrue(any(i.get('type')=='function_call_output' for i in model.inputs[-1]))

if __name__=='__main__':unittest.main()
