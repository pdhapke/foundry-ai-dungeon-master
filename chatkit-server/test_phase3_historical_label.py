"""Deterministic visible receipt-basis repair. Offline SDK/store tests only."""
import asyncio
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from chatkit.agents import AgentContext
from chatkit.types import ThreadMetadata, ThreadItemDoneEvent
from app import SqliteStore, persist_narration_basis_label
import test_phase3_narration as fixture

class HistoricalLabelTests(unittest.IsolatedAsyncioTestCase):
    async def test_installed_sdk_emits_receipt_then_visible_basis_before_second_request(self):
        request,agent,model,ops,inputs,error=await fixture.NarrationTests().run_case()
        self.assertIsNone(error)
        self.assertEqual(model.calls,2)
        self.assertEqual(len(model.labels_before_second),1)
        labels=[event for event in model.sdk_events if isinstance(event,ThreadItemDoneEvent) and event.item.id.startswith('msg_narration_basis_')]
        self.assertEqual(len(labels),1)
        label=labels[0].item.content[0].text
        self.assertIn('completed action: HP set to 12.',label)
        self.assertIn('Later actions may have changed the world.',label)
        receipt_index=next(i for i,event in enumerate(model.sdk_events) if isinstance(event,ThreadItemDoneEvent) and event.item.id.startswith('msg_receipt_'))
        label_index=model.sdk_events.index(labels[0])
        self.assertLess(receipt_index,label_index)
        self.assertEqual(sum(i.get('type')=='function_call' for i in inputs),1)
        self.assertEqual(sum(i.get('type')=='function_call_output' for i in inputs),1)
        self.assertIn(label,str(inputs))

    async def test_cancelled_delivery_reopens_with_one_label_and_replay_is_inert(self):
        with tempfile.TemporaryDirectory() as directory:
            path=str(Path(directory)/'fixture.sqlite')
            store=SqliteStore(path)
            request={'worldId':'world','userId':'gm'}
            thread=ThreadMetadata(id='thread',created_at=datetime.now(timezone.utc))
            await store.save_thread(thread,request)
            ctx=AgentContext(thread=thread,store=store,request_context=request)
            with patch.object(AgentContext,'stream',side_effect=asyncio.CancelledError):
                with self.assertRaises(asyncio.CancelledError):
                    await persist_narration_basis_label(ctx,'msg_narration_stable','Door opened.')
            store.db.close()
            reopened=SqliteStore(path)
            try:
                ctx=AgentContext(thread=await reopened.load_thread('thread',request),store=reopened,request_context=request)
                with patch.object(AgentContext,'stream') as stream:
                    await persist_narration_basis_label(ctx,'msg_narration_stable','Door opened.')
                    stream.assert_not_awaited()
                with self.assertRaises(RuntimeError):
                    await persist_narration_basis_label(ctx,'msg_narration_stable','Door closed.')
                history=await reopened.load_thread_items('thread',None,20,'asc',request)
                self.assertEqual(len(history.data),1)
                self.assertIn('Door opened.',history.data[0].content[0].text)
            finally:reopened.db.close()

if __name__=='__main__':unittest.main()
