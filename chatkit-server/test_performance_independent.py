"""Independent installed-SDK acceptance. All model/network execution is fake."""
import copy
import json
import unittest
from app import RoutineCompletionContract, completed_contract_receipt, receipt_summary
from test_routine_completion import CASES, CompletionTests as WorkerCompletionTests


class IndependentCompletionTests(WorkerCompletionTests):
    async def run_case(self, case, change=None, contract=True, retrieval=False):
        return await super().run_case(copy.deepcopy(case),change,contract,retrieval)
    async def test_each_command_incomplete_readback_requires_continuation(self):
        for source in CASES[1:]:
            case=copy.deepcopy(source)
            model,_,_=await self.run_case(case,lambda receipt:receipt.update(state={}))
            self.assertEqual(model.calls,2,case[0])
    async def test_every_command_world_mismatch_requires_continuation(self):
        for source in CASES:
            model,_,_=await self.run_case(copy.deepcopy(source),lambda receipt:receipt.update(worldId='other'))
            self.assertEqual(model.calls,2,source[0])
    async def test_reconnect_protocol_history_is_valid_for_every_command_next_turn(self):
        from agents import Runner,RunConfig
        from app import build_agent
        for source in CASES:
            model,events,inputs=await self.run_case(copy.deepcopy(source))
            self.assertEqual(model.calls,1)
            agent=build_agent({'apiKey':'fixture','model':'fixture'});agent.model=model
            await Runner.run(agent,inputs+[{'role':'user','content':'What happened?'}],run_config=RunConfig(tracing_disabled=True))
            self.assertEqual(model.calls,2)
            pair=[i for i in model.inputs[-1] if i.get('type') in ['function_call','function_call_output']]
            self.assertEqual(len(pair),2)
            self.assertEqual(pair[0]['call_id'],pair[1]['call_id'])
    async def test_multiple_tool_calls_cannot_complete_after_first_confirmed_result(self):
        from unittest.mock import patch
        from test_routine_completion import CommandModel
        from openai.types.responses import ResponseFunctionToolCall
        original=CommandModel.get_response
        async def double(model,*args,**kwargs):
            first=model.calls==0
            response=await original(model,*args,**kwargs)
            if first:
                response.output.append(ResponseFunctionToolCall(type='function_call',name=model.name,arguments=json.dumps(model.args),call_id='second-call',id='second-tool'))
            return response
        with patch.object(CommandModel,'get_response',double):
            model,_,inputs=await self.run_case(copy.deepcopy(CASES[3]))
        self.assertEqual(model.calls,2)
        self.assertEqual(sum(i.get('type')=='function_call' for i in inputs),2)
        self.assertEqual(sum(i.get('type')=='function_call_output' for i in inputs),2)
    def test_boolean_numeric_receipts_do_not_satisfy_integer_state(self):
        name,args,data=copy.deepcopy(CASES[3]);args['value']=1
        data['action']['value']=1;data['state']['value']=True
        receipt={'outcome':'confirmed','worldId':'world','schemaVersion':'core-actions-v1',**data}
        self.assertFalse(completed_contract_receipt(RoutineCompletionContract(version=1,toolName=name,arguments=args),receipt,'world'))

if __name__=='__main__': unittest.main()


