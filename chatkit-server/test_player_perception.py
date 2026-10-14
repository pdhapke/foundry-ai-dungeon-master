"""Bounded selected-player adapter evidence; fake models only, no network/inference."""
import json
import unittest
from unittest.mock import patch
from agents.tool_context import ToolContext
from app import build_agent, read_foundry

class PlayerPerceptionTests(unittest.IsolatedAsyncioTestCase):
    async def test_typed_player_read_preserves_explicit_unavailable_and_never_queries_gm_fallback(self):
        context={'apiKey':'fixture','model':'fixture','readRun':'fixture','worldId':'world','userId':'gm'}
        tool={t.name:t for t in build_agent(context).tools}['foundry_read_token_perception']
        args=json.dumps({'scene_id':'scene','token_id':'token','effective_user_id':'player','client_id':'client'})
        wrapper=ToolContext(context=context,tool_name=tool.name,tool_call_id='call',tool_arguments=args)
        evidence={'ok':True,'result':{'sceneId':'scene','tokenId':'token','effectiveUserId':'player','status':'unavailable','visible':{'tokens':[],'notes':[],'tiles':[]},'issues':[{'code':'PLAYER_CLIENT_UNAVAILABLE','retryable':True}]}}
        with patch('app.read_foundry',return_value=evidence) as adapter:
            result=json.loads(await tool.on_invoke_tool(wrapper,args))
            self.assertEqual(result,evidence)
            adapter.assert_awaited_once_with(context,'token_perception',{'sceneId':'scene','tokenId':'token','effectiveUserId':'player','clientId':'client'})
        self.assertNotIn('gm fallback',json.dumps(result).lower())

    async def test_old_narration_run_cannot_read_player_report_or_open_adapter_http(self):
        with patch('app.httpx.AsyncClient') as http:
            result = await read_foundry({'_narrationOnly':True},'token_perception',{'sceneId':'scene','tokenId':'token','effectiveUserId':'player','clientId':'client'})
            self.assertFalse(result['ok'])
            self.assertEqual(result['error']['code'],'NARRATION_ONLY')
            http.assert_not_called()

if __name__=='__main__':unittest.main()

