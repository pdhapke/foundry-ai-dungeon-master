"""Independent model-free long history, delayed publication, archive and recipe gate."""
import asyncio
import contextlib
import io
import json
import sys
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"chatkit-server"))
os.environ["AI_DM_CHATKIT_DATABASE_PATH"] = ":memory:"
from app import SqliteStore, ReceiptHistoryConverter, recipe_resource, prepared_instructions, PauseTimingHooks
from types import SimpleNamespace
from chatkit.types import ThreadMetadata, HiddenContextItem
from working_context import assemble_input, ContextCapacityError

class MemoryGate(unittest.IsolatedAsyncioTestCase):
    async def test_delayed_publication_correction_archive_and_restart(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            path=str(Path(directory)/"store.sqlite")
            store=SqliteStore(path)
            context={"worldId":"w","userId":"gm"}
            await store.save_thread(ThreadMetadata(id="t",created_at=datetime.now(timezone.utc)),context)
            item=HiddenContextItem(id="i",thread_id="t",created_at=datetime.now(timezone.utc),content="Original older fact")
            await store.save_item("t",item,context)
            revision,watermark=await store.memory_revision("t",context)
            original=ReceiptHistoryConverter.to_agent_input
            async def changed(converter,items):
                item.content="Correction older fact"
                await store.save_item("t",item,context)
                return await original(converter,items)
            with patch.object(ReceiptHistoryConverter,"to_agent_input",changed):
                accepted=await store.publish_summary("t",context,expected_revision=revision,expected_version=0,watermark=watermark,text="stale",sources=["i"])
            self.assertFalse(accepted)
            self.assertEqual(store.db.execute("SELECT COUNT(*) FROM memory_summaries").fetchone()[0],0)
            archive=store.db.execute("SELECT * FROM item_revisions").fetchall()
            self.assertIn("Original older fact",str(archive))
            store.db.close()
            store=SqliteStore(path)
            history,summary=await store.working_history("t",context)
            self.assertEqual(history[0].content,"Correction older fact")
            self.assertIsNone(summary)
            store.db.close()
    async def test_every_model_request_rechecks_accumulated_results(self):
        context={"_workingContextBudget":{"window":32768}}
        hooks=PauseTimingHooks(context)
        agent=SimpleNamespace(tools=[])
        with self.assertRaises(ContextCapacityError):
            await hooks.on_llm_start(None,agent,"rules",[{"role":"user","content":"x"*40000}])
        self.assertEqual(hooks.requests,0)
    def test_recipes_and_budget_fail_closed(self):
        instructions=prepared_instructions()
        for name in ("start-combat","combat-round","surroundings","battlemap"):
            detail=recipe_resource(name)
            self.assertIn(name,instructions)
            self.assertLess(len(json.dumps(detail).encode()),8192)
        for invalid in ("../private","index","unknown"):
            with self.assertRaises(ValueError):recipe_resource(invalid)
        pair=[{"type":"function_call","call_id":"one"},{"type":"function_call_output","call_id":"one","output":"confirmed"}]
        layers,budget=assemble_input(instructions,pair)
        self.assertEqual(layers,pair)
        self.assertLess(budget["tokenUpperBound"],budget["window"]-budget["reservedToolsAndOutput"])
        with self.assertRaises(ContextCapacityError):assemble_input(instructions,[{"role":"user","content":"x"*40000}])
        with self.assertRaises(ContextCapacityError):assemble_input(instructions,[pair[1]])
if __name__=="__main__":unittest.main()


