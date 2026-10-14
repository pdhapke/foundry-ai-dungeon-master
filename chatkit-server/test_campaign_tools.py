"""Controlled adapter contracts; no model calls, approval fabrication or live Foundry writes."""
import json
import os
import unittest
from unittest.mock import patch

from agents.tool_context import ToolContext
from app import build_agent, read_foundry


class CampaignToolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.context = {"apiKey": "mock", "model": "fixture", "readRun": "run", "threadId": "thread", "worldId": "world", "userId": "gm", "internalSecret": "internal"}
        self.tools = {tool.name: tool for tool in build_agent(self.context).tools}

    async def invoke(self, name, arguments):
        encoded = json.dumps(arguments)
        context = ToolContext(context=self.context, tool_name=name, tool_call_id="fixture", tool_arguments=encoded)
        return json.loads(await self.tools[name].on_invoke_tool(context, encoded))

    async def test_typed_read_and_proposal_shapes_preserve_pending_and_privacy_denial(self):
        with patch("app.read_foundry", return_value={"ok": True, "result": {"revision": "a" * 64}}) as adapter:
            await self.invoke("campaign_read", {"path": "overview.md", "start_line": 1, "end_line": 40})
            adapter.assert_awaited_once_with(self.context, "campaign_read", {"path": "overview.md", "startLine": 1, "endLine": 40})
        files = [{"path": "overview.md", "expected_revision": None, "proposed_text": "Draft text"}]
        for status in ("pending", "storage_unavailable", "stale", "uncertain"):
            with patch("app.read_foundry", return_value={"ok": True, "result": {"status": status}}) as adapter:
                result = await self.invoke("campaign_propose", {"proposal_id": "stable", "title": "Setup", "files": files})
                adapter.assert_awaited_once_with(self.context, "campaign_propose", {"proposalId": "stable", "title": "Setup", "files": [{"path": "overview.md", "expectedRevision": None, "proposedText": "Draft text"}]})
                self.assertEqual(result["result"]["status"], status)

    async def test_scripted_draft_review_later_receipt_only_reads_authorized_state(self):
        self.assertFalse(any("approve" in name or "commit" in name for name in self.tools))
        with patch("app.read_foundry", side_effect=[
            {"ok": True, "result": {"status": "pending", "batchDigest": "b" * 64, "requiresConfirmation": True}},
            {"ok": True, "result": {"status": "completed", "receipt": {"verified": True, "files": [{"path": "overview.md", "revision": "a" * 64}]}}},
            {"ok": True, "result": {"revision": "a" * 64, "text": "Approved lighthouse"}},
        ]) as adapter:
            draft = await self.invoke("campaign_propose", {"proposal_id": "p", "title": "Prep", "files": [{"path": "overview.md", "expected_revision": None, "proposed_text": "Lighthouse"}]})
            self.assertEqual(draft["result"]["status"], "pending")
            # The fixture simulates an external authenticated human decision; no model tool approves.
            receipt = await self.invoke("campaign_proposals", {"proposal_id": "p"})
            self.assertTrue(receipt["result"]["receipt"]["verified"])
            later = await self.invoke("campaign_read", {"path": "overview.md", "start_line": None, "end_line": None})
            self.assertEqual(later["result"]["revision"], "a" * 64)
            self.assertEqual([call.args[1] for call in adapter.await_args_list], ["campaign_propose", "campaign_proposals", "campaign_read"])

    async def test_proposal_utf8_budget_and_zero_file_denied_before_adapter(self):
        with patch("app.read_foundry") as adapter:
            excessive = await self.invoke("campaign_propose", {"proposal_id": "p", "title": "Prep", "files": [{"path": "overview.md", "expected_revision": None, "proposed_text": "雪" * 6000}]})
            self.assertEqual(excessive["error"]["code"], "INPUT_BUDGET_EXCEEDED")
            empty = await self.invoke("campaign_propose", {"proposal_id": "p", "title": "Prep", "files": []})
            self.assertEqual(empty["error"]["code"], "PROPOSAL_INVALID")
            adapter.assert_not_awaited()

    async def test_adapter_oversized_request_fails_before_network(self):
        with patch.dict(os.environ, {"AI_DM_CHATKIT_READ_URL": "http://127.0.0.1/internal/chatkit/read"}), patch("app.httpx.AsyncClient") as client:
            result = await read_foundry(self.context, "campaign_propose", {"text": "雪" * 12000})
            self.assertEqual(result["error"]["code"], "INPUT_BUDGET_EXCEEDED")
            client.assert_not_called()


if __name__ == "__main__":
    unittest.main()
