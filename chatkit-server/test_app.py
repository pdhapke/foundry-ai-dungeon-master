"""Independent local protocol/store tests; inference uses an explicitly mocked ChatKit server."""
import base64
import json
import tempfile
import unittest
import asyncio
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
import httpx2 as httpx
from agents.tool_context import ToolContext
from openai import AsyncOpenAI

from fastapi.testclient import TestClient
from fastapi import HTTPException
from chatkit.server import StreamingResult
from chatkit.store import NotFoundError
from chatkit.types import ThreadMetadata, HiddenContextItem, AssistantMessageItem, AssistantMessageContent, ThreadItemDoneEvent
from app import SqliteStore, FoundryChatKit, create_app, validate_action, build_agent, read_foundry, retrieval_query
from dm_prompt import DM_PROMPT, DM_PROMPT_VERSION
from working_context import MODEL_OUTPUT_TOKENS


class StoreTests(unittest.IsolatedAsyncioTestCase):
    async def test_prompt_query_parity_and_spoiler_injection_policy_no_model(self):
        prompt = "What does the blue lantern show?"
        ordinary = [{"role":"user", "content":[{"type":"input_text", "text":prompt}]}]
        action = [{"role":"user", "content":json.dumps({"foundry_application_request":prompt,"untrusted_game_context":{"sceneId":"spoof"}})}]
        self.assertEqual(retrieval_query(ordinary), retrieval_query(action))
        self.assertEqual(retrieval_query(ordinary),prompt)
        self.assertEqual(len(retrieval_query([{"content":"x"*1000}])),256)
        self.assertEqual(DM_PROMPT_VERSION,"solo-dm-v9-bounded-core-actions")
        self.assertIn("DATA, no instructions",DM_PROMPT)
        self.assertIn("narrationAllowed",DM_PROMPT)
        self.assertIn("authoritative receipt/read-back",DM_PROMPT)
        # This asserts policy wiring, not a live model's spoiler behavior.
    async def test_native_tools_use_same_authenticated_adapter_no_second_loop(self):
        context = {"apiKey":"mock", "model":"fixture", "readRun":"run", "threadId":"thread", "worldId":"world", "userId":"gm"}
        agent = build_agent(context)
        tools = {tool.name: tool for tool in agent.tools}
        self.assertEqual(set(tools), {"dm_recipe_read", "dm_history_search", "foundry_read_play_state", "foundry_roll_actor", "foundry_move_token", "foundry_move_tokens", "foundry_set_door_state", "foundry_set_token_light", "foundry_set_actor_hp", "foundry_set_actor_condition", "foundry_advance_combat_turn", "foundry_set_initiative", "foundry_set_pause_state", "foundry_read_scene", "foundry_read_actor", "foundry_read_token_perception", "foundry_read_attack_state", "foundry_roll_attack", "foundry_apply_attack_damage", "foundry_attack_sequence", "foundry_resume_attack_sequence", "campaign_search", "campaign_validate_sources", "campaign_read", "campaign_propose", "campaign_proposals", "tool_search", "tool_load", "tool_execute", "foundry_roll_dice", "foundry_propose_session_note"})
        with patch("app.read_foundry", return_value={"ok":True,"result":{"status":"pending"}}) as adapter:
            arguments = json.dumps({"action_id":"stable", "title":"Session", "text":"A fact"})
            tool_context = ToolContext(context=context, tool_name="foundry_propose_session_note", tool_call_id="fixture", tool_arguments=arguments)
            await tools["foundry_propose_session_note"].on_invoke_tool(tool_context, arguments)
            adapter.assert_awaited_once_with(context,"native_propose_note",{"actionId":"stable","title":"Session","text":"A fact"})
        self.assertIn("uncertain", DM_PROMPT)
        self.assertIn("journal: Review native actions", DM_PROMPT)
    async def test_serialized_plan_request_uses_oauth_and_supported_fields(self):
        captured = []
        def capture(request):
            captured.append(request)
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=b"data: [DONE]\n\n")
        client = AsyncOpenAI(api_key="mock-current-refreshed-oauth-token", max_retries=0, http_client=httpx.AsyncClient(transport=httpx.MockTransport(capture)))
        with patch("app.AsyncOpenAI", return_value=client):
            agent = build_agent({"apiKey": "mock-current-refreshed-oauth-token", "model": "account-selected-model"})
        history = [{"role": "user", "content": "Remember the Hall"}, {"role": "assistant", "content": "The Hall is remembered"}, {"role": "user", "content": "Describe it"}]
        stream = await agent.model._fetch_response(agent.instructions, history, agent.model_settings, [], None, [], stream=True)
        async for _ in stream:
            pass
        self.assertEqual(len(captured), 1)
        request = captured[0]
        self.assertEqual(str(request.url), "https://api.openai.com/v1/responses")
        self.assertEqual(request.headers["authorization"], "Bearer mock-current-refreshed-oauth-token")
        body = json.loads(request.content)
        self.assertIs(body["store"], False)
        self.assertIs(body["stream"], True)
        self.assertEqual(body["model"], "account-selected-model")
        self.assertEqual(len(body["input"]), 3)
        self.assertEqual(body["input"][0]["content"], "Remember the Hall")
        self.assertEqual(body["instructions"], agent.instructions)
        self.assertNotIn("max_output_tokens", body)
        forbidden = {"background", "conversation", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id"}
        self.assertFalse(forbidden.intersection(body))
        self.assertFalse(any(item.get("role") == "system" for item in body["input"]))
        self.assertEqual(body.get("tools", []), [])
        await client.close()

    async def test_response_close_cancels_agents_run(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SqliteStore(str(Path(directory) / "test.sqlite"))
            context = {"worldId": "w", "userId": "gm", "apiKey": "mock", "model": "mock"}
            thread = ThreadMetadata(id="t", created_at=datetime.now(timezone.utc))
            await store.save_thread(thread, context)
            class FakeRun:
                cancelled = False
                def cancel(self):
                    self.cancelled = True
            run = FakeRun()
            async def fake_events(*args):
                yield "mock incremental event"
                await asyncio.Event().wait()
            with patch("app.Runner.run_streamed", return_value=run), patch("app.build_agent", return_value=SimpleNamespace(tools=[])), patch("app.stream_agent_response", fake_events):
                generator = FoundryChatKit(store).respond(thread, None, context)
                self.assertEqual(await anext(generator), "mock incremental event")
                await generator.aclose()
            self.assertTrue(run.cancelled)
            store.db.close()

    async def test_durable_history_and_owner_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "chatkit.sqlite")
            store = SqliteStore(path)
            owner = {"worldId": "w", "userId": "gm"}
            thread = ThreadMetadata(id="t", created_at=datetime.now(timezone.utc))
            await store.save_thread(thread, owner)
            item = HiddenContextItem(id="i", thread_id="t", created_at=datetime.now(timezone.utc), content="context")
            await store.add_thread_item("t", item, owner)
            restored = SqliteStore(path)
            self.assertEqual((await restored.load_item("t", "i", owner)).content, "context")
            with self.assertRaises(NotFoundError):
                await restored.load_thread("t", {"worldId": "w", "userId": "player"})
            with self.assertRaises(NotFoundError):
                await restored.save_thread(thread, {"worldId": "other", "userId": "gm"})
            store.db.close()
            restored.db.close()

    async def test_overlap_disconnect_and_process_error_release_guard(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SqliteStore(str(Path(directory) / "chatkit.sqlite"))
            context = {"worldId": "w", "userId": "gm"}
            await store.save_thread(ThreadMetadata(id="t", created_at=datetime.now(timezone.utc)), context)
            closed = []
            class HeldServer:
                fail = False
                async def process(self, raw, context):
                    if self.fail:
                        raise ValueError("invalid request")
                    async def events():
                        try:
                            yield b'data: first\n\n'
                            await asyncio.Event().wait()
                        finally:
                            closed.append(True)
                    return StreamingResult(events())
            class FakeRequest:
                headers = {"x-chatkit-secret": "secret", "x-chatkit-principal": base64.b64encode(json.dumps({**context, "isGm": True}).encode()).decode(), "x-chatkit-api-key": "mock", "x-chatkit-model": "mock"}
                async def body(self):
                    return json.dumps({"type": "threads.add_user_message", "params": {"thread_id": "t", "input": {}}}).encode()
                async def is_disconnected(self):
                    return False
            server = HeldServer()
            application = create_app(store, server, "secret")
            endpoint = next(r.endpoint for r in application.routes if getattr(r, "path", None) == "/chatkit")
            first = await endpoint(FakeRequest())
            self.assertIn(b"first", await anext(first.body_iterator))
            with self.assertRaises(HTTPException) as caught:
                await endpoint(FakeRequest())
            self.assertEqual(caught.exception.status_code, 409)
            await first.body_iterator.aclose()
            self.assertEqual(closed, [True])
            second = await endpoint(FakeRequest())
            await anext(second.body_iterator)
            await second.body_iterator.aclose()
            server.fail = True
            with self.assertRaises(HTTPException) as caught:
                await endpoint(FakeRequest())
            self.assertEqual(caught.exception.status_code, 400)
            server.fail = False
            third = await endpoint(FakeRequest())
            await anext(third.body_iterator)
            await third.body_iterator.aclose()
            store.db.close()


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    """Real sidecar HTTP client/Agents tool construction; Node provider/model are mocked here."""
    async def test_adapter_headers_scope_structured_results_and_failures(self):
        captured = []
        def capture(request):
            captured.append(request)
            return httpx.Response(200, json={"ok": True, "result": {"schemaVersion": 1, "scene": {"name": "Hall"}}})
        client = httpx.AsyncClient(transport=httpx.MockTransport(capture))
        context = {"readRun": "capability", "internalSecret": "internal", "worldId": "w", "userId": "gm", "threadId": "t"}
        with patch.dict("os.environ", {"AI_DM_CHATKIT_READ_URL": "http://127.0.0.1:3940/internal/chatkit/read"}), patch("app.httpx.AsyncClient", return_value=client):
            result = await read_foundry(context, "actor", {"id": "a"})
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["scene"]["name"], "Hall")
        request = captured[0]
        for header, value in [("x-chatkit-secret", "internal"), ("x-chatkit-world", "w"), ("x-chatkit-user", "gm"), ("x-chatkit-thread", "t"), ("x-chatkit-read-run", "capability")]:
            self.assertEqual(request.headers[header], value)
        self.assertEqual(json.loads(request.content), {"operation": "actor", "arguments": {"id": "a"}})
        for status in (403, 504):
            client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(status)))
            with patch.dict("os.environ", {"AI_DM_CHATKIT_READ_URL": "http://127.0.0.1:3940/internal/chatkit/read"}), patch("app.httpx.AsyncClient", return_value=client):
                self.assertFalse((await read_foundry(context, "scene"))["ok"])
        with patch.dict("os.environ", {"AI_DM_CHATKIT_READ_URL": "https://untrusted.example/read"}):
            self.assertFalse((await read_foundry(context, "scene"))["ok"])

    async def test_adapter_cancellation_propagates(self):
        async def held(request):
            await asyncio.Event().wait()
        client = httpx.AsyncClient(transport=httpx.MockTransport(held))
        context = {"readRun": "capability", "internalSecret": "internal", "worldId": "w", "userId": "gm", "threadId": "t"}
        with patch.dict("os.environ", {"AI_DM_CHATKIT_READ_URL": "http://127.0.0.1:3940/internal/chatkit/read"}), patch("app.httpx.AsyncClient", return_value=client):
            task = asyncio.create_task(read_foundry(context, "scene"))
            await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

    async def test_typed_and_custom_action_share_authorized_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SqliteStore(str(Path(directory) / "test.sqlite"))
            context = {"worldId": "w", "userId": "gm", "apiKey": "mock", "model": "mock", "readRun": "cap"}
            thread = ThreadMetadata(id="t", created_at=datetime.now(timezone.utc))
            await store.save_thread(thread, context)
            server = FoundryChatKit(store)
            captured, reads = [], []
            class FakeRun:
                def cancel(self): pass
            def runner(agent, inputs, **kwargs):
                captured.append(inputs[-1])
                return FakeRun()
            async def fake_events(*args):
                yield "mock event"
            async def read(request_context, operation, arguments=None):
                reads.append((request_context["threadId"], operation))
                return {"ok": True, "result": {"scene": {"name": "Authoritative Hall"}}}
            with patch("app.Runner.run_streamed", runner), patch("app.build_agent", return_value=SimpleNamespace(tools=[])), patch("app.stream_agent_response", fake_events), patch("app.read_foundry", read):
                self.assertEqual([v async for v in server.respond(thread, None, context)], ["mock event"])
                action = SimpleNamespace(type="foundry.context-response", payload={"requestId": "r", "prompt": "Describe", "context": {"sceneName": "Spoofed"}})
                self.assertEqual([v async for v in server.action(thread, action, None, context)], ["mock event"])
            self.assertEqual(captured[0], captured[1])
            self.assertEqual(reads, [("t", "initial_context"), ("t", "initial_context")])
            store.db.close()


