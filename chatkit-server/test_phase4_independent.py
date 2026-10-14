import asyncio,json,tempfile,unittest
from pathlib import Path
from datetime import datetime,timezone
from unittest.mock import patch
from agents import Runner,RunConfig
from chatkit.agents import AgentContext,stream_agent_response
from chatkit.types import ThreadMetadata
from app import build_agent,SqliteStore,PauseTimingHooks,ReceiptHistoryConverter,read_foundry,attack_sequence_receipt_summary
from test_phase3_narration import NarrationModel

class IndependentCombatTests(unittest.IsolatedAsyncioTestCase):
    async def test_old_narration_run_cannot_execute_or_resume_combat_sequence(self):
        with patch("app.httpx.AsyncClient",side_effect=AssertionError("network forbidden")):
            for op in ("native_attack_sequence","native_roll_attack","native_apply_attack_damage","tool_execute"):
                result=await read_foundry({"_narrationOnly":True},op,{})
                self.assertEqual(result["error"]["code"],"NARRATION_ONLY")
    def test_actual_damage_summary_reports_temp_hp_instead_of_equating_roll_to_hp_loss(self):
        child={"outcome":"confirmed","state":{"stage":"damage-applied","hit":True,"critical":False,"attackRoll":{"total":19,"result":"14+5"},"damageRolled":7,"damageApplied":3,"hpBefore":{"value":20,"temp":3},"hpAfter":{"value":20,"temp":0},"damageRolls":[{"total":7,"type":"slashing","result":"4+3"}]}}
        receipt={"outcome":"confirmed","state":{"completedStepCount":1,"steps":[{"stepId":"one","rollReceipt":child,"applyReceipt":child}],"continuation":None}}
        summary=attack_sequence_receipt_summary(receipt);self.assertIn("Damage applied: 3",summary);self.assertIn("20",summary);self.assertNotIn("Damage applied: 7",summary)
    async def test_cancelled_optional_response_preserves_complete_sequence_pair_and_factual_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            path=str(Path(directory)/"combat.sqlite");store=SqliteStore(path)
            request={"apiKey":"fixture","model":"fixture","readRun":"fixture","worldId":"world","userId":"gm","threadId":"thread"}
            thread=ThreadMetadata(id="thread",created_at=datetime.now(timezone.utc));await store.save_thread(thread,request)
            ctx=AgentContext(thread=thread,store=store,request_context=request);agent=build_agent(request)
            args={"action_id":"resume","prior_sequence_request_id":"prior","continuation_id":"ticket","max_duration_ms":8000}
            model=NarrationModel("foundry_resume_attack_sequence",args,cancel_narration=True);agent.model=model
            receipt={"schemaVersion":"attack-sequence-v1","outcome":"partial","worldId":"world","correlationId":"combat-receipt","state":{"completedStepCount":0,"steps":[],"continuation":{"id":"ticket"}}}
            with patch("app.read_foundry",return_value={"ok":True,"result":receipt}) as adapter:
                run=Runner.run_streamed(agent,"fixture",context=ctx,hooks=PauseTimingHooks(request),run_config=RunConfig(tracing_disabled=True))
                async def collect():return [e async for e in stream_agent_response(ctx,run)]
                task=asyncio.create_task(collect());await asyncio.wait_for(model.narration_started.wait(),3);run.cancel();await task;self.assertEqual(adapter.await_count,1)
            store.db.close();store=SqliteStore(path)
            history=await store.load_thread_items("thread",None,30,"asc",request);inputs=await ReceiptHistoryConverter().to_agent_input(history.data)
            self.assertEqual(sum(x.get("type")=="function_call" for x in inputs),1);self.assertEqual(sum(x.get("type")=="function_call_output" for x in inputs),1)
            self.assertEqual(sum(x.type=="assistant_message" for x in history.data),1);self.assertFalse(request.get("_narrationOnly",False));store.db.close()
if __name__=="__main__":unittest.main()
