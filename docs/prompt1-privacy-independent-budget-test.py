"""Independent installed SDK request budget proof; no external provider calls."""
import os
os.environ['AI_DM_CHATKIT_DATABASE_PATH']=':memory:'
import sys,json,time,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'chatkit-server'))
from agents import Agent,Runner,RunConfig,function_tool
from agents.items import ModelResponse
from agents.usage import Usage
from openai.types.responses import ResponseFunctionToolCall
from app import SqliteStore,PauseTimingHooks,create_app,max_model_turns
from working_context import ContextCapacityError
from test_routine_speed_independent import FixtureModel

class RepeatingModel(FixtureModel):
    async def get_response(self,*args,**kwargs):
        self.calls+=1
        return ModelResponse(output=[ResponseFunctionToolCall(type='function_call',name='ping',arguments='{}',call_id=f'call-{self.calls}',id=f'tool-{self.calls}')],usage=Usage(),response_id=f'response-{self.calls}')

class BudgetGate(unittest.IsolatedAsyncioTestCase):
    async def test_installed_sdk_stops_before_extra_provider_request_and_persists_budget(self):
        @function_tool
        async def ping()->str:
            return 'fixture complete'
        for ceiling in (1,2):
            with tempfile.TemporaryDirectory() as directory:
                path=str(Path(directory)/'store.sqlite')
                store=SqliteStore(path)
                context={'_conversationStore':store,'_acceptanceBudget':{'scope':'binding','maxModelRequests':ceiling,'expiresAt':time.time()+60}}
                model=RepeatingModel();agent=Agent(name='fixture',model=model,tools=[ping])
                with self.assertRaises(ContextCapacityError):
                    await Runner.run(agent,'fixture',context={},hooks=PauseTimingHooks(context),run_config=RunConfig(tracing_disabled=True),max_turns=10)
                self.assertEqual(model.calls,ceiling)
                store.db.close();reopened=SqliteStore(path)
                with self.assertRaises(ContextCapacityError):reopened.consume_acceptance_request('binding',ceiling)
                reopened.db.close()
    def test_zero_invalid_caps_denied_and_ordinary_cap_unchanged(self):
        from datetime import datetime,timedelta,timezone
        for value in (0,-1,3,True,'2'):
            fixture={'worldId':'w','userId':'gm','threadId':'t','traceId':'trace','maxModelRequests':value,'expiresAt':(datetime.now(timezone.utc)+timedelta(minutes=5)).isoformat()}
            store=SqliteStore(':memory:')
            with patch.dict(os.environ,{'AI_DM_ACCEPTANCE_FIXTURES_JSON':json.dumps({'fixture':fixture})}):
                with self.assertRaises(ValueError):create_app(store=store,secret='test')
            store.db.close()
        with patch.dict(os.environ,{},clear=True):self.assertEqual(max_model_turns(),15)
if __name__=='__main__':unittest.main()
