"""Acceptance request budget fences; no provider or Foundry calls."""
import base64
import json
import os
import time
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch
from fastapi.testclient import TestClient
from chatkit.types import ThreadMetadata
from app import SqliteStore, PauseTimingHooks, create_app, max_model_turns, build_agent, ACCEPTANCE_OUTPUT_TOKENS
from agents import ModelSettings
from working_context import ContextCapacityError, MODEL_OUTPUT_TOKENS


class AcceptanceBudgetTests(unittest.IsolatedAsyncioTestCase):
    async def test_durable_caps_and_ordinary_behavior(self):
        store = SqliteStore(":memory:")
        agent = SimpleNamespace(model=SimpleNamespace(model="fixture"), model_settings=SimpleNamespace(reasoning=None, max_tokens=ACCEPTANCE_OUTPUT_TOKENS), tools=[])
        for ceiling in (1, 2, 5, 6):
            context = {"_conversationStore": store, "_acceptanceBudget": {"scope": str(ceiling), "maxModelRequests": ceiling, "expiresAt": time.time()+60}}
            hooks = PauseTimingHooks(context)
            for _ in range(ceiling): await hooks.on_llm_start(None, agent, "", [])
            with self.assertRaises(ContextCapacityError): await hooks.on_llm_start(None, agent, "", [])
            # Recreating hooks cannot restore a consumed allowance.
            with self.assertRaises(ContextCapacityError): await PauseTimingHooks(context).on_llm_start(None, agent, "", [])
        ordinary = PauseTimingHooks({})
        for _ in range(3): await ordinary.on_llm_start(None, agent, "", [])
        with patch.dict(os.environ, {"AI_DM_CHATKIT_MAX_TURNS": "15"}): self.assertIsNone(max_model_turns())
        store.db.close()

    async def test_expiry_precedes_consumption(self):
        store = SqliteStore(":memory:")
        hooks = PauseTimingHooks({"_conversationStore": store, "_acceptanceBudget": {"scope": "expired", "maxModelRequests": 2, "expiresAt": time.time()-1}})
        with self.assertRaises(ContextCapacityError): await hooks.on_llm_start(None, SimpleNamespace(), "", [])
        self.assertEqual(store.db.execute("SELECT COUNT(*) FROM acceptance_budgets").fetchone()[0], 0)
        store.db.close()

    async def test_fixture_cap_and_ordinary_settings(self):
        context = {"apiKey": "offline", "model": "gpt-5.4"}
        ordinary = build_agent(context)
        self.assertIsNone(ordinary.model_settings.max_tokens)
        fixture = build_agent({**context, "_acceptanceBudget": {"maxModelRequests": 1}})
        self.assertEqual(fixture.model_settings.max_tokens, 1024)
        self.assertEqual(fixture.model_settings.reasoning.effort, "none")
        self.assertEqual(fixture.model._client.max_retries, 0)

    async def test_missing_or_enlarged_cap_refused_before_consumption(self):
        store = SqliteStore(":memory:")
        context = {"_conversationStore": store, "_acceptanceBudget": {"scope": "cap", "maxModelRequests": 1, "expiresAt": time.time()+60}}
        for cap in (None, 1025, 8192, 0):
            agent = SimpleNamespace(model_settings=SimpleNamespace(max_tokens=cap))
            with self.assertRaises(ContextCapacityError):
                await PauseTimingHooks(context).on_llm_start(None, agent, "", [])
        self.assertEqual(store.db.execute("SELECT COUNT(*) FROM acceptance_budgets").fetchone()[0], 0)
        model = build_agent({"apiKey": "offline", "model": "gpt-5.4", "_acceptanceBudget": {"maxModelRequests": 1}}).model
        with self.assertRaises(ContextCapacityError):
            async for _ in model.stream_response(model_settings=ModelSettings(max_tokens=8192)):
                self.fail("Dispatch must refuse before contacting provider")
        store.db.close()

    async def test_authenticated_fixture_binding_default_denial_and_no_body_override(self):
        store = SqliteStore(":memory:")
        principal = {"worldId": "world", "userId": "gm", "isGm": True}
        await store.save_thread(ThreadMetadata(id="thread", created_at=datetime.now(timezone.utc)), principal)
        class Stub:
            async def process(self, raw, context):
                self.context = context
                return SimpleNamespace(json="{}")
        fixture = {"worldId": "world", "userId": "gm", "threadId": "thread", "traceId": "12345678-1234-1234-1234-123456789abc", "maxModelRequests": 1, "expiresAt": (datetime.now(timezone.utc)+timedelta(minutes=5)).isoformat()}
        headers = {"x-chatkit-secret": "secret", "x-chatkit-principal": base64.b64encode(json.dumps(principal).encode()).decode(), "x-chatkit-trace": fixture["traceId"], "x-chatkit-acceptance-fixture": "recall"}
        body = {"type": "threads.get_by_id", "params": {"thread_id": "thread"}, "maxModelRequests": 99}
        with patch.dict(os.environ, {"AI_DM_ACCEPTANCE_FIXTURES_JSON": "{}"}):
            with TestClient(create_app(store, Stub(), "secret")) as client: self.assertEqual(client.post("/chatkit", json=body, headers=headers).status_code, 403)
        with patch.dict(os.environ, {"AI_DM_ACCEPTANCE_FIXTURES_JSON": json.dumps({"recall": fixture})}):
            stub = Stub()
            with TestClient(create_app(store, stub, "secret")) as client:
                self.assertEqual(client.post("/chatkit", json=body, headers=headers).status_code, 200)
                self.assertEqual(stub.context["_acceptanceBudget"]["maxModelRequests"], 1)
                self.assertEqual(client.post("/chatkit", json=body, headers={**headers, "x-chatkit-trace": "wrong"}).status_code, 403)
        store.db.close()
