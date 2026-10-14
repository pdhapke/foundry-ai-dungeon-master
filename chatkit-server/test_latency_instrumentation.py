"""Passive diagnostics installed-SDK tests, no provider or Foundry calls."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from app import observe_model_stream, trace, start_latency_scope
from test_routine_completion import CommandModel, CompletionTests, CASES

class ObservedFixture(CommandModel):
    def __init__(self, name, args, retrieval=False):
        super().__init__(name,args,retrieval)
        self.context={"traceId":"12345678-1234-1234-1234-123456789abc"}
    async def stream_response(self,*args,**kwargs):
        async for event in observe_model_stream(self.context, super().stream_response(*args,**kwargs)):
            yield event

class LatencyTests(unittest.IsolatedAsyncioTestCase):
    async def test_observed_installed_sdk_stream_preserves_one_request_and_private_content(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"AI_DM_CHATKIT_DATABASE_PATH":str(Path(directory)/"store.sqlite")}), patch("test_routine_completion.CommandModel",ObservedFixture):
            model,events,inputs=await CompletionTests().run_case(CASES[3])
            self.assertEqual(model.calls,1)
            self.assertTrue(any(i.get("type")=="function_call_output" for i in inputs))
            rows=[json.loads(line) for line in (Path(directory)/"latency-traces.jsonl").read_text().splitlines()]
            self.assertEqual([r["stage"] for r in rows],["model-stream-invocation","model-first-event","model-provider-response","model-provider-request-id-unavailable","model-complete-arguments-event"])
            self.assertTrue(all(r["elapsedMs"]>=0 for r in rows))
            self.assertNotIn('"arguments"',json.dumps(rows))
            self.assertNotIn('fixture-response',json.dumps(rows))
    async def test_exposed_transport_request_id_is_separate_hashed_metadata(self):
        from openai.types.responses import Response, ResponseCompletedEvent
        response=Response.model_construct(id="response-fixture",object="response",created_at=0,model="fixture",output=[],usage=None)
        response._request_id="http-request-fixture"
        async def events():
            yield ResponseCompletedEvent(type="response.completed",sequence_number=1,response=response)
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ,{"AI_DM_CHATKIT_DATABASE_PATH":str(Path(directory)/"store.sqlite")}):
            emitted=[event async for event in observe_model_stream({"traceId":"12345678-1234-1234-1234-123456789abc"},events())]
            rows=[json.loads(line) for line in (Path(directory)/"latency-traces.jsonl").read_text().splitlines()]
            self.assertEqual(len(emitted),1)
            request=next(r for r in rows if r["stage"]=="model-provider-request-id")
            provider_response=next(r for r in rows if r["stage"]=="model-provider-response")
            self.assertNotEqual(request["providerRequestHash"],provider_response["providerResponseHash"])
            self.assertNotIn("http-request-fixture",json.dumps(rows))

    def test_copied_response_origin_is_explicitly_distinct_from_outer_store_origin(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ,{"AI_DM_CHATKIT_DATABASE_PATH":str(Path(directory)/"store.sqlite")}):
            outer={"traceId":"12345678-1234-1234-1234-123456789abc"}
            trace(outer,"store-item-commit-complete")
            response={**outer}
            start_latency_scope(response)
            trace(response,"python-response-start")
            trace(outer,"store-item-commit-complete")
            rows=[json.loads(line) for line in (Path(directory)/"latency-traces.jsonl").read_text().splitlines()]
            self.assertEqual(rows[0]["scopeId"],rows[2]["scopeId"])
            self.assertNotEqual(rows[0]["scopeId"],rows[1]["scopeId"])
            self.assertTrue(all(r["elapsedMs"]>=0 for r in rows))

    async def test_diagnostic_failure_never_stops_stream(self):
        with patch.dict(os.environ,{"AI_DM_CHATKIT_DATABASE_PATH":"NUL/store.sqlite"}):
            model=ObservedFixture(CASES[3][0],CASES[3][1])
            events=[e async for e in model.stream_response(None,[],None,[],None,[],None)]
            self.assertTrue(events)
            self.assertEqual(model.calls,1)

if __name__=='__main__': unittest.main()
