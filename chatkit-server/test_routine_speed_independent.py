"""Independent offline evidence and lifecycle validation. No network/model calls."""
import json
import unittest
from pathlib import Path
from collections import defaultdict
from datetime import datetime, timezone
from unittest.mock import patch
from agents import Runner, RunConfig
from agents.models.interface import Model
from agents.items import ModelResponse
from agents.usage import Usage
from agents.tool_context import ToolContext
import asyncio
from types import SimpleNamespace
from openai.types.responses import Response, ResponseCompletedEvent, ResponseFunctionToolCall, ResponseOutputMessage, ResponseOutputText
from chatkit.agents import AgentContext, stream_agent_response
from chatkit.types import ThreadMetadata
from app import SqliteStore, build_agent, PauseTimingHooks, ReceiptHistoryConverter, receipt_summary


class FixtureModel(Model):
    model = "fixture"
    def __init__(self):
        self.calls = 0
        self.inputs = []

    async def get_response(self, *args, **kwargs):
        self.calls += 1
        self.inputs.append(args[1] if len(args) > 1 else kwargs["input"])
        output = [ResponseFunctionToolCall(type="function_call", name="foundry_set_pause_state", arguments='{"paused":false}', call_id="fixture-call", id="fixture-tool")]
        if self.calls > 1:
            output = [ResponseOutputMessage(type="message", id="fixture-message", role="assistant", status="completed", content=[ResponseOutputText(type="output_text", text="Remaining narration.", annotations=[])])]
        return ModelResponse(output=output, usage=Usage(), response_id="fixture-response")

    async def stream_response(self, *args, **kwargs):
        response = await self.get_response(*args, **kwargs)
        raw = Response.model_construct(id=response.response_id, object="response", created_at=0, model="fixture", output=response.output, usage=None)
        yield ResponseCompletedEvent(type="response.completed", sequence_number=1, response=raw)


class ReceiptLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def run_fixture(self, sole, outcome="confirmed"):
        store = SqliteStore(":memory:")
        context = {"worldId": "world", "userId": "gm", "threadId": "thread", "apiKey": "fixture", "model": "fixture", "readRun": "fixture", "pauseControlOnly": sole}
        thread = ThreadMetadata(id="thread", created_at=datetime.now(timezone.utc))
        await store.save_thread(thread, context)
        agent_context = AgentContext(thread=thread, store=store, request_context=context)
        model = FixtureModel()
        agent = build_agent(context)
        agent.model = model
        with patch("app.read_foundry", return_value={"ok": True, "result": {"outcome": outcome, "paused": False, "worldId": "world", "correlationId": "fixture-correlation"}}):
            run = Runner.run_streamed(agent, "Unpause" if sole else "Unpause and describe the scene", context=agent_context, hooks=PauseTimingHooks(context), run_config=RunConfig(tracing_disabled=True))
            events = [event async for event in stream_agent_response(agent_context, run)]
        history = await store.load_thread_items(thread.id, None, 20, "asc", context)
        inputs = await ReceiptHistoryConverter().to_agent_input(history.data)
        return store, model, events, inputs

    async def test_real_sdk_stream_sole_pause_stops_once_and_reconnect_has_complete_pair(self):
        store, model, events, inputs = await self.run_fixture(True)
        try:
            self.assertEqual(model.calls, 1)
            calls = [item for item in inputs if item.get("type") == "function_call"]
            outputs = [item for item in inputs if item.get("type") == "function_call_output"]
            self.assertEqual(len(calls), 1)
            self.assertEqual(len(outputs), 1)
            self.assertEqual(calls[0]["call_id"], outputs[0]["call_id"])
            self.assertEqual(sum("Game unpaused." in str(item) for item in inputs), 1)
            # A fresh SDK turn accepts persisted protocol history without another tool execution.
            agent = build_agent({"apiKey": "fixture", "model": "fixture"})
            model.calls = 1
            agent.model = model
            await Runner.run(agent, inputs + [{"role": "user", "content": "What happened?"}], run_config=RunConfig(tracing_disabled=True))
            self.assertTrue(any(item.get("type") == "function_call_output" for item in model.inputs[-1]))
        finally:
            store.db.close()

    async def test_real_sdk_compound_and_uncertainty_continue(self):
        for sole, outcome in [(False, "confirmed"), (True, "uncertain"), (True, "failed")]:
            store, model, events, inputs = await self.run_fixture(sole, outcome)
            try:
                self.assertEqual(model.calls, 2)
                if outcome != "confirmed":
                    self.assertNotIn("Game unpaused.", str(inputs))
                    self.assertIn("completion is not confirmed", str(inputs))
            finally:
                store.db.close()

    async def test_canceled_delivery_preserves_pair_and_reconnect_does_not_duplicate_summary(self):
        store = SqliteStore(":memory:")
        request = {"worldId": "world", "userId": "gm", "threadId": "thread"}
        thread = ThreadMetadata(id="thread", created_at=datetime.now(timezone.utc))
        await store.save_thread(thread, request)
        context = AgentContext(thread=thread, store=store, request_context=request)
        tool_context = ToolContext(context=context, tool_name="foundry_set_pause_state", tool_call_id="one", tool_arguments='{"paused":false}')
        tool = SimpleNamespace(name="foundry_set_pause_state")
        receipt = json.dumps({"outcome": "confirmed", "paused": False, "correlationId": "same-receipt"})
        try:
            with patch.object(AgentContext, "stream", side_effect=asyncio.CancelledError):
                with self.assertRaises(asyncio.CancelledError):
                    await PauseTimingHooks(request).on_tool_end(tool_context, None, tool, receipt)
            # A new hook represents reconnect/retry; durable receipt ID prevents a second summary.
            await PauseTimingHooks(request).on_tool_end(tool_context, None, tool, receipt)
            with self.assertRaises(RuntimeError):
                await PauseTimingHooks(request).on_tool_end(tool_context, None, tool, json.dumps({"outcome": "confirmed", "paused": True, "correlationId": "same-receipt"}))
            history = await store.load_thread_items(thread.id, None, 20, "asc", request)
            self.assertEqual(sum(item.type == "assistant_message" for item in history.data), 1)
            self.assertEqual(sum(item.type == "hidden_context_item" for item in history.data), 1)
            inputs = await ReceiptHistoryConverter().to_agent_input(history.data)
            self.assertEqual(sum(item.get("type") == "function_call" for item in inputs), sum(item.get("type") == "function_call_output" for item in inputs))
        finally:
            store.db.close()

    async def test_malformed_confirmed_data_never_becomes_success(self):
        for receipt in [{"outcome": "confirmed", "state": None}, {"outcome": "confirmed", "action": []}, {"outcome": "confirmed", "action": {"kind": "actor.hp"}, "state": {"value": True}}, {"outcome": "confirmed", "action": {"kind": "door.state"}, "state": {"ds": True}}]:
            self.assertIsNone(receipt_summary("foundry_set_actor_hp", receipt))


