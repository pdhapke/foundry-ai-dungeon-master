"""Independent audience bootstrap boundary; no inference or network."""
import base64
import json
import unittest
from fastapi.testclient import TestClient
from app import SqliteStore, create_app

class BootstrapBoundary(unittest.TestCase):
    def setUp(self):
        self.store = SqliteStore(":memory:")
        self.client = TestClient(create_app(self.store, object(), "fixture"))
        self.headers = {"x-chatkit-secret":"fixture", "x-chatkit-principal":base64.b64encode(json.dumps({"worldId":"world","userId":"gm","isGm":True}).encode()).decode()}
        self.selection = {"worldId":"world","sceneId":"scene","userId":"player","clientId":"browser","tokenId":"hero"}
    def tearDown(self):
        self.client.close()
        self.store.db.close()
    def test_bootstrap_binds_before_action_and_denies_gm_inference(self):
        response = self.client.post("/chatkit/thread",headers=self.headers,json={"playerObservation":self.selection})
        self.assertEqual(response.status_code,200)
        thread = response.json()["threadId"]
        saved = self.store.db.execute("SELECT selection FROM player_threads WHERE thread_id=?",(thread,)).fetchone()
        self.assertEqual(json.loads(saved[0]),self.selection)
        response = self.client.post("/chatkit",headers=self.headers,json={"type":"threads.add_user_message","params":{"thread_id":thread}})
        self.assertEqual(response.status_code,400)
    def test_rejects_wrong_world_and_auxiliary_inputs(self):
        for supplied in [{**self.selection,"worldId":"other"},{**self.selection,"privateNotes":"secret"},None]:
            with self.subTest(supplied=supplied):
                self.assertEqual(self.client.post("/chatkit/thread",headers=self.headers,json={"playerObservation":supplied}).status_code,400)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM player_threads").fetchone()[0],0)
    def test_legacy_empty_bootstrap_and_authentication(self):
        self.assertEqual(self.client.post("/chatkit/thread",headers=self.headers).status_code,200)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM player_threads").fetchone()[0],0)
        self.assertEqual(self.client.post("/chatkit/thread",json={"playerObservation":self.selection}).status_code,401)

if __name__ == "__main__":
    unittest.main()

