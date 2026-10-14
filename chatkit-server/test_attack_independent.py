"""Independent authoritative attack summaries and typed adapters; no paid inference."""
import json
import unittest
from unittest.mock import patch
from agents.tool_context import ToolContext
from app import attack_receipt_summary, build_agent


def receipt(stage="damage-rolled", outcome="confirmed"):
    return {"schemaVersion": "attack-actions-v1", "outcome": outcome, "state": {"stage": stage, "attackRoll": {"total": 19, "result": "15+4"}, "hit": True, "critical": False,
        "damageRolls": [{"total": 6, "type": "slashing", "result": "4+2"}], "damageRolled": 6, "damageApplied": 3,
        "hpBefore": {"value": 20, "temp": 3}, "hpAfter": {"value": 20, "temp": 0}}}


class IndependentAttackTests(unittest.IsolatedAsyncioTestCase):
    def test_rolled_and_applied_damage_summaries_are_distinct_and_uncertainty_is_explicit(self):
        rolled = attack_receipt_summary(receipt())
        self.assertIn("Damage rolled: 6", rolled)
        self.assertIn("Damage not applied", rolled)
        self.assertNotIn("Damage applied: 3", rolled)
        applied = attack_receipt_summary(receipt("damage-applied"))
        self.assertIn("Damage rolled: 6", applied)
        self.assertIn("Damage applied: 3", applied)
        self.assertIn("temporary HP 3 → 0", applied)
        uncertain = attack_receipt_summary(receipt(outcome="uncertain"))
        self.assertIn("completion is not confirmed", uncertain)
        self.assertNotIn("Hit", uncertain)
        reaction = attack_receipt_summary(receipt("attack-rolled", "decision-required"))
        self.assertIn("Player decision or reaction required", reaction)
        self.assertNotIn("Damage applied", reaction)

    def test_native_application_cancellation_never_mislabels_the_persisted_attack_as_canceled_roll(self):
        summary = attack_receipt_summary(receipt("cancelled", "decision-required"))
        self.assertIn("Attack: 19", summary)
        self.assertIn("Damage rolled: 6", summary)
        self.assertIn("application cancelled", summary)
        self.assertNotIn("Roll cancelled", summary)

    async def test_first_turn_attack_tools_use_authenticated_adapter_and_model_cannot_supply_reaction_ticket(self):
        context = {"apiKey": "fixture", "model": "fixture", "readRun": "run", "threadId": "thread", "worldId": "world", "userId": "gm"}
        tools = {tool.name: tool for tool in build_agent(context).tools}
        self.assertTrue({"foundry_read_attack_state", "foundry_roll_attack", "foundry_apply_attack_damage"}.issubset(tools))
        apply = tools["foundry_apply_attack_damage"]
        self.assertNotIn("decision_id", apply.params_json_schema["properties"])
        args = json.dumps({"action_id": "stable", "prior_attack_request_id": "prior"})
        wrapper = ToolContext(context=context, tool_name=apply.name, tool_call_id="call", tool_arguments=args)
        with patch("app.read_foundry", return_value={"ok": True, "result": receipt("damage-applied")}) as adapter:
            output = await apply.on_invoke_tool(wrapper, args)
            self.assertEqual(json.loads(output)["state"]["stage"], "damage-applied")
            adapter.assert_awaited_once_with(context, "native_attack_action", {"actionId": "stable", "action": {"mode": "apply", "priorAttackRequestId": "prior"}})


if __name__ == "__main__":
    unittest.main()
