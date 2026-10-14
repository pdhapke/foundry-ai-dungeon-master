"""Independent new core-light boundary tests. Fake SDK model/native adapter only."""
import os
os.environ['AI_DM_CHATKIT_DATABASE_PATH']=':memory:'
import json,time,unittest,copy
from datetime import datetime,timezone
from unittest.mock import patch
from agents.tool_context import ToolContext
from agents import Runner,RunConfig
from chatkit.agents import AgentContext,stream_agent_response
from chatkit.types import ThreadMetadata
from app import build_agent,SqliteStore,PauseTimingHooks,ReceiptHistoryConverter,receipt_summary
from test_routine_completion import CommandModel

ARGS={'scene_id':'S','token_id':'T','light':{'bright':20,'color':None}}
def receipt():
    return {'worldId':'world','schemaVersion':'core-actions-v1','correlationId':'offline','outcome':'confirmed','action':{'kind':'token.light','sceneId':'S','targetId':'T','light':{'bright':20,'color':None}},'state':{'light':{'bright':20,'dim':40,'color':None,'alpha':0.5}}}

class CoreLightIndependent(unittest.IsolatedAsyncioTestCase):
    async def test_partial_patch_preserves_omissions_and_routes_existing_core(self):
        ctx={'model':'gpt-5.6-sol','apiKey':'offline','readRun':'offline'}
        tool=next(t for t in build_agent(ctx).tools if t.name=='foundry_set_token_light')
        self.assertIn('foundry_set_token_light',[t.name for t in build_agent(ctx).tools])
        encoded=json.dumps(ARGS)
        with patch('app.read_foundry',return_value={'ok':True,'result':receipt()}) as read:
            result=json.loads(await tool.on_invoke_tool(ToolContext(context=ctx,tool_name=tool.name,tool_call_id='offline',tool_arguments=encoded),encoded))
        read.assert_awaited_once_with(unittest.mock.ANY,'native_core_action',{'action':receipt()['action']})
        self.assertNotIn('dim',read.await_args.args[2]['action']['light'])
        self.assertNotIn('alpha',read.await_args.args[2]['action']['light'])
        self.assertEqual(result,receipt())

    async def test_first_model_response_can_set_without_discovery_and_durable_pair_recovers(self):
        store=SqliteStore(':memory:');ctx={'worldId':'world','userId':'gm','threadId':'thread','apiKey':'offline','model':'gpt-5.6-sol','readRun':'offline','_conversationStore':store,'_acceptanceBudget':{'scope':'independent-light','maxModelRequests':4,'expiresAt':time.time()+60}}
        thread=ThreadMetadata(id='thread',created_at=datetime.now(timezone.utc));await store.save_thread(thread,ctx)
        agent=build_agent(ctx);model=CommandModel('foundry_set_token_light',ARGS);agent.model=model
        self.assertEqual(agent.model_settings.max_tokens,1024)
        try:
            ac=AgentContext(thread=thread,store=store,request_context=ctx)
            with patch('app.read_foundry',return_value={'ok':True,'result':receipt()}) as read:
                result=Runner.run_streamed(agent,'Set exact placed token emission',context=ac,hooks=PauseTimingHooks(ctx),run_config=RunConfig(tracing_disabled=True),max_turns=4)
                _=[e async for e in stream_agent_response(ac,result)]
            self.assertLessEqual(model.calls,4)
            read.assert_awaited_once();self.assertEqual(read.await_args.args[1],'native_core_action')
            history=await store.load_thread_items('thread',None,20,'asc',ctx);inputs=await ReceiptHistoryConverter().to_agent_input(history.data)
            calls=[i for i in inputs if i.get('type')=='function_call'];outputs=[i for i in inputs if i.get('type')=='function_call_output']
            self.assertEqual(len(calls),1);self.assertEqual(calls[0]['name'],'foundry_set_token_light');self.assertEqual(calls[0]['call_id'],outputs[0]['call_id'])
            self.assertTrue(any(i.id.startswith('msg_receipt_') for i in history.data))
            self.assertEqual(store.db.execute('select consumed from acceptance_budgets').fetchone()[0],model.calls)
            before=model.calls;await store.load_thread_items('thread',None,20,'asc',ctx);self.assertEqual(model.calls,before)
        finally:store.db.close()

    def test_clear_partial_null_and_failure_receipt_do_not_invent_success(self):
        good=receipt();self.assertEqual(receipt_summary('foundry_set_token_light',good),'Token emitted light updated.')
        clear=receipt();clear['action']['light']={'bright':0,'dim':0};clear['state']['light'].update(bright=0,dim=0)
        self.assertEqual(receipt_summary('foundry_set_token_light',clear),'Token emitted light cleared.')
        for outcome in ['failure','uncertain','pending']:
            bad=receipt();bad['outcome']=outcome
            self.assertNotIn(receipt_summary('foundry_set_token_light',bad),['Token emitted light updated.','Token emitted light cleared.'])
        bad=receipt();bad['state']['light'].pop('color');self.assertIsNone(receipt_summary('foundry_set_token_light',bad))
        bad=receipt();bad['state']['light']['bright']=0;self.assertIsNone(receipt_summary('foundry_set_token_light',bad))



    def test_invalid_patch_fields_do_not_reach_native_transport(self):
        from app import TokenLightPatch
        from pydantic import ValidationError
        for bad in [{'bright':None},{'bright':True},{'bright':-1},{'dim':10001},{'alpha':1.01},{'alpha':float('nan')},{'bright':0.001},{'color':'blue'},{'vision':True}]:
            with self.assertRaises(ValidationError,msg=str(bad)):TokenLightPatch.model_validate(bad)
        with self.assertRaises(ValueError):TokenLightPatch().native_patch()
        self.assertEqual(TokenLightPatch.model_validate({'color':None}).native_patch(),{'color':None})
        self.assertEqual(TokenLightPatch.model_validate({'bright':0,'dim':0}).native_patch(),{'bright':0,'dim':0})

    def test_authenticated_nested_light_contract_requires_matching_world_target_and_patch(self):
        from app import RoutineCompletionContract,completed_contract_receipt
        contract=RoutineCompletionContract.model_validate({'version':1,'toolName':'foundry_set_token_light','arguments':ARGS})
        self.assertTrue(completed_contract_receipt(contract,receipt(),'world'))
        for changed in ['world','target','scene','patch','actual-null']:
            r=receipt()
            if changed=='world':r['worldId']='other'
            elif changed=='target':r['action']['targetId']='other'
            elif changed=='scene':r['action']['sceneId']='other'
            elif changed=='patch':r['action']['light']['bright']=0
            else:r['state']['light'].pop('color')
            self.assertFalse(completed_contract_receipt(contract,r,'world'),changed)

if __name__=='__main__':unittest.main()
