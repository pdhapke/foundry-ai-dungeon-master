"""New privacy contract identity is captured at import, never health-request time."""
import hashlib
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient
import app as loaded
import player_observation

class PlayerObservationIdentityTests(unittest.TestCase):
    def test_health_contract_digest_is_loaded_snapshot(self):
        store = loaded.SqliteStore(':memory:')
        with TestClient(loaded.create_app(store, object(), 'fixture')) as client:
            initial = client.get('/health').json()
            self.assertEqual(initial['playerObservationDigest'], hashlib.sha256(Path(player_observation.__file__).read_bytes()).hexdigest())
            self.assertEqual(initial['playerObservationDigest'], loaded.PLAYER_OBSERVATION_STARTUP_DIGEST)
            with patch.object(Path, 'read_bytes', return_value=b'later replacement') as disk:
                self.assertEqual(client.get('/health').json(), initial)
                disk.assert_not_called()
        store.db.close()
