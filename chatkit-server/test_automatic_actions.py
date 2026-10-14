"""Strict Python acceptance of frozen automatic observation hints, no model/Foundry calls."""
import hashlib
import base64
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from fastapi import HTTPException
from chatkit.types import ThreadMetadata
from app import validate_action, SqliteStore, FoundryChatKit, create_app


def payload(hint):
    fields = [hint.get(key) for key in ("kind", "worldId", "sceneId", "documentId", "tokenId", "regionId", "key", "revision", "transition")]
    digest = hashlib.sha256(json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    return {"requestId": f"{hint.get('kind')}-{digest}", "prompt": "Describe the event", "context": {"sceneId": "scene"}, "automatic": hint}


class AutomaticActionTests(unittest.IsolatedAsyncioTestCase):
    def test_accepts_all_frozen_event_kinds_and_preserves_hint_as_data(self):
        for kind in ("area", "door", "turn"):
            hint = {"kind": kind, "worldId": "world", "sceneId": "scene", "documentId": "document", "revision": 0, "transition": "snow 雪 and emoji 🐉"}
            if kind == "area":
                hint.update(tokenId="token", regionId="region", key="ROOM-ARRIVAL")
            original = payload(hint)
            result = validate_action("foundry.context-response", original, "world")
            self.assertEqual(result, original)
            self.assertIsNot(result["automatic"], hint)
        golden = {"kind": "door", "worldId": "world", "sceneId": "scene", "documentId": "door", "revision": 1, "transition": "0->1"}
        # Independently calculated using native Node JSON.stringify + SHA256.
        self.assertEqual(payload(golden)["requestId"], "door-b1fc9297e2213a68a5898b1341be0f77257c0976bb972e0edc28e44b07a68704")

    def test_rejects_malformed_hints_world_changes_prefix_claims_and_unbounded_fields(self):
        baseline = {"kind": "door", "worldId": "world", "sceneId": "scene", "documentId": "door", "revision": 1, "transition": "0->1"}
        invalid = [None, [], {}, {**baseline, "kind": []}, {**baseline, "kind": "mutation"}, {**baseline, "worldId": "other"}, {**baseline, "documentId": "../door"}, {**baseline, "revision": True}, {**baseline, "revision": -1}, {**baseline, "revision": 9007199254740992}, {**baseline, "transition": ""}, {**baseline, "transition": "🐉" * 129}, {**baseline, "transition": "\ud800"}, {**baseline, "origin": "foundry-local-api.transaction"}, {**baseline, "correlationId": "invented"}, {**baseline, "kind": "area"}]
        for hint in invalid:
            candidate = {"requestId": "door-invented", "prompt": "Test", "context": {}, "automatic": hint}
            with self.subTest(hint=repr(hint)), self.assertRaises(HTTPException):
                validate_action("foundry.context-response", candidate, "world")
        valid = payload(baseline)
        valid["requestId"] = "door-" + "0" * 64
        with self.assertRaises(HTTPException):
            validate_action("foundry.context-response", valid, "world")
        with self.assertRaises(HTTPException):
            validate_action("foundry.context-response", payload(baseline), "other")

    async def test_action_stores_hint_with_data_only_correlation_before_shared_respond(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SqliteStore(str(Path(directory) / "test.sqlite"))
            class Server(FoundryChatKit):
                async def respond(self, thread, input, context):
                    yield "shared-respond"
            server = Server(store)
            context = {"worldId": "world", "userId": "gm"}
            thread = ThreadMetadata(id="thread", created_at=datetime.now(timezone.utc))
            await store.save_thread(thread, context)
            hint = {"kind": "turn", "worldId": "world", "sceneId": "scene", "documentId": "combat", "revision": 2, "transition": "1:0->1:1"}
            action = SimpleNamespace(type="foundry.context-response", payload=payload(hint))
            events = [event async for event in server.action(thread, action, None, context)]
            self.assertEqual(events, ["shared-respond"])
            saved = await store.load_thread_items(thread.id, None, 10, "desc", context)
            observation = json.loads(saved.data[0].content)
            self.assertEqual(observation["foundry_application_request"], "Describe the event")
            automatic = observation["untrusted_automatic_observation"]
            self.assertEqual(automatic["correlationId"], action.payload["requestId"])
            self.assertEqual(automatic["classification"], "authenticated-gm-observation-hint")
            self.assertIn("not verified game state", automatic["authority"])
            self.assertNotIn("foundry-local-api.transaction", json.dumps(observation))
            store.db.close()

    async def test_authenticated_endpoint_rejects_cross_world_hint_before_process(self):
        store = SqliteStore(":memory:")
        calls = []
        class Server:
            async def process(self, raw, context):
                calls.append(json.loads(raw))
                return SimpleNamespace(json="{}")
        class Request:
            headers = {"x-chatkit-secret": "secret", "x-chatkit-principal": base64.b64encode(json.dumps({"worldId": "world", "userId": "gm", "isGm": True}).encode()).decode(), "x-chatkit-api-key": "mock", "x-chatkit-model": "mock"}
            async def body(self):
                return json.dumps({"type": "threads.custom_action", "params": {"action": {"type": "foundry.context-response", "payload": self.payload}}}).encode()
        try:
            application = create_app(store, Server(), "secret")
            endpoint = next(route.endpoint for route in application.routes if getattr(route, "path", None) == "/chatkit")
            request = Request()
            hint = {"kind": "door", "worldId": "other", "sceneId": "scene", "documentId": "door", "revision": 1, "transition": "0->1"}
            request.payload = payload(hint)
            with self.assertRaises(HTTPException) as raised:
                await endpoint(request)
            self.assertEqual(raised.exception.status_code, 400)
            self.assertEqual(calls, [])
            request.payload = payload({**hint, "worldId": "world"})
            response = await endpoint(request)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(len(calls), 1)
        finally:
            store.db.close()


if __name__ == "__main__":
    unittest.main()
