"""Real SDK/application streams using fixture models only; never calls providers."""
import asyncio
import base64
import copy
import json
import os
import subprocess
from pathlib import Path
import time
import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from fastapi.testclient import TestClient
from chatkit.agents import AgentContext
from chatkit.types import ThreadMetadata, UserMessageItem, UserMessageTextContent, ErrorEvent
os.environ['AI_DM_CHATKIT_DATABASE_PATH'] = ':memory:'
from app import SqliteStore, FoundryChatKit, build_agent, ReceiptHistoryConverter, create_app
from test_routine_completion import CommandModel, CASES

PROMPT = 'Open door RsB12oN5v3LYI1XR in scene 2RJeJKqdpEE4VZPh. Change only that door. Return its confirmed receipt; do not add narration.'

def door_case():
    name, args, data = copy.deepcopy(CASES[1])
    args.update(scene_id='2RJeJKqdpEE4VZPh', door_id='RsB12oN5v3LYI1XR')
    data['action'].update(sceneId=args['scene_id'], targetId=args['door_id'])
    return name, args, data

def source_contract():
    # Use the actual trusted TS parser, not a duplicated Python text parser.
    body={'type':'threads.add_user_message','params':{'input':{'content':[{'type':'input_text','text':PROMPT}], 'attachments':[]}}}
    script='import {routineCompletion} from "./src/chatkit/routine-completion.ts"; console.log(JSON.stringify(routineCompletion('+json.dumps(body)+')));'
    result=subprocess.run(['node','--import','tsx','--input-type=module','-e',script],cwd=Path(__file__).resolve().parent.parent/'server',capture_output=True,text=True,check=True,timeout=15)
    return json.loads(result.stdout)

class FailingModel(CommandModel):
    async def get_response(self, *args, **kwargs):
        self.calls += 1
        raise RuntimeError('SECRET_PROVIDER_MESSAGE_DO_NOT_DISCLOSE')

