import os,unittest
from unittest.mock import patch
from app import max_model_turns
class IndependentTurnLimit(unittest.TestCase):
 def test_default(self):
  with patch.dict(os.environ,{},clear=True):self.assertIsNone(max_model_turns())
 def test_bounds_and_caps(self):
  for text,want in [('1',1),('2',2),('3',3),('8',8),('15',15),('16',15),('999',15),('0',1),('-4',1),('',15),('invalid',15),('1.5',15)]:
   with self.subTest(text=text),patch.dict(os.environ,{'AI_DM_CHATKIT_MAX_TURNS':text}):self.assertIsNone(max_model_turns())

from agents import Agent,Runner,RunConfig,function_tool
from agents.exceptions import MaxTurnsExceeded
from agents.items import ModelResponse
from agents.usage import Usage
from openai.types.responses import ResponseFunctionToolCall,ResponseOutputMessage,ResponseOutputText
from test_routine_speed_independent import FixtureModel
class InstalledSdkHardLimit(unittest.IsolatedAsyncioTestCase):
 async def test_normal_usage_supports_seventeen_requests_and_long_output(self):
  class Endless(FixtureModel):
   async def get_response(self,*args,**kwargs):
    self.calls+=1
    if self.calls==17:
     return ModelResponse(output=[ResponseOutputMessage(type='message',id='final',role='assistant',status='completed',content=[ResponseOutputText(type='output_text',text='x'*5000,annotations=[])])],usage=Usage(),response_id='fixture-final')
    return ModelResponse(output=[ResponseFunctionToolCall(type='function_call',name='noop',arguments='{}',call_id=f'call{self.calls}',id=f'item{self.calls}')],usage=Usage(),response_id=f'fixture{self.calls}')
  @function_tool
  async def noop()->str:return 'confirmed'
  model=Endless();agent=Agent(name='offline',model=model,tools=[noop])
  with patch.dict(os.environ,{},clear=True):
   result=await Runner.run(agent,'fixture',max_turns=max_model_turns(),run_config=RunConfig(tracing_disabled=True))
  self.assertEqual(model.calls,17)
  self.assertEqual(len(result.final_output),5000)
