"""Bounded combat typed adapter and factual receipt checks; fake SDK only."""
import json
import unittest
from unittest.mock import patch
from agents.tool_context import ToolContext
from app import AttackSequenceStep, attack_sequence_receipt_summary, build_agent

class SequenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_typed_sequence_native_arguments_and_bounded_rejection(self):
        ctx={'apiKey':'fixture','model':'fixture','readRun':'fixture','worldId':'world','userId':'gm'}
        tool={t.name:t for t in build_agent(ctx).tools}['foundry_attack_sequence']
        step={'step_id':'one','scene_id':'scene','attacker_token_id':'attacker','actor_id':'actor','item_id':'item','activity_id':'activity','target_token_id':'target','advantage':'normal','attack_mode':None,'ammunition_id':None,'ability_id':None}
        args=json.dumps({'action_id':'stable','steps':[step],'max_duration_ms':8000})
        wrapper=ToolContext(context=ctx,tool_name=tool.name,tool_call_id='call',tool_arguments=args)
        with patch('app.read_foundry',return_value={'ok':True,'result':{'outcome':'partial'}}) as adapter:
            result=json.loads(await tool.on_invoke_tool(wrapper,args))
            self.assertEqual(result['outcome'],'partial')
            adapter.assert_awaited_once_with(ctx,'native_attack_sequence',{'actionId':'stable','action':{'mode':'execute','steps':[AttackSequenceStep(**step).native_step()],'maxDurationMs':8000}})
        args=json.dumps({'action_id':'stable','steps':[step,step],'max_duration_ms':8000})
        with patch('app.read_foundry') as adapter:
            self.assertFalse(json.loads(await tool.on_invoke_tool(wrapper,args))['ok'])
            adapter.assert_not_awaited()

    async def test_installed_sdk_persists_receipt_pair_reopens_and_next_turn_keeps_protocol(self):
        import tempfile
        from pathlib import Path
        from datetime import datetime, timezone
        from agents import Runner, RunConfig
        from chatkit.agents import AgentContext, stream_agent_response
        from chatkit.types import ThreadMetadata, ThreadItemDoneEvent
        from app import SqliteStore, PauseTimingHooks, ReceiptHistoryConverter
        from test_routine_completion import CommandModel
        ctx={'apiKey':'fixture','model':'fixture','readRun':'fixture','worldId':'world','userId':'gm','threadId':'thread'}
        args={'action_id':'resume-delivery','prior_sequence_request_id':'prior','continuation_id':'ticket','max_duration_ms':8000}
        receipt={'schemaVersion':'attack-sequence-v1','worldId':'world','userId':'gm','correlationId':'durable-sequence','outcome':'partial','state':{'completedStepCount':0,'steps':[],'continuation':{'id':'ticket','priorSequenceRequestId':'prior','nextStepIndex':0}}}
        with tempfile.TemporaryDirectory() as folder:
            path=str(Path(folder)/'fixture.sqlite');store=SqliteStore(path);thread=ThreadMetadata(id='thread',created_at=datetime.now(timezone.utc));await store.save_thread(thread,ctx)
            agentctx=AgentContext(thread=thread,store=store,request_context=ctx);agent=build_agent(ctx);model=CommandModel('foundry_resume_attack_sequence',args);agent.model=model
            with patch('app.read_foundry',return_value={'ok':True,'result':receipt}) as adapter:
                run=Runner.run_streamed(agent,'resume fixture',context=agentctx,hooks=PauseTimingHooks(ctx),run_config=RunConfig(tracing_disabled=True))
                events=[e async for e in stream_agent_response(agentctx,run)]
                self.assertEqual(adapter.await_count,1)
            self.assertEqual(model.calls,2)
            self.assertFalse(ctx.get('_narrationOnly',False))
            self.assertTrue(any(isinstance(e,ThreadItemDoneEvent) and e.item.id.startswith('msg_receipt_') for e in events))
            store.db.close();store=SqliteStore(path)
            try:
                history=await store.load_thread_items('thread',None,30,'asc',ctx);inputs=await ReceiptHistoryConverter().to_agent_input(history.data)
                self.assertEqual(sum(v.get('type')=='function_call' for v in inputs),1)
                self.assertEqual(sum(v.get('type')=='function_call_output' for v in inputs),1)
                replay_model=CommandModel('foundry_resume_attack_sequence',args);replay_model.calls=1
                agent=build_agent(ctx);agent.model=replay_model
                result=await Runner.run(agent,inputs,context=AgentContext(thread=thread,store=store,request_context=ctx),run_config=RunConfig(tracing_disabled=True))
                self.assertTrue(result.final_output)
                self.assertEqual(sum(item.id.startswith('msg_receipt_') for item in history.data),1)
            finally:store.db.close()

    def test_partial_receipt_distinguishes_roll_from_application(self):
        roll={'outcome':'confirmed','state':{'stage':'damage-rolled','attackRoll':{'total':19,'result':'15+4'},'hit':True,'critical':False,'damageRolls':[{'total':6,'type':'slashing','result':'4+2'}],'damageRolled':6}}
        receipt={'outcome':'partial','state':{'completedStepCount':0,'steps':[{'stepId':'one','rollReceipt':roll,'applyReceipt':None}],'continuation':None}}
        summary=attack_sequence_receipt_summary(receipt)
        self.assertIn('Damage rolled: 6',summary)
        self.assertIn('Damage not applied',summary)
        self.assertIn('Remaining steps are not confirmed',summary)
        self.assertNotIn('Damage applied:',summary)
        receipt['state']['completedStepCount']=True
        self.assertIsNone(attack_sequence_receipt_summary(receipt))

if __name__=='__main__':unittest.main()
