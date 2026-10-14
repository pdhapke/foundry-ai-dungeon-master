"""Installed SDK fake-model coverage. No provider requests or running Foundry calls."""
import base64
import copy
import os
import json
import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from agents import Runner, RunConfig
from agents.exceptions import MaxTurnsExceeded
from fastapi.testclient import TestClient
from agents.items import ModelResponse
from agents.usage import Usage
from chatkit.agents import AgentContext, stream_agent_response
from chatkit.types import ThreadMetadata
from openai.types.responses import ResponseFunctionToolCall
from app import SqliteStore, build_agent, PauseTimingHooks, ReceiptHistoryConverter, decode_completion_header, max_model_turns, create_app
from test_routine_speed_independent import FixtureModel

CASES = [
 ('foundry_set_pause_state', {'paused': False}, {'outcome':'confirmed','worldId':'world','paused':False}),
 ('foundry_set_door_state', {'scene_id':'S','door_id':'D','state':'open'}, {'action':{'kind':'door.state','sceneId':'S','targetId':'D','value':1},'state':{'ds':1}}),
 ('foundry_move_token', {'scene_id':'S','token_id':'T','x':40,'y':60,'mode':'walk'}, {'action':{'kind':'token.position','sceneId':'S','targetId':'T','x':40,'y':60,'mode':'walk'},'state':{'x':40,'y':60}}),
 ('foundry_set_actor_hp', {'scene_id':'S','actor_id':'A','value':12}, {'action':{'kind':'actor.hp','sceneId':'S','targetId':'A','value':12},'state':{'value':12}}),
 ('foundry_set_actor_condition', {'scene_id':'S','actor_id':'A','condition_id':'poisoned','active':True}, {'action':{'kind':'actor.condition','sceneId':'S','targetId':'A','conditionId':'poisoned','active':True},'state':{'active':True}}),
 ('foundry_advance_combat_turn', {'scene_id':'S','combat_id':'C'}, {'action':{'kind':'combat.next','sceneId':'S','targetId':'C'},'state':{'round':1,'turn':2}}),
 ('foundry_set_initiative', {'scene_id':'S','combat_id':'C','combatant_id':'B','value':-2}, {'action':{'kind':'combat.initiative','sceneId':'S','targetId':'C','combatantId':'B','value':-2},'state':{'initiative':-2}}),
 ('foundry_roll_dice', {'formula':'2d6+3'}, {'action':{'kind':'dice.roll','formula':'2d6+3'},'state':{'total':9,'result':'3 + 3 + 3'}}),
 ('foundry_roll_actor', {'scene_id':'S','actor_id':'A','roll_type':'save','key':'dex'}, {'action':{'kind':'system.roll','sceneId':'S','targetId':'A','rollType':'save','key':'dex'},'state':{'rolls':[{'total':12,'result':'10 + 2'}]}}),
]

class CommandModel(FixtureModel):
    def __init__(self, name, args, retrieval=False):
        super().__init__()
        self.name, self.args, self.retrieval = name, args, retrieval
    async def get_response(self, *args, **kwargs):
        if self.calls == 0 or (self.retrieval and self.calls == 1):
            self.calls += 1
            self.inputs.append(args[1] if len(args)>1 else kwargs['input'])
            name, arguments = ('foundry_read_play_state', {}) if self.retrieval and self.calls == 1 else (self.name, self.args)
            return ModelResponse(output=[ResponseFunctionToolCall(type='function_call',name=name,arguments=json.dumps(arguments),call_id='call-'+str(self.calls),id='tool-'+str(self.calls))],usage=Usage(),response_id='response-'+str(self.calls))
        return await super().get_response(*args, **kwargs)

