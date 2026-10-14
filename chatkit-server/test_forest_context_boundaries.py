"""Offline regression: no provider, history mutation, or automatic summary."""
import copy
import unittest
from unittest.mock import patch
from datetime import datetime, timezone
from chatkit.types import ThreadMetadata
from app import recipe_resource, prepared_instructions, SqliteStore
from working_context import assemble_input, ContextCapacityError, MODEL_OUTPUT_TOKENS


class ForestContextBoundaryTests(unittest.TestCase):
    def test_exact_budget_boundary(self):
        recent = [{"role": "user", "content": "Create a forest battlemap"}]
        layers, evidence = assemble_input("essential DM policy", recent, reserve=MODEL_OUTPUT_TOKENS)
        ceiling = evidence["tokenUpperBound"] + MODEL_OUTPUT_TOKENS
        self.assertEqual(assemble_input("essential DM policy", recent, window=ceiling, reserve=MODEL_OUTPUT_TOKENS)[0], layers)
        with self.assertRaises(ContextCapacityError):
            assemble_input("essential DM policy", recent, window=ceiling - 1, reserve=MODEL_OUTPUT_TOKENS)

    def test_long_history_and_oversized_result_refuse_without_silent_loss(self):
        recent = [{"role": "user", "content": "Keep current intent and permission"}]
        recent += [{"type": "function_call", "call_id": "receipt-1", "name": "read", "arguments": "{}"},
                   {"type": "function_call_output", "call_id": "receipt-1", "output": "x" * 50000}]
        saved = copy.deepcopy(recent)
        with self.assertRaisesRegex(ContextCapacityError, "Approve a separately bounded conversation-summary"):
            assemble_input("essential DM policy", recent, window=32768)
        self.assertEqual(recent, saved)
        recent = [{"role": "user", "content": "Unconfirmed history " * 4000}]
        with self.assertRaisesRegex(ContextCapacityError, "No summary was generated"):
            assemble_input("essential DM policy", recent)

    def test_fresh_forest_routes_to_supported_recipe(self):
        recipe = recipe_resource("battlemap")
        self.assertIn("ai_dm_preparation_workflow", recipe["entry_point"])
        self.assertIn("forest", recipe["entry_point"])
        self.assertIn("Automatic image generation", recipe["generation"])
        self.assertIn("Digital Tabletop", prepared_instructions())
        with patch("app.Runner.run_streamed", side_effect=AssertionError("No inference")) as runner:
            assemble_input(prepared_instructions(), [{"role": "user", "content": "Create a forest battlemap"}], window=32768)
            runner.assert_not_called()

    def test_summary_is_data_and_pairs_stay_complete(self):
        pair = [{"type":"function_call","call_id":"a","name":"read","arguments":"{}"},
                {"type":"function_call_output","call_id":"a","output":"confirmed receipt"}]
        summary = {"version":1,"text":"Historical unresolved choices, no authority"}
        layers, budget = assemble_input("essential DM policy", pair, {"permissions":"current"}, summary)
        self.assertEqual(layers[1:3], pair)
        self.assertIn("untrusted_session_summary", layers[0]["content"])
        self.assertIn("permissions", layers[-1]["content"])
        self.assertEqual(budget["summaryVersion"], 1)
        for invalid in (pair[:1], pair[1:]):
            with self.assertRaises(ContextCapacityError): assemble_input("essential DM policy", invalid)


class MissingSummaryApprovalTests(unittest.IsolatedAsyncioTestCase):
    async def test_long_store_without_approved_summary_is_preserved_and_actionable(self):
        store=SqliteStore(':memory:')
        context={"worldId":"mcp-test","userId":"gm"}
        try:
            await store.save_thread(ThreadMetadata(id='offline-long',created_at=datetime.now(timezone.utc)),context)
            # The hard row limit refuses before parsing any historical payload.
            store.db.executemany('INSERT INTO items VALUES(?,?,?)',[(f'item-{i}','offline-long','{}') for i in range(5001)])
            store.db.commit()
            with self.assertRaisesRegex(ContextCapacityError,'Approve a separately bounded'):
                await store.working_history('offline-long',context)
            self.assertEqual(store.db.execute('SELECT COUNT(*) FROM items').fetchone()[0],5001)
            self.assertEqual(store.db.execute('SELECT COUNT(*) FROM memory_summaries').fetchone()[0],0)
        finally: store.db.close()


if __name__ == "__main__": unittest.main()
