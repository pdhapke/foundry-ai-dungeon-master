import json, unittest
from unittest.mock import patch
from agents.tool_context import ToolContext
from pydantic import ValidationError
from app import build_agent, TokenLightPatch, RoutineCompletionContract, completed_contract_receipt, receipt_summary

class TokenLightCoreTests(unittest.IsolatedAsyncioTestCase):
    async def invoke(self, light, response):
        context={'model':'gpt-5.6-sol','apiKey':'fixture','readRun':'fixture'}
        tool=next(t for t in build_agent(context).tools if t.name=='foundry_set_token_light')
        args=json.dumps({'scene_id':'scene','token_id':'token','light':light})
        call=ToolContext(context=context,tool_name=tool.name,tool_call_id='fixture',tool_arguments=args)
        with patch('app.read_foundry',return_value=response) as adapter:
            result=json.loads(await tool.on_invoke_tool(call,args))
        return result, adapter

    async def test_first_turn_partial_routes_without_discovery(self):
        receipt={'outcome':'confirmed'}
        result, adapter=await self.invoke({'bright':10}, {'ok':True,'result':receipt})
        self.assertEqual(result,receipt)
        adapter.assert_awaited_once_with(unittest.mock.ANY,'native_core_action',{'action':{'kind':'token.light','sceneId':'scene','targetId':'token','light':{'bright':10}}})

    async def test_clear_and_null_color_preserve_only_supplied_fields(self):
        for light in ({'bright':0,'dim':0},{'color':None},{'alpha':0.25}):
            _, adapter=await self.invoke(light,{'ok':True,'result':{'outcome':'confirmed'}})
            self.assertEqual(adapter.call_args.args[2]['action']['light'],light)

    async def test_unsupported_unauthorized_and_uncertain_are_not_success(self):
        for response in ({'ok':False,'error':'Unauthorized'}, {'ok':False,'error':'Unsupported target'}, {'ok':True,'result':{'outcome':'uncertain'}}):
            result,_=await self.invoke({'dim':15},response)
            self.assertNotEqual(receipt_summary('foundry_set_token_light',result),'Token emitted light updated.')

    async def test_clean_sdk_completion_persists_pair_and_receipt_in_one_request(self):
        from test_routine_completion import CompletionTests
        case=('foundry_set_token_light', {'scene_id':'S','token_id':'T','light':{'bright':12.5,'dim':25}}, {'action':{'kind':'token.light','sceneId':'S','targetId':'T','light':{'bright':12.5,'dim':25}},'state':{'light':{'bright':12.5,'dim':25,'color':None,'alpha':0.5}}})
        model,events,inputs=await CompletionTests().run_case(case)
        self.assertEqual(model.calls,1)
        self.assertEqual(sum(i.get('type')=='function_call' for i in inputs),1)
        self.assertEqual(sum(i.get('type')=='function_call_output' for i in inputs),1)
        self.assertTrue(any(i.get('role')=='assistant' for i in inputs))
        self.assertFalse(any(getattr(e,'type',None)=='error' for e in events))

    def test_validation_and_omission(self):
        for light in ({'bright':True},{'bright':-1},{'dim':10001},{'dim':1.001},{'alpha':None},{'alpha':2},{'color':'red'},{'vision':30}):
            with self.subTest(light=light), self.assertRaises(ValidationError): TokenLightPatch.model_validate(light)
        with self.assertRaises(ValueError): TokenLightPatch().native_patch()
        self.assertEqual(TokenLightPatch.model_validate({'bright':10.01}).native_patch(),{'bright':10.01})

    def test_exact_receipt_completion_and_mismatch(self):
        contract=RoutineCompletionContract.model_validate({'version':1,'toolName':'foundry_set_token_light','arguments':{'scene_id':'scene','token_id':'token','light':{'bright':10}}})
        receipt={'worldId':'world','outcome':'confirmed','schemaVersion':'core-actions-v1','action':{'kind':'token.light','sceneId':'scene','targetId':'token','light':{'bright':10}},'state':{'light':{'bright':10,'dim':20,'color':'#aabbcc','alpha':0.5}}}
        self.assertTrue(completed_contract_receipt(contract,receipt,'world'))
        receipt['state']['light']['bright']=9
        self.assertFalse(completed_contract_receipt(contract,receipt,'world'))
        receipt['state']['light']['bright']=10
        self.assertFalse(completed_contract_receipt(contract,receipt,'other-world'))

if __name__=='__main__': unittest.main()