class CompletionTests(unittest.IsolatedAsyncioTestCase):
    async def run_case(self, case, change=None, contract=True, retrieval=False):
        name,args,data = copy.deepcopy(case)
        receipt = {'schemaVersion':'core-actions-v1','outcome':'confirmed','worldId':'world','correlationId':'receipt',**data}
        if change: change(receipt)
        request={'worldId':'world','userId':'gm','threadId':'thread','apiKey':'fixture','model':'fixture','readRun':'fixture'}
        if contract: request['completionContract']={'version':1,'toolName':name,'arguments':args}
        store=SqliteStore(':memory:')
        thread=ThreadMetadata(id='thread',created_at=datetime.now(timezone.utc))
        await store.save_thread(thread,request)
        ctx=AgentContext(thread=thread,store=store,request_context=request)
        model=CommandModel(name,args,retrieval)
        agent=build_agent(request); agent.model=model
        with patch('app.read_foundry',return_value={'ok':True,'result':receipt}):
            run=Runner.run_streamed(agent,'fixture',context=ctx,hooks=PauseTimingHooks(request),run_config=RunConfig(tracing_disabled=True))
            events=[e async for e in stream_agent_response(ctx,run)]
        history=await store.load_thread_items('thread',None,20,'asc',request)
        inputs=await ReceiptHistoryConverter().to_agent_input(history.data)
        store.db.close()
        return model,events,inputs

    async def test_all_nine_commands_complete_in_one_request_with_durable_pair_and_receipt(self):
        for case in CASES:
            with self.subTest(tool=case[0]):
                model,events,inputs=await self.run_case(case)
                self.assertEqual(model.calls,1)
                self.assertEqual(sum(i.get('type')=='function_call' for i in inputs),1)
                self.assertEqual(sum(i.get('type')=='function_call_output' for i in inputs),1)
                self.assertTrue(any(i.get('role')=='assistant' for i in inputs))
                self.assertTrue(events)

    async def test_uncertain_wrong_world_wrong_action_and_unsatisfied_state_continue(self):
        changes=[lambda r:r.update(outcome='uncertain'),lambda r:r.update(worldId='other'),lambda r:r['action'].update(targetId='other'),lambda r:r['state'].update(value=11),lambda r:r.update(schemaVersion='unknown')]
        for change in changes:
            model,_,_=await self.run_case(CASES[3],change)
            self.assertEqual(model.calls,2)

    async def test_missing_contract_and_retrieval_first_do_not_complete_early(self):
        model,_,_=await self.run_case(CASES[3],contract=False)
        self.assertEqual(model.calls,2)
        model,_,_=await self.run_case(CASES[3],retrieval=True)
        self.assertEqual(model.calls,3)

    async def test_one_turn_limit_eligible_completes_and_ambiguous_never_makes_second_request(self):
        with patch.dict(os.environ, {"AI_DM_CHATKIT_MAX_TURNS": "1"}):
            self.assertIsNone(max_model_turns())
            for eligible in (True, False):
                request={"worldId":"world","userId":"gm","threadId":"thread","apiKey":"fixture","model":"fixture","readRun":"fixture"}
                name,args,data=copy.deepcopy(CASES[3])
                if eligible: request["completionContract"]={"version":1,"toolName":name,"arguments":args}
                store=SqliteStore(":memory:")
                thread=ThreadMetadata(id="thread",created_at=datetime.now(timezone.utc))
                await store.save_thread(thread,request)
                ctx=AgentContext(thread=thread,store=store,request_context=request)
                model=CommandModel(name,args)
                agent=build_agent(request); agent.model=model
                receipt={"schemaVersion":"core-actions-v1","outcome":"confirmed","worldId":"world","correlationId":"receipt",**data}
                with patch("app.read_foundry",return_value={"ok":True,"result":receipt}):
                    run=Runner.run_streamed(agent,"fixture",context=ctx,hooks=PauseTimingHooks(request),run_config=RunConfig(tracing_disabled=True),max_turns=1)
                    if eligible:
                        events=[e async for e in stream_agent_response(ctx,run)]
                    else:
                        with self.assertRaises(MaxTurnsExceeded):
                            events=[e async for e in stream_agent_response(ctx,run)]
                self.assertEqual(model.calls,1)
                store.db.close()

    def test_health_reports_nonsecret_loaded_turn_limit(self):
        store=SqliteStore(":memory:")
        try:
            with patch.dict(os.environ, {"AI_DM_CHATKIT_MAX_TURNS":"1"}):
                with TestClient(create_app(store=store,secret="fixture")) as client:
                    self.assertIsNone(client.get("/health").json()["maxModelTurns"])
        finally:
            store.db.close()

    def test_header_is_strict_and_bounded(self):
        contract={'version':1,'toolName':CASES[3][0],'arguments':CASES[3][1]}
        self.assertEqual(decode_completion_header(base64.b64encode(json.dumps(contract).encode()).decode()),contract)
        for invalid in ['bad!', 'A'*5000, base64.b64encode(json.dumps({**contract,'narrate':True}).encode()).decode()]:
            with self.assertRaises(Exception): decode_completion_header(invalid)

if __name__=='__main__': unittest.main()
