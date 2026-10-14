"""Offline independent health identity checks; no model or Foundry calls."""
import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient
import app as loaded
import dm_prompt


class BuildIdentityTests(unittest.TestCase):
    def test_health_describes_loaded_constants_without_rereading_disk(self):
        with tempfile.TemporaryDirectory() as directory:
            store = loaded.SqliteStore(str(Path(directory) / "test.sqlite"))
            client = TestClient(loaded.create_app(store, object(), "test-only"))
            initial = client.get("/health").json()
            self.assertEqual(initial["codeDigest"], loaded.STARTUP_CODE_DIGEST)
            self.assertEqual(initial["codeDigest"], hashlib.sha256(Path(loaded.__file__).read_bytes()).hexdigest())
            self.assertEqual(initial["promptDigest"], hashlib.sha256(loaded.DM_PROMPT.encode()).hexdigest())
            self.assertEqual(initial["promptVersion"], loaded.DM_PROMPT_VERSION)
            with patch.object(Path, "read_bytes", return_value=b"later disk code") as disk_read, patch.object(dm_prompt, "DM_PROMPT", "later prompt source"):
                later = client.get("/health").json()
                self.assertEqual(later, initial)
                disk_read.assert_not_called()
            self.assertNotIn("test-only", str(initial))
            client.close()
            store.db.close()


if __name__ == "__main__":
    unittest.main()
