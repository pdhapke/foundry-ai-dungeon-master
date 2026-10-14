"""Offline lazy discovery/emitted-light receipts; no model/network/native mutation."""
import json
import unittest
from unittest.mock import patch
from agents.tool_context import ToolContext
from app import build_agent, prepared_instructions, agent_tool_schemas, receipt_summary
from working_context import assemble_input

class TokenLightTests(unittest.IsolatedAsyncioTestCase):
    async def invoke(self,name,args,response):
        context={'model':'gpt-5.6-sol','apiKey':'fixture','readRun':'fixture'}
        tools={t.name:t for t in build_agent(context).tools}
        encoded=json.dumps(args)
        call=ToolContext(context=context,tool_name=name,tool_call_id='fixture-light',tool_arguments=encoded)
        with patch('app.read_foundry',return_value=response) as adapter:
            result=json.loads(await tools[name].on_invoke_tool(call,encoded))
        return result,adapter

    async def test_dm_can_discover_load_and_execute_selected_light_capability(self):
        calls=[
            ('tool_search',{'query':'token emitted light','limit':4},'tool_search',{'query':'token emitted light','limit':4},{'ok':True,'result':{'tools':[{'id':'ai_dm_set_token_light'}]}}),
            ('tool_load',{'search_id':'search-light','tool_id':'ai_dm_set_token_light'},'tool_load',{'searchId':'search-light','toolId':'ai_dm_set_token_light'},{'ok':True,'result':{'grantId':'grant-light','allowedEffects':['session'],'schema':{'light':{'bright':'number'}}}}),
            ('tool_execute',{'grant_id':'grant-light','effect':'session','arguments':{'actionId':'light-step','action':{'kind':'token.light','sceneId':'scene','targetId':'token','light':{'bright':20}},'expectedState':{'light':{'bright':0,'dim':0}}}},'tool_execute',{'grantId':'grant-light','effect':'session','arguments':{'actionId':'light-step','action':{'kind':'token.light','sceneId':'scene','targetId':'token','light':{'bright':20}},'expectedState':{'light':{'bright':0,'dim':0}}}},{'ok':True,'result':{'status':'uncertain'}}),
        ]
        for name,args,operation,wire,response in calls:
            result,adapter=await self.invoke(name,args,response)
            adapter.assert_awaited_once_with(unittest.mock.ANY,operation,wire)
            self.assertEqual(result,response)
        self.assertIn('Token emission:',prepared_instructions())
        self.assertIn('Not vision/prototype/ambient',prepared_instructions())

    async def test_unavailable_capability_is_not_applied(self):
        response={'ok':False,'error':'Token emitted-light capability unavailable'}
        result,_=await self.invoke('tool_search',{'query':'token light'},response)
        self.assertEqual(result,response)
        self.assertIn('not confirmed',receipt_summary('tool_execute',result))

    def test_only_matching_authoritative_light_state_produces_success_summary(self):
        receipt={'outcome':'confirmed','schemaVersion':'core-actions-v1','action':{'kind':'token.light','light':{'bright':20,'color':'#AABBCC'}},'state':{'light':{'bright':20,'dim':0,'color':'#aabbcc'}}}
        self.assertEqual(receipt_summary('tool_execute',receipt),'Token emitted light updated.')
        receipt['state']['light']['bright']=19
        self.assertIsNone(receipt_summary('tool_execute',receipt))
        receipt['outcome']='uncertain'
        self.assertIn('not confirmed',receipt_summary('tool_execute',receipt))
        receipt['outcome']='confirmed'
        receipt['action']['light']={'bright':0,'dim':0}
        receipt['state']['light'].update(bright=0,dim=0)
        self.assertEqual(receipt_summary('tool_execute',receipt),'Token emitted light cleared.')

    def test_null_tint_reset_needs_observed_null_not_missing_and_known_fields(self):
        receipt={'outcome':'confirmed','schemaVersion':'core-actions-v1','action':{'kind':'token.light','light':{'color':None}},'state':{'light':{'bright':20,'dim':0}}}
        self.assertIsNone(receipt_summary('tool_execute',receipt))
        receipt['state']['light']['color']=None
        self.assertEqual(receipt_summary('tool_execute',receipt),'Token emitted light updated.')
        receipt['action']['light']={'unknown':1}
        receipt['state']['light']['unknown']=1
        self.assertIsNone(receipt_summary('tool_execute',receipt))

    def test_light_core_schema_remains_bounded(self):
        agent=build_agent({'model':'gpt-5.6-sol','apiKey':'fixture','readRun':'fixture'})
        self.assertEqual(len(agent.tools),31)
        self.assertIn('foundry_set_token_light', [t.name for t in agent.tools])
        _,evidence=assemble_input(prepared_instructions(),[{'role':'user','content':'Read light for this placed token.'}],window=32768,tool_schemas=agent_tool_schemas(agent))
        self.assertGreaterEqual(24576-evidence['tokenUpperBound'],4096)
        print(json.dumps({'tokenLightFullToolInputUnits':evidence['tokenUpperBound'],'remainingInputUnits':24576-evidence['tokenUpperBound']}))

if __name__=='__main__': unittest.main()