class BaselineEvidenceTests(unittest.TestCase):
    def test_six_correlated_receipts_have_two_requests_and_confirmation_boundaries(self):
        evidence = Path(__file__).resolve().parents[1] / "docs" / "core-rollout-evidence"
        events = json.loads((evidence / "live-traces.json").read_text())["events"]
        receipts = json.loads((evidence / "live-receipts.json").read_text())
        groups = defaultdict(list)
        for event in events:
            groups[event.get("traceId")].append(event)
        action_groups = [group for group in groups.values() if any(e["stage"] == "confirmed-action-result" for e in group)]
        self.assertEqual(len(action_groups), 6)
        self.assertEqual(len(receipts), 6)
        by_correlation = {r["correlationId"]: r for r in receipts}
        for group in action_groups:
            stages = defaultdict(list)
            for event in group:
                stages[event["stage"]].append(event)
            self.assertEqual([e["request"] for e in stages["model-request"]], [1, 2])
            self.assertEqual(len(stages["tool-start"]), 1)
            self.assertTrue(all(e["reasoning"]["effort"] == "none" and e["model"] == "gpt-5.6-sol" for e in stages["model-request"]))
            confirmed = stages["confirmed-action-result"][0]
            self.assertEqual(confirmed["outcome"], "confirmed")
            receipt = by_correlation[confirmed["correlationId"]]
            self.assertEqual(receipt["result"]["outcome"], "confirmed")
            self.assertEqual(receipt["result"]["worldId"], receipt["scope"]["worldId"])
            arrival = stages["request-arrival"][0]["atMs"]
            self.assertGreater(confirmed["atMs"], arrival)
            self.assertGreater(stages["final-response-finished"][0]["atMs"], confirmed["atMs"])
            # First forwarded SSE includes workflow/meta; it predates authoritative success.
            self.assertLess(stages["first-visible-stream-chunk"][0]["atMs"], confirmed["atMs"])
            self.assertLess(stages["queue-entered"][0]["queueWaitMs"], 10)


if __name__ == "__main__":
    unittest.main()
