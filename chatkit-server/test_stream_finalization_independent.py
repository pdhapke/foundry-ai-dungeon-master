"""Independent real SDK fake-model streaming, never external inference/native mutation."""
import os
os.environ['AI_DM_CHATKIT_DATABASE_PATH'] = ':memory:'
import json
import time
import unittest
import tempfile
from pathlib import Path
from datetime import datetime, timezone
from unittest.mock import patch
from agents import Runner, RunConfig
from agents.exceptions import MaxTurnsExceeded
from chatkit.agents import AgentContext, stream_agent_response
from chatkit.types import ThreadMetadata, UserMessageItem
from app import SqliteStore, FoundryChatKit, build_agent, PauseTimingHooks, ReceiptHistoryConverter
from working_context import ContextCapacityError
from test_routine_completion import CommandModel

PROMPT = 'Open door RsB12oN5v3LYI1XR in scene 2RJeJKqdpEE4VZPh. Change only that door. Return its confirmed receipt; do not add narration.'
ARGS = {'scene_id': '2RJeJKqdpEE4VZPh', 'door_id': 'RsB12oN5v3LYI1XR', 'state': 'open'}


class IndependentStreamFinalization(unittest.IsolatedAsyncioTestCase):
    async def fixture(self, contract=False, outcome='confirmed', path=':memory:'):
        store = SqliteStore(path)
        ctx = {'worldId': 'world', 'userId': 'gm', 'threadId': 'thread', 'model': 'gpt-5.6-sol', 'apiKey': 'offline-only', 'readRun': 'offline', '_conversationStore': store,
               '_acceptanceBudget': {'scope': 'offline-fixture', 'maxModelRequests': 1, 'expiresAt': time.time()+300}}
        if contract:
            ctx['completionContract'] = {'version': 1, 'toolName': 'foundry_set_door_state', 'arguments': ARGS}
        thread = ThreadMetadata(id='thread', created_at=datetime.now(timezone.utc))
        await store.save_thread(thread, ctx)
        message = UserMessageItem.model_validate({'id': 'msg_user', 'thread_id': 'thread', 'created_at': datetime.now(timezone.utc), 'type': 'user_message', 'content': [{'type': 'input_text', 'text': PROMPT}], 'attachments': [], 'inference_options': {}})
        await store.add_thread_item('thread', message, ctx)
        receipt = {'schemaVersion': 'core-actions-v1', 'worldId': 'world', 'correlationId': 'offline-receipt', 'outcome': outcome, 'action': {'kind': 'door.state', 'sceneId': ARGS['scene_id'], 'targetId': ARGS['door_id'], 'value': 1}, 'state': {'ds': 1}}
        model = CommandModel('foundry_set_door_state', ARGS)
        agent = build_agent(ctx)
        agent.model = model
        return store, ctx, thread, message, receipt, model, agent

    async def inspect_protocol(self, store, ctx):
        history = await store.load_thread_items('thread', None, 20, 'asc', ctx)
        inputs = await ReceiptHistoryConverter().to_agent_input(history.data)
        calls = [x for x in inputs if x.get('type') == 'function_call']
        outputs = [x for x in inputs if x.get('type') == 'function_call_output']
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(outputs), 1)
        self.assertEqual(calls[0]['call_id'], outputs[0]['call_id'])
        self.assertEqual(store.db.execute('select consumed from acceptance_budgets').fetchone()[0], 1)
        return history

    async def test_real_sdk_exact_uncontracted_prompt_hits_limit_after_one_confirmed_call(self):
        store, ctx, thread, message, receipt, model, agent = await self.fixture()
        try:
            ac = AgentContext(thread=thread, store=store, request_context=ctx)
            with patch('app.read_foundry', return_value={'ok': True, 'result': receipt}):
                run = Runner.run_streamed(agent, PROMPT, context=ac, hooks=PauseTimingHooks(ctx), run_config=RunConfig(tracing_disabled=True), max_turns=1)
                events = []
                with self.assertRaises(MaxTurnsExceeded):
                    async for event in stream_agent_response(ac, run):
                        events.append(event)
            self.assertEqual(model.calls, 1)
            await self.inspect_protocol(store, ctx)
            self.assertTrue(any(getattr(getattr(e, 'item', None), 'id', '').startswith('msg_receipt_') for e in events))
        finally:
            store.db.close()

    async def test_respond_keeps_confirmed_receipt_and_nonretry_partial_terminal_state(self):
        await self.respond_case(False, 'confirmed')

    async def test_respond_does_not_claim_success_from_uncertain_tool(self):
        await self.respond_case(False, 'uncertain')

    async def test_matching_trusted_completion_contract_stays_clean_one_call(self):
        await self.respond_case(True, 'confirmed')

    async def test_unrelated_stream_exception_is_not_reclassified_as_budget_completion(self):
        store, ctx, thread, message, receipt, model, agent = await self.fixture()
        ctx.pop('_acceptanceBudget')
        async def unrelated(*args):
            raise RuntimeError('independent unrelated stream failure')
            yield
        try:
            with patch('app.build_agent', return_value=agent), patch('app.read_foundry', return_value={}), patch('app.stream_agent_response', side_effect=unrelated):
                with self.assertRaisesRegex(RuntimeError, 'independent unrelated'):
                    _ = [e async for e in FoundryChatKit(store).respond(thread, message, ctx)]
        finally:
            store.db.close()

    async def test_fixture_stream_failure_is_nonretry_and_redacts_exception_text(self):
        store, ctx, thread, message, receipt, model, agent = await self.fixture()
        async def failure(*args):
            raise RuntimeError('offline-secret-marker-must-not-leak')
            yield
        try:
            with patch('app.build_agent', return_value=agent), patch('app.read_foundry', return_value={}), patch('app.stream_agent_response', side_effect=failure), patch('app.trace') as trace:
                events = [e async for e in FoundryChatKit(store).respond(thread, message, ctx)]
            errors = [e for e in events if getattr(e, 'type', None) == 'error']
            self.assertEqual(len(errors), 1)
            self.assertFalse(errors[0].allow_retry)
            self.assertIn('not confirmed', errors[0].message)
            self.assertNotIn('offline-secret-marker', errors[0].message)
            self.assertNotIn('offline-secret-marker', repr(trace.call_args_list))
        finally:
            store.db.close()

    async def test_durable_restart_reads_preserved_pair_receipt_and_exhausted_budget_without_replay(self):
        with tempfile.TemporaryDirectory(prefix='independent-stream-recovery-') as directory:
            path = str(Path(directory) / 'conversation.sqlite')
            store, ctx, thread, message, receipt, model, agent = await self.fixture(path=path)
            async def read(_ctx, operation, args=None):
                return {} if operation == 'initial_context' else {'ok': True, 'result': receipt}
            with patch('app.build_agent', return_value=agent), patch('app.read_foundry', side_effect=read):
                _ = [e async for e in FoundryChatKit(store).respond(thread, message, ctx)]
            first = await store.load_thread_items('thread', None, 20, 'asc', ctx)
            ids = [i.id for i in first.data]
            self.assertEqual(model.calls, 1)
            store.db.close()
            reopened = SqliteStore(path)
            recovered = {**ctx, '_conversationStore': reopened}
            try:
                self.assertEqual((await reopened.load_thread('thread', recovered)).id, thread.id)
                second = await reopened.load_thread_items('thread', None, 20, 'asc', recovered)
                self.assertEqual([i.id for i in second.data], ids)
                self.assertEqual([i.model_dump(mode='json') for i in second.data], [i.model_dump(mode='json') for i in first.data])
                self.assertTrue(any(i.id.startswith('msg_receipt_') for i in second.data))
                self.assertIn('Door opened.', [p.text for i in second.data if i.id.startswith('msg_receipt_') for p in i.content])
                await self.inspect_protocol(reopened, recovered)
                with self.assertRaises(ContextCapacityError):
                    reopened.consume_acceptance_request('offline-fixture', 1)
                self.assertEqual(reopened.db.execute('select consumed from acceptance_budgets').fetchone()[0], 1)
                self.assertEqual(model.calls, 1)
            finally:
                reopened.db.close()

    async def test_ordinary_attempted_tool_then_fake_provider_failure_preserves_receipt_nonretry(self):
        store, ctx, thread, message, receipt, _, agent = await self.fixture()
        ctx.pop('_acceptanceBudget')
        class FailureAfterDoor(CommandModel):
            attempts = 0
            async def get_response(self, *args, **kwargs):
                self.attempts += 1
                if self.attempts > 1:
                    raise RuntimeError('offline provider detail must remain private')
                return await super().get_response(*args, **kwargs)
        model = FailureAfterDoor('foundry_set_door_state', ARGS)
        agent.model = model
        async def read(_ctx, operation, args=None):
            return {} if operation == 'initial_context' else {'ok': True, 'result': receipt}
        try:
            with patch('app.build_agent', return_value=agent), patch('app.read_foundry', side_effect=read):
                events = [e async for e in FoundryChatKit(store).respond(thread, message, ctx)]
            errors = [e for e in events if getattr(e, 'type', None) == 'error']
            self.assertEqual(len(errors), 1)
            self.assertFalse(errors[0].allow_retry)
            self.assertIn('not confirmed', errors[0].message)
            self.assertNotIn('offline provider detail', errors[0].message)
            self.assertEqual(model.attempts, 2)
            history = await store.load_thread_items('thread', None, 20, 'asc', ctx)
            inputs = await ReceiptHistoryConverter().to_agent_input(history.data)
            self.assertEqual(sum(i.get('type') == 'function_call' for i in inputs), 1)
            self.assertEqual(sum(i.get('type') == 'function_call_output' for i in inputs), 1)
            self.assertTrue(any(i.id.startswith('msg_receipt_') for i in history.data))
            self.assertEqual(store.db.execute('select count(*) from acceptance_budgets').fetchone()[0], 0)
        finally:
            store.db.close()

    async def respond_case(self, contract, outcome):
        store, ctx, thread, message, receipt, model, agent = await self.fixture(contract, outcome)
        async def read(_ctx, operation, args=None):
            return {'ok': True, 'result': {}} if operation == 'initial_context' else {'ok': True, 'result': receipt}
        try:
            with patch('app.build_agent', return_value=agent), patch('app.read_foundry', side_effect=read):
                events = [e async for e in FoundryChatKit(store).respond(thread, message, ctx)]
            self.assertEqual(model.calls, 1)
            history = await self.inspect_protocol(store, ctx)
            errors = [e for e in events if getattr(e, 'type', None) == 'error']
            if contract:
                self.assertFalse(errors)
            else:
                self.assertEqual(len(errors), 1)
                self.assertFalse(errors[0].allow_retry)
                self.assertTrue(errors[0].message)
            receipts = [i for i in history.data if i.id.startswith('msg_receipt_')]
            self.assertTrue(receipts)
            texts = [part.text for i in receipts for part in i.content]
            if outcome == 'confirmed':
                self.assertIn('Door opened.', texts)
            else:
                self.assertTrue(any('completion is not confirmed' in text for text in texts))
                self.assertNotIn('Door opened.', texts)
        finally:
            store.db.close()


