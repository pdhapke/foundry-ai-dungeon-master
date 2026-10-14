import copy
import unittest
from preparation.pipeline import PreparationPipeline, ORDER
from preparation.workflow import VERSION, template_resource


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.inputs = {"worldId": "one", "sources": [{"id": "s", "revision": "v1", "visibility": "gm", "content": "Existing facts"}]}
        self.pipeline = PreparationPipeline(self.inputs)

    def output(self, name):
        candidate = {"visibility": "gm", "status": "draft", "sourceRefs": [{"id": "s", "revision": "v1"}]}
        schema = template_resource(name)["outputSchema"]
        output = {"worldId": "one", "version": VERSION, "status": "draft"}
        for field in schema["required"][3:]:
            item = schema["properties"][field]
            output[field] = [] if item.get("type") == "array" else {} if field == "readiness" else candidate
        return output

    def test_order_completion_and_no_self_publication(self):
        with self.assertRaises(ValueError):
            self.pipeline.submit("records", self.inputs, self.output("records"), 0)
        for revision, step in enumerate(ORDER):
            self.pipeline.submit(step, self.inputs, self.output(step), revision)
        status = self.pipeline.status()
        self.assertEqual(status["status"], "completed")
        self.assertIsNone(status["currentPass"])
        self.assertFalse(status["publicationApproved"])
        self.assertNotIn("Existing facts", str(status))
        self.assertEqual(status["modelCalls"], 0)

    def test_source_content_change_even_with_unchanged_revision_is_stale(self):
        changed = copy.deepcopy(self.inputs)
        changed["sources"][0]["content"] = "New facts"
        self.pipeline.submit("inventory", changed, self.output("inventory"), 0)
        self.assertEqual(self.pipeline.status()["status"], "stale")
        with self.assertRaises(ValueError):
            self.pipeline.control("resume", 1)

    def test_pause_restore_resume_cancel_and_revision(self):
        self.pipeline.control("pause", 0)
        restored = PreparationPipeline.restore(self.pipeline.state, "one")
        with self.assertRaises(ValueError):
            restored.submit("inventory", self.inputs, self.output("inventory"), 1)
        restored.control("resume", 1)
        restored.submit("inventory", self.inputs, self.output("inventory"), 2)
        with self.assertRaises(ValueError):
            restored.control("cancel", 2)
        restored.control("cancel", 3)
        self.assertEqual(restored.status()["status"], "cancelled")
        with self.assertRaises(ValueError):
            restored.control("resume", 4)
        with self.assertRaises(ValueError):
            PreparationPipeline.restore(self.pipeline.state, "two")

    def test_blocked_step_retry_and_publication_rejection(self):
        output = self.output("inventory")
        output["status"] = "blocked"
        self.pipeline.submit("inventory", self.inputs, output, 0)
        self.assertEqual(self.pipeline.status()["status"], "blocked")
        with self.assertRaises(ValueError):
            self.pipeline.submit("inventory", self.inputs, {**self.output("inventory"), "publish": True}, 1)
        self.pipeline.submit("inventory", self.inputs, self.output("inventory"), 1)
        self.assertEqual(self.pipeline.status()["currentPass"], "interview")

    def test_answers_change_invalidates_source_manifest(self):
        changed = {**self.inputs, "answers": []}
        self.pipeline.submit("inventory", changed, self.output("inventory"), 0)
        self.assertEqual(self.pipeline.status()["status"], "stale")

    def test_next_request_preserves_structured_prior_output(self):
        output = self.output("inventory")
        output["facts"] = [{"text": "A private source-qualified fact", "visibility": "gm", "status": "draft", "sourceRefs": [{"id": "s", "revision": "v1"}]}]
        self.pipeline.submit("inventory", self.inputs, output, 0)
        request = self.pipeline.request()
        self.assertEqual(request["template"]["id"], "interview")
        self.assertEqual(request["untrustedInput"]["priorOutputs"][0]["candidate"], output["facts"][0])
        self.assertFalse(request["publicationApproved"])
        self.pipeline.state["steps"]["inventory"]["output"]["facts"][0]["text"] = "tampered"
        with self.assertRaises(ValueError):
            self.pipeline.request()

    def test_composition_refuses_oversize_without_truncation(self):
        inputs = copy.deepcopy(self.inputs)
        inputs["sources"][0]["content"] = "x" * 14500
        pipeline = PreparationPipeline(inputs)
        output = self.output("inventory")
        output["facts"] = [{"text": "qualification " * 300, "visibility": "gm", "status": "draft", "sourceRefs": [{"id": "s", "revision": "v1"}]}]
        pipeline.submit("inventory", inputs, output, 0)
        with self.assertRaises(ValueError):
            pipeline.request()
        self.assertEqual(pipeline.state["inputs"]["sources"][0]["content"], inputs["sources"][0]["content"])


if __name__ == "__main__":
    unittest.main()