class StreamFinalizationTests(unittest.IsolatedAsyncioTestCase):
    async def exercise(self, cap=True, contract=False, outcome='confirmed', failing=False, cancel=False):
        request={'worldId':'world','userId':'gm','threadId':'thread','apiKey':'offline','model':'fixture','readRun':'offline'}
        if cap: request['_acceptanceBudget']={'scope':'one-call','maxModelRequests':1,'expiresAt':time.time()+60}
        name,args,data=door_case()
        if contract: request['completionContract']={'version':1,'toolName':name,'arguments':args} if contract is True else contract
        store=SqliteStore(':memory:')
        self.addCleanup(store.db.close)
        thread=ThreadMetadata(id='thread',created_at=datetime.now(timezone.utc))
        await store.save_thread(thread,request)
        await store.add_thread_item(thread.id, UserMessageItem(id='user',thread_id=thread.id,created_at=datetime.now(timezone.utc),content=[UserMessageTextContent(text=PROMPT)],attachments=[],inference_options={}),request)
        agent=build_agent(request)
        model=(FailingModel if failing else CommandModel)(name,args)
        agent.model=model
        receipt={'schemaVersion':'core-actions-v1','outcome':outcome,'worldId':'world','correlationId':'receipt',**data}
        async def read(context, operation, arguments):
            return {'schemaVersion':1,'worldId':'world'} if operation=='initial_context' else {'ok':True,'result':receipt}
        with patch('app.build_agent',return_value=agent),patch('app.read_foundry',side_effect=read):
            if cancel:
                entered = asyncio.Event()
                async def blocked_delivery(*args, **kwargs):
                    entered.set()
                    await asyncio.Event().wait()
                async def consume():
                    return [e async for e in FoundryChatKit(store).respond(thread,None,request)]
                with patch.object(AgentContext,'stream',side_effect=blocked_delivery):
                    task = asyncio.create_task(consume())
                    await asyncio.wait_for(entered.wait(), 3)
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                    await asyncio.sleep(0)
                events=[]
            else:
                events=[e async for e in FoundryChatKit(store).respond(thread,None,request)]
        history=await store.load_thread_items(thread.id,None,20,'asc',request)
        converted=await ReceiptHistoryConverter().to_agent_input(history.data)
        return store,model,events,converted,history,request

    async def test_exact_prompt_cap_preserves_receipt_pair_and_readonly_reconnect(self):
        store,model,events,converted,history,request=await self.exercise()
        self.assertEqual(model.calls,1)
        errors=[e for e in events if isinstance(e,ErrorEvent)]
        self.assertEqual(len(errors),1)
        self.assertFalse(errors[0].allow_retry)
        self.assertIn('full request is not confirmed',errors[0].message)
        self.assertEqual(store.db.execute('SELECT consumed FROM acceptance_budgets').fetchone()[0],1)
        self.assertEqual(sum(i.get('type')=='function_call' for i in converted),1)
        self.assertEqual(sum(i.get('type')=='function_call_output' for i in converted),1)
        self.assertIn('Door opened.',str(converted))
        again=await store.load_thread_items('thread',None,20,'asc',request)
        self.assertEqual([i.model_dump() for i in history.data],[i.model_dump() for i in again.data])
        self.assertEqual(model.calls,1)

    async def test_trusted_receipt_only_finishes_cleanly_one_call(self):
        _,model,events,*_=await self.exercise(contract=True)
        self.assertEqual(model.calls,1)
        self.assertFalse(any(isinstance(e,ErrorEvent) for e in events))

    async def test_exact_ts_source_contract_completes_real_sdk_one_call(self):
        contract=source_contract()
        self.assertEqual(contract['arguments'],door_case()[1])
        store,model,events,converted,*_=await self.exercise(contract=contract)
        self.assertEqual(model.calls,1)
        self.assertEqual(store.db.execute('SELECT consumed FROM acceptance_budgets').fetchone()[0],1)
        self.assertFalse(any(isinstance(e,ErrorEvent) for e in events))
        self.assertEqual(sum(i.get('type')=='function_call' for i in converted),1)
        self.assertEqual(sum(i.get('type')=='function_call_output' for i in converted),1)
        self.assertIn('Door opened.',str(converted))

    async def test_normal_compound_retains_second_request(self):
        _,model,events,*_=await self.exercise(cap=False)
        self.assertEqual(model.calls,2)
        self.assertFalse(any(isinstance(e,ErrorEvent) for e in events))

    async def test_failed_uncertain_do_not_claim_success(self):
        for outcome in ('failed','uncertain'):
            _,model,events,converted,*_=await self.exercise(outcome=outcome)
            self.assertEqual(model.calls,1)
            self.assertTrue(any(isinstance(e,ErrorEvent) and not e.allow_retry for e in events))
            self.assertNotIn('Door opened.',str(converted))
            self.assertEqual(sum(i.get('type')=='function_call_output' for i in converted),1)

    async def test_capped_provider_failure_no_retry_or_secret(self):
        store,model,events,*_=await self.exercise(failing=True)
        self.assertEqual(model.calls,1)
        self.assertEqual(store.db.execute('SELECT consumed FROM acceptance_budgets').fetchone()[0],1)
        errors=[e for e in events if isinstance(e,ErrorEvent)]
        self.assertEqual(len(errors),1)
        self.assertFalse(errors[0].allow_retry)
        self.assertNotIn('SECRET',str(errors))

    async def test_ordinary_pre_tool_exception_not_masked(self):
        with self.assertRaisesRegex(RuntimeError,'SECRET_PROVIDER'):
            await self.exercise(cap=False,failing=True)

    async def test_cancelled_receipt_delivery_preserves_committed_evidence(self):
        _,model,_,converted,*_=await self.exercise(cancel=True)
        self.assertEqual(model.calls,1)
        self.assertEqual(sum(i.get('type')=='function_call' for i in converted),1)
        self.assertEqual(sum(i.get('type')=='function_call_output' for i in converted),1)
        self.assertIn('Door opened.',str(converted))

    async def test_official_chatkit_http_stream_keeps_nonretry_terminal_event(self):
        store=SqliteStore(':memory:')
        self.addCleanup(store.db.close)
        principal={'worldId':'world','userId':'gm','isGm':True}
        await store.save_thread(ThreadMetadata(id='thread',created_at=datetime.now(timezone.utc)),principal)
        trace='12345678-1234-1234-1234-123456789abc'
        binding={**{k:principal[k] for k in ('worldId','userId')},'threadId':'thread','traceId':trace,'maxModelRequests':1,'expiresAt':datetime.fromtimestamp(time.time()+60,timezone.utc).isoformat()}
        name,args,data=door_case()
        model=CommandModel(name,args)
        real_builder=build_agent
        def builder(context):
            agent=real_builder(context)
            agent.model=model
            return agent
        receipt={'schemaVersion':'core-actions-v1','outcome':'confirmed','worldId':'world','correlationId':'receipt',**data}
        headers={'x-chatkit-secret':'offline-secret','x-chatkit-principal':base64.b64encode(json.dumps(principal).encode()).decode(),'x-chatkit-trace':trace,'x-chatkit-acceptance-fixture':'offline','x-chatkit-model':'fixture','x-chatkit-api-key':'offline','x-chatkit-read-run':'offline'}
        body={'type':'threads.add_user_message','params':{'thread_id':'thread','input':{'content':[{'type':'input_text','text':PROMPT}],'attachments':[],'inference_options':{}}}}
        with patch.dict(os.environ,{'AI_DM_ACCEPTANCE_FIXTURES_JSON':json.dumps({'offline':binding})}),patch('app.build_agent',side_effect=builder),patch('app.read_foundry',return_value={'ok':True,'result':receipt}):
            with TestClient(create_app(store=store,secret='offline-secret')) as client:
                response=client.post('/chatkit',headers=headers,json=body)
        events=[json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
        errors=[e for e in events if e['type']=='error']
        self.assertEqual(response.status_code,200)
        self.assertEqual(len(errors),1)
        self.assertFalse(errors[0]['allow_retry'])
        self.assertEqual(errors[0]['code'],'custom')
        self.assertIn('Door opened.',response.text)
        self.assertEqual(model.calls,1)

    async def test_exact_authenticated_header_contract_finishes_http_stream(self):
        store=SqliteStore(':memory:')
        self.addCleanup(store.db.close)
        principal={'worldId':'world','userId':'gm','isGm':True}
        await store.save_thread(ThreadMetadata(id='thread',created_at=datetime.now(timezone.utc)),principal)
        trace='12345678-1234-1234-1234-123456789abc'
        binding={'worldId':'world','userId':'gm','threadId':'thread','traceId':trace,'maxModelRequests':1,'expiresAt':datetime.fromtimestamp(time.time()+60,timezone.utc).isoformat()}
        name,args,data=door_case()
        model=CommandModel(name,args)
        real_builder=build_agent
        def builder(context):
            agent=real_builder(context)
            agent.model=model
            return agent
        receipt={'schemaVersion':'core-actions-v1','outcome':'confirmed','worldId':'world','correlationId':'receipt',**data}
        headers={'x-chatkit-secret':'offline-secret','x-chatkit-principal':base64.b64encode(json.dumps(principal).encode()).decode(),'x-chatkit-trace':trace,'x-chatkit-acceptance-fixture':'offline','x-chatkit-model':'fixture','x-chatkit-api-key':'offline','x-chatkit-read-run':'offline','x-chatkit-completion':base64.b64encode(json.dumps(source_contract()).encode()).decode()}
        body={'type':'threads.add_user_message','params':{'thread_id':'thread','input':{'content':[{'type':'input_text','text':PROMPT}],'attachments':[],'inference_options':{}}}}
        with patch.dict(os.environ,{'AI_DM_ACCEPTANCE_FIXTURES_JSON':json.dumps({'offline':binding})}),patch('app.build_agent',side_effect=builder),patch('app.read_foundry',return_value={'ok':True,'result':receipt}):
            with TestClient(create_app(store=store,secret='offline-secret')) as client:
                response=client.post('/chatkit',headers=headers,json=body)
        self.assertEqual(response.status_code,200)
        events=[json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
        self.assertFalse(any(e['type']=='error' for e in events))
        self.assertIn('Door opened.',response.text)
        self.assertEqual(model.calls,1)
        self.assertEqual(store.db.execute('SELECT consumed FROM acceptance_budgets').fetchone()[0],1)

if __name__=='__main__': unittest.main()
