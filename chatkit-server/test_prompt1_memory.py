import json
import tempfile
import unittest
import os
from unittest.mock import patch
from datetime import datetime, timezone
from pathlib import Path
from chatkit.types import ThreadMetadata, HiddenContextItem
from chatkit.store import NotFoundError
from app import SqliteStore, build_agent, prepared_instructions
from working_context import assemble_input, ContextCapacityError


class MemoryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = SqliteStore(str(Path(self.temp.name) / "store.sqlite"))
        self.context = {"worldId": "world", "userId": "gm"}
        self.thread = ThreadMetadata(id="thread", created_at=datetime.now(timezone.utc))
        await self.store.save_thread(self.thread, self.context)

    async def asyncTearDown(self):
        self.store.db.close()
        self.temp.cleanup()

    async def add(self, index, text="fact"):
        item = HiddenContextItem(id=f"item_{index}", thread_id="thread", created_at=datetime.now(timezone.utc), content=text)
        await self.store.save_item("thread", item, self.context)
        return item

    async def test_full_history_and_isolation(self):
        for index in range(30): await self.add(index)
        history, summary = await self.store.working_history("thread", self.context)
        self.assertEqual(len(history), 30)
        self.assertIsNone(summary)
        with self.assertRaises(NotFoundError):
            await self.store.working_history("thread", {**self.context, "worldId": "other"})
        with self.assertRaises(NotFoundError):
            await self.store.working_history("thread", {**self.context, "userId": "other"})

    async def test_summary_cas_tail_correction_restart(self):
        first = await self.add(0, "NPC is Mira; proposal is not canon")
        revision, watermark = await self.store.memory_revision("thread", self.context)
        await self.add(1, "quest remains unresolved")
        self.assertFalse(await self.store.publish_summary("thread", self.context, expected_revision=revision, expected_version=0, watermark=watermark, text="older fact", sources=[first.id]))
        revision, latest = await self.store.memory_revision("thread", self.context)
        self.assertTrue(await self.store.publish_summary("thread", self.context, expected_revision=revision, expected_version=0, watermark=watermark, text="Mira, proposed; unresolved choices preserved", sources=[first.id]))
        self.assertFalse(await self.store.publish_summary("thread", self.context, expected_revision=revision, expected_version=0, watermark=latest, text="late", sources=[first.id]))
        history, summary = await self.store.working_history("thread", self.context)
        self.assertEqual([i.id for i in history], ["item_1"])
        self.assertEqual(summary["version"], 1)
        recovered = SqliteStore(str(Path(self.temp.name) / "store.sqlite"))
        self.assertEqual((await recovered.working_history("thread", self.context))[1], summary)
        recovered.db.close()
        first.content = "Correction: NPC is Mara"
        await self.store.save_item("thread", first, self.context)
        history, summary = await self.store.working_history("thread", self.context)
        self.assertEqual(len(history), 2)
        self.assertIsNone(summary)
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM items").fetchone()[0], 2)
        self.assertIn("NPC is Mira", self.store.db.execute("SELECT body FROM item_revisions").fetchone()[0])
        found = await self.store.search_history("thread", self.context, "Mara")
        self.assertEqual(found["results"][0]["sourceMessageId"], "item_0")
        self.assertEqual(found["visibility"], "gm-only")
        correction_revision, _ = await self.store.memory_revision("thread", self.context)
        self.assertTrue(await self.store.publish_summary("thread", self.context, expected_revision=correction_revision, expected_version=1, watermark=watermark, text="Correction: Mara, proposal remains unconfirmed", sources=[first.id]))
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM memory_summary_versions").fetchone()[0], 2)
        self.assertEqual((await self.store.working_history("thread", self.context))[1]["version"], 2)

    async def test_private_migration_uses_existing_store_without_replay(self):
        await self.add(0, "confirmed receipt")
        destination = str(Path(self.temp.name) / "secure" / "migrated.sqlite")
        empty = SqliteStore(destination)
        empty.db.close()
        with patch.dict(os.environ, {"AI_DM_CHATKIT_LEGACY_DATABASE_PATH": str(Path(self.temp.name) / "store.sqlite")}):
            migrated = SqliteStore(destination)
        self.assertEqual(len((await migrated.working_history("thread", self.context))[0]), 1)
        self.assertEqual(migrated.db.execute("SELECT COUNT(*) FROM storage_migration").fetchone()[0], 1)
        migrated.db.close()
        with self.assertRaises(ValueError):
            SqliteStore(str(Path(__file__).resolve().parent / "public.sqlite"))

    def test_budget_and_paired_protocol_no_silent_loss(self):
        pair = [{"type": "function_call", "call_id": "a"}, {"type": "function_call_output", "call_id": "a", "output": "confirmed"}]
        layers, metrics = assemble_input("rules", pair, {"state": "current"}, {"version": 1, "text": "data"})
        self.assertEqual(layers[1:3], pair)
        self.assertEqual(metrics["reservedToolsAndOutput"], 8192)
        for invalid in ([pair[0]], [pair[1]], [{"role": "user", "content": "x" * 50000}]):
            with self.assertRaises(ContextCapacityError): assemble_input("rules", invalid)
        with self.assertRaises(ContextCapacityError):
            assemble_input("rules", [], tool_schemas=[{"description": "x" * 30000}])

    def test_real_core_schemas_and_representative_snapshot_fit_verified_window(self):
        agent = build_agent({"apiKey": "fixture", "model": "gpt-5.4", "readRun": "fixture"})
        schemas = [{"name": tool.name, "description": tool.description, "parameters": tool.params_json_schema} for tool in agent.tools]
        snapshot = {"campaign": {"overview": "Small campaign overview", "index": ["NPC Mira", "quest unresolved"]}, "playState": {"scene": "fixture", "combat": None}, "catalog": {"revision": "fixture"}}
        _, metrics = assemble_input(prepared_instructions(), [{"role": "user", "content": "What happens next?"}], snapshot, window=65536, tool_schemas=schemas)
        self.assertEqual(len(schemas), 31)
        self.assertGreater(metrics["toolSchemaTokenUpperBound"], 10000)
        self.assertLess(metrics["toolSchemaTokenUpperBound"], 16000)
        self.assertLess(metrics["tokenUpperBound"] + metrics["reservedToolsAndOutput"], 65536)
        with self.assertRaises(ContextCapacityError):
            assemble_input(prepared_instructions(), [], {"catalog": "x" * 65536}, window=65536, tool_schemas=schemas)