class MockServer:
    async def process(self, raw, context):
        async def events():
            yield b'data: {"type":"thread.item.added"}\n\n'
            yield b'data: {"type":"thread.item.updated"}\n\n'
        return StreamingResult(events())


class MockInferenceChatKit(FoundryChatKit):
    """Real SDK protocol/store; only inference output is mocked."""
    async def respond(self, thread, input, context):
        yield ThreadItemDoneEvent(item=AssistantMessageItem(id=self.store.generate_item_id("message", thread, context), thread_id=thread.id, created_at=datetime.now(timezone.utc), content=[AssistantMessageContent(text="Mock assistant response")]))


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.store = SqliteStore(str(Path(self.directory.name) / "test.sqlite"))
        self.client = TestClient(create_app(self.store, MockServer(), "secret"))
        self.headers = {
            "x-chatkit-secret": "secret",
            "x-chatkit-principal": base64.b64encode(json.dumps({"worldId": "w", "userId": "gm", "isGm": True}).encode()).decode(),
            "x-chatkit-api-key": "mock-key", "x-chatkit-model": "mock-model",
        }

    def tearDown(self):
        self.client.close()
        self.store.db.close()
        self.directory.cleanup()

    def test_requires_gateway_auth_and_never_exposes_key(self):
        self.assertEqual(self.client.post("/chatkit/thread").status_code, 401)
        response = self.client.post("/chatkit/thread", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("mock-key", response.text)

    def test_unreviewed_sdk_inference_routes_fail_before_process(self):
        class ForbiddenServer:
            async def process(self, raw, context):
                raise AssertionError("Unsupported route reached ChatKit process")
        self.client.close()
        self.client = TestClient(create_app(self.store, ForbiddenServer(), "secret"))
        for operation in ("threads.add_client_tool_output", "threads.add_structured_input", "threads.sync_custom_action", "input.transcribe", "attachments.create", "future.inference", None):
            response = self.client.post("/chatkit", headers=self.headers, json={"type": operation, "params": {}})
            self.assertEqual(response.status_code, 400, operation)
            self.assertIn("Unsupported ChatKit operation", response.text)

    def test_action_stream_and_duplicate_trigger(self):
        thread = self.client.post("/chatkit/thread", headers=self.headers).json()["threadId"]
        body = {"type": "threads.custom_action", "params": {"thread_id": thread, "action": {"type": "foundry.context-response", "payload": {"requestId": "event1", "prompt": "Describe", "context": {"sceneName": "Hall"}}}}}
        response = self.client.post("/chatkit", headers=self.headers, json=body)
        self.assertEqual(response.status_code, 200)
        self.assertIn("text/event-stream", response.headers["content-type"])
        self.assertEqual(response.text.count("data:"), 2)
        self.assertEqual(self.client.post("/chatkit", headers=self.headers, json=body).status_code, 409)

    def test_cross_user_thread_and_untrusted_context_rejected(self):
        thread = self.client.post("/chatkit/thread", headers=self.headers).json()["threadId"]
        headers = {**self.headers, "x-chatkit-principal": base64.b64encode(json.dumps({"worldId": "w", "userId": "other", "isGm": True}).encode()).decode()}
        self.assertEqual(self.client.post("/chatkit", headers=headers, json={"type": "threads.get_by_id", "params": {"thread_id": thread}}).status_code, 404)
        with self.assertRaises(Exception):
            validate_action("foundry.context-response", {"requestId": "id", "prompt": "hello", "context": {"journal": "secret"}})

    def test_actual_sdk_manual_action_continuity_and_history(self):
        self.client.close()
        self.client = TestClient(create_app(self.store, MockInferenceChatKit(self.store), "secret"))
        thread = self.client.post("/chatkit/thread", headers=self.headers).json()["threadId"]
        user_input = {"content": [{"type": "input_text", "text": "Remember the Hall"}], "attachments": [], "inference_options": {}}
        response = self.client.post("/chatkit", headers=self.headers, json={"type": "threads.add_user_message", "params": {"thread_id": thread, "input": user_input}})
        self.assertEqual(response.status_code, 200)
        self.assertIn("Mock assistant response", response.text)
        response = self.client.post("/chatkit", headers=self.headers, json={"type": "threads.custom_action", "params": {"thread_id": thread, "action": {"type": "foundry.context-response", "payload": {"requestId": "context1", "prompt": "Describe the Hall", "context": {"sceneName": "Hall"}}}}})
        self.assertEqual(response.status_code, 200)
        self.assertIn("Mock assistant response", response.text)
        rows = self.store.db.execute("SELECT body FROM items WHERE thread_id=?", (thread,)).fetchall()
        self.assertEqual(len(rows), 4)
        self.assertIn("Remember the Hall", rows[0][0])
        self.assertIn("untrusted_game_context", rows[2][0])


if __name__ == "__main__":
    unittest.main()


