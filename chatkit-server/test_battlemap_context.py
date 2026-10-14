"""Forest-map regression using real recipes/tools, without provider or world writes."""
import copy
import json
import unittest

from app import build_agent, agent_tool_schemas, prepared_instructions, recipe_resource, PauseTimingHooks
from working_context import assemble_input, ContextCapacityError, MODEL_OUTPUT_TOKENS


class BattlemapContextTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.context = {"model": "gpt-5.6-sol", "apiKey": "offline-not-a-credential", "readRun": "fixture"}
        self.agent = build_agent(self.context)
        self.schemas = agent_tool_schemas(self.agent)
        self.instructions = prepared_instructions()
        recent = [{"role": "user", "content": "Setup a forest battle map for me. "}]
        self.layers, budget = assemble_input(self.instructions, recent, {"fixture": ""},
            window=32768, reserve=MODEL_OUTPUT_TOKENS, tool_schemas=self.schemas)
        # Exact initial bound from the October 7 failed request. State is synthetic;
        # retain the actual packaged battlemap recipe and native tool definitions.
        self.layers[-1]["content"] += "x" * (20652 - budget["tokenUpperBound"])
        self.layers, self.context["_workingContextBudget"] = assemble_input(
            self.instructions, self.layers, window=32768, reserve=MODEL_OUTPUT_TOKENS,
            tool_schemas=self.schemas)
        self.assertEqual(self.context["_workingContextBudget"]["tokenUpperBound"], 20652)
        self.hooks = PauseTimingHooks(self.context)

    def recipe_exchange(self):
        return [
            {"type": "function_call", "id": "fc_fixture", "status": "completed",
             "call_id": "call_fixture", "name": "dm_recipe_read", "arguments": '{"recipe_id":"battlemap"}'},
            {"type": "function_call_output", "call_id": "call_fixture",
             "output": json.dumps(recipe_resource("battlemap"))},
        ]

    async def test_forest_request_can_continue_after_recipe_and_discovery(self):
        await self.hooks.on_llm_start(None, self.agent, self.instructions, self.layers)
        expanded = self.layers + self.recipe_exchange()
        original = copy.deepcopy(expanded)
        # Previous guard rejects this same complete exchange before continuation.
        with self.assertRaises(ContextCapacityError):
            assemble_input(self.instructions, expanded, window=32768, tool_schemas=self.schemas)
        await self.hooks.on_llm_start(None, self.agent, self.instructions, expanded)
        self.assertEqual(expanded, original)
        self.assertEqual(self.hooks.requests, 2)
        self.assertEqual(self.context["_workingContextBudget"]["reservedToolsAndOutput"], MODEL_OUTPUT_TOKENS)
        discovered = expanded + [
            {"type": "function_call", "call_id": "search_fixture", "name": "tool_search", "arguments": '{"query":"scene grid","limit":5}'},
            {"type": "function_call_output", "call_id": "search_fixture", "output": "bounded discovery fixture " + "x" * 2000},
        ]
        await self.hooks.on_llm_start(None, self.agent, self.instructions, discovered)
        self.assertEqual(self.hooks.requests, 3)

    async def test_retry_with_saved_recipe_uses_same_runtime_reserve(self):
        # Stored tool call/result pairs are retained on the next respond invocation.
        layers = self.layers + self.recipe_exchange()
        result, budget = assemble_input(self.instructions, layers, window=32768,
            reserve=MODEL_OUTPUT_TOKENS, tool_schemas=self.schemas)
        self.assertEqual(result, layers)
        self.assertLessEqual(budget["tokenUpperBound"] + MODEL_OUTPUT_TOKENS, 32768)

    async def test_real_overflow_and_pending_exchange_still_refuse_before_request(self):
        layers = self.layers + self.recipe_exchange()
        for invalid in (layers + [{"role": "user", "content": "x" * 9000}], layers[:-1]):
            with self.assertRaises(ContextCapacityError):
                await self.hooks.on_llm_start(None, self.agent, self.instructions, invalid)
            self.assertEqual(self.hooks.requests, 0)

    async def test_normal_output_has_no_app_cap_and_keeps_context_admission(self):
        for cap in (None, MODEL_OUTPUT_TOKENS + 1, 0):
            self.agent.model_settings.max_tokens = cap
            await self.hooks.on_llm_start(None, self.agent, self.instructions, self.layers)
        self.assertEqual(self.hooks.requests, 3)

if __name__ == "__main__":
    unittest.main()
