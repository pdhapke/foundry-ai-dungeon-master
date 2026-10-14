import copy
import unittest
from unittest.mock import patch
import test_phase3_narration as worker
from app import read_foundry

class IndependentNarrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_confirmed_receipt_with_wrong_requested_state_cannot_release(self):
        for value in (99, "12", None):
            cases=copy.deepcopy(worker.CASES)
            cases[3][2]["state"]["value"]=value
            with patch.object(worker,"CASES",cases):
                helper=worker.NarrationTests()
                request,agent,model,ops,inputs,error=await helper.run_case()
            self.assertNotIn("release_mutation_capability",ops)
            self.assertNotIn("_narrationOnly",request)
            self.assertTrue(agent.tools)
    async def test_local_fence_covers_campaign_discovery_and_every_adapter_operation(self):
        request={"_narrationOnly":True,"apiKey":"fixture","readRun":"old"}
        for operation in ("campaign_propose","campaign_search","world_file_write","tool_search","tool_load","tool_execute","native_roll_attack","native_apply_attack_damage","native_set_pause_core","native_core_action","native_core_move_batch","scene","initial_context"):
            with patch("app.httpx.AsyncClient", side_effect=AssertionError("network forbidden")):
                result=await read_foundry(request,operation,{})
            self.assertEqual(result["error"]["code"],"NARRATION_ONLY")


from app import persist_narration_basis_label, SqliteStore
from chatkit.types import ThreadMetadata, AssistantMessageItem, ThreadItemDoneEvent
from chatkit.agents import AgentContext
from datetime import datetime, timezone
from unittest.mock import AsyncMock
import tempfile, asyncio
from pathlib import Path

class IndependentHistoricalLabelTests(unittest.IsolatedAsyncioTestCase):
    async def test_typed_done_event_is_durable_before_delivery_and_replay_is_inert(self):
        store=SqliteStore(":memory:");request={"worldId":"w","userId":"gm"}
        thread=ThreadMetadata(id="label-thread",created_at=datetime.now(timezone.utc));await store.save_thread(thread,request)
        ctx=AgentContext(thread=thread,store=store,request_context=request);events=[]
        async def deliver(event):
            self.assertIsInstance(event,ThreadItemDoneEvent)
            saved=await store.load_item(thread.id,event.item.id,request)
            self.assertIsInstance(saved,AssistantMessageItem)
            self.assertEqual(saved,event.item);events.append(event)
        with patch.object(AgentContext,"stream",side_effect=deliver):
            await persist_narration_basis_label(ctx,"msg_narration_stable","HP set to 18.")
            await persist_narration_basis_label(ctx,"msg_narration_stable","HP set to 18.")
            with self.assertRaisesRegex(RuntimeError,"identity conflict"):
                await persist_narration_basis_label(ctx,"msg_narration_stable","HP set to 20.")
        self.assertEqual(len(events),1)
        self.assertIn("Later actions may have changed",events[0].item.content[0].text)
        store.db.close()
    async def test_cancelled_label_delivery_remains_in_reopened_history_without_duplicate(self):
        with tempfile.TemporaryDirectory() as directory:
            path=str(Path(directory)/"label.sqlite");request={"worldId":"w","userId":"gm"};store=SqliteStore(path)
            thread=ThreadMetadata(id="label-thread",created_at=datetime.now(timezone.utc));await store.save_thread(thread,request)
            ctx=AgentContext(thread=thread,store=store,request_context=request)
            with patch.object(AgentContext,"stream",side_effect=asyncio.CancelledError):
                with self.assertRaises(asyncio.CancelledError):await persist_narration_basis_label(ctx,"msg_narration_cancel","Door opened.")
            store.db.close();store=SqliteStore(path);ctx=AgentContext(thread=thread,store=store,request_context=request)
            with patch.object(AgentContext,"stream") as stream:
                await persist_narration_basis_label(ctx,"msg_narration_cancel","Door opened.");stream.assert_not_called()
            history=await store.load_thread_items(thread.id,None,30,"asc",request)
            self.assertEqual(len(history.data),1);self.assertIsInstance(history.data[0],AssistantMessageItem)
            self.assertIn("completed action",history.data[0].content[0].text);store.db.close()
if __name__=="__main__":unittest.main()

