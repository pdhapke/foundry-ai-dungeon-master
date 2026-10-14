"""Python discovery wire contracts against controlled adapter; no model billing."""
import json
import unittest
from unittest.mock import patch
from agents.tool_context import ToolContext
from app import build_agent


class DiscoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_search_load_execution_map_only_grant_authority_and_preserve_uncertainty(self):
        context = {"apiKey": "mock", "model": "fixture", "readRun": "run"}
        tools = {tool.name: tool for tool in build_agent(context).tools}
        expected = [
            ("tool_search", {"query": "roll dice", "limit": 4}, "tool_search", {"query": "roll dice", "limit": 4}),
            ("tool_load", {"search_id": "search:s", "tool_id": "ai_dm_roll_dice"}, "tool_load", {"searchId": "search:s", "toolId": "ai_dm_roll_dice"}),
            ("tool_execute", {"grant_id": "grant:g", "effect": "present", "arguments": {"actionId": "a", "formula": "1d6"}}, "tool_execute", {"grantId": "grant:g", "effect": "present", "arguments": {"actionId": "a", "formula": "1d6"}}),
            ("tool_execute", {"grant_id": "grant:s", "effect": "session", "arguments": {"actionId": "pause-a", "paused": False, "expectedPaused": True}}, "tool_execute", {"grantId": "grant:s", "effect": "session", "arguments": {"actionId": "pause-a", "paused": False, "expectedPaused": True}}),
        ]
        for name, arguments, operation, wire in expected:
            encoded = json.dumps(arguments)
            call = ToolContext(context=context, tool_name=name, tool_call_id="test", tool_arguments=encoded)
            with patch("app.read_foundry", return_value={"ok": True, "result": {"ok": True, "value": {"result": {"status": "uncertain"}}}}) as adapter:
                result = json.loads(await tools[name].on_invoke_tool(call, encoded))
                adapter.assert_awaited_once_with(context, operation, wire)
                self.assertEqual(result["result"]["value"]["result"]["status"], "uncertain")
        schema = tools["tool_execute"].params_json_schema
        self.assertNotIn("commitAuthorization", schema["properties"])
        self.assertNotIn("tool_id", schema["properties"])
        self.assertNotIn("commit", json.dumps(schema["properties"]["effect"]))


if __name__ == "__main__":
    unittest.main()
