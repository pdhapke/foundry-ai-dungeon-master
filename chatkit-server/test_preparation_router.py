import sqlite3
import unittest
from types import SimpleNamespace
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from preparation.router import create_preparation_router


class RouterTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:", check_same_thread=False)
        def authenticate(request):
            if request.headers.get("secret") != "test":
                raise HTTPException(401)
            return {"worldId": request.headers.get("world", "one"), "userId": request.headers.get("user", "gm")}
        app = FastAPI()
        app.include_router(create_preparation_router(authenticate, SimpleNamespace(db=self.db)))
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.db.close()

    def call(self, body, **headers):
        return self.client.post("/preparation", json=body, headers={"secret": "test", **headers})

    def test_auth_and_world_binding(self):
        self.assertEqual(self.client.post("/preparation", json={}).status_code, 401)
        body = {"action": "request", "passId": "inventory", "inputs": {"worldId": "two", "sources": []}}
        self.assertEqual(self.call(body).status_code, 400)

    def test_persist_resume_isolation_and_stale_edit(self):
        base = {"action": "interview", "sessionId": "setup"}
        started = self.call({**base, "operation": "start"})
        self.assertEqual(started.status_code, 200)
        answer = {**base, "operation": "answer", "questionId": "premise", "text": "A proposed mystery", "expectedRevision": 0}
        self.assertEqual(self.call(answer).status_code, 200)
        self.assertEqual(self.call(answer).status_code, 400)
        self.assertEqual(self.call(base, world="two").status_code, 400)
        self.assertEqual(self.call(base, user="other").status_code, 400)
        self.assertEqual(self.call({**base, "operation": "pause", "expectedRevision": 1}).status_code, 200)
        self.assertEqual(self.call(base).json()["questions"], [])
        resumed = self.call({**base, "operation": "resume", "expectedRevision": 2})
        self.assertEqual(resumed.status_code, 200)
        self.assertEqual(resumed.json()["session"]["answers"]["premise"]["text"], "A proposed mystery")

    def test_bounds(self):
        response = self.client.post("/preparation", content="x" * 42001, headers={"secret": "test"})
        self.assertEqual(response.status_code, 413)

    def test_pipeline_persistence_repeat_and_scope(self):
        inputs = {"worldId": "one", "sources": []}
        base = {"action": "pipeline", "sessionId": "prep"}
        self.assertEqual(self.call({**base, "operation": "create", "inputs": inputs}).status_code, 200)
        self.assertEqual(self.call({**base, "operation": "create", "inputs": inputs}).json()["revision"], 0)
        self.assertEqual(self.call(base, world="two").status_code, 400)
        self.assertEqual(self.call(base, user="other").status_code, 400)
        self.assertEqual(self.call({**base, "operation": "pause", "expectedRevision": 0}).status_code, 200)
        self.assertEqual(self.call(base).json()["status"], "paused")
        self.assertEqual(self.call({**base, "operation": "resume", "expectedRevision": 1}).status_code, 200)
        self.assertEqual(self.call({**base, "operation": "cancel", "expectedRevision": 2}).json()["status"], "cancelled")


if __name__ == "__main__":
    unittest.main()