if __name__ == '__main__':
    unittest.main()

# Additional independent receipt eligibility checks use no provider or native state.
class ReceiptOnlyEligibility(unittest.IsolatedAsyncioTestCase):
    async def test_mismatches_pending_multitool_and_nondurable_cannot_finalize(self):
        from types import SimpleNamespace
        from copy import deepcopy
        from app import pause_receipt_final
        request = {'worldId':'world', 'completionContract':{'version':1,'toolName':'foundry_set_door_state','arguments':ARGS},'_completionExecution':{'requests':1,'calls':1,'durable':True,'arguments':ARGS}}
        receipt = {'schemaVersion':'core-actions-v1','worldId':'world','correlationId':'offline','outcome':'confirmed','action':{'kind':'door.state','sceneId':ARGS['scene_id'],'targetId':ARGS['door_id'],'value':1},'state':{'ds':1}}
        tool = next(t for t in build_agent({'worldId':'world','userId':'gm','model':'gpt-5.6-sol','apiKey':'offline-only','readRun':'offline'}).tools if t.name == 'foundry_set_door_state')
        async def finish(req, rec, count=1):
            result=SimpleNamespace(tool=tool,output=json.dumps(rec))
            return await pause_receipt_final(SimpleNamespace(context=SimpleNamespace(request_context=req)),[result]*count)
        self.assertTrue((await finish(request,receipt)).is_final_output)
        for field,value in [('worldId','other'),('outcome','pending'),('schemaVersion','wrong')]:
            changed=deepcopy(receipt);changed[field]=value
            self.assertFalse((await finish(request,changed)).is_final_output,field)
        for field,value in [('sceneId','wrong'),('targetId','wrong'),('value',0)]:
            changed=deepcopy(receipt);changed['action'][field]=value
            self.assertFalse((await finish(request,changed)).is_final_output,field)
        changed=deepcopy(receipt);changed['state']['ds']=0
        self.assertFalse((await finish(request,changed)).is_final_output)
        self.assertFalse((await finish(request,receipt,2)).is_final_output)
        for field,value in [('durable',False),('calls',2),('requests',2),('arguments',{**ARGS,'state':'closed'})]:
            changed=deepcopy(request);changed['_completionExecution'][field]=value
            self.assertFalse((await finish(changed,receipt)).is_final_output,field)

if __name__ == '__main__':
    unittest.main()
