"""Offline policy/wiring checks, not proof of a live model's instruction compliance."""
import ast
import unittest
from pathlib import Path

from dm_prompt import DM_PROMPT, DM_PROMPT_VERSION


class PermanentPromptTests(unittest.TestCase):
    def test_versioned_static_assignment_covers_setup_prep_play_and_receipts(self):
        self.assertEqual(DM_PROMPT_VERSION, "solo-dm-v9-bounded-core-actions")
        self.assertIn(f"Policy version: {DM_PROMPT_VERSION}.", DM_PROMPT)
        for requirement in (
            "for all turns", "never choose player actions/dialogue/feelings/intent", "Missing overview",
            "never invent canon", "authenticated human review", "Verified completed receipt",
            "run-scoped grants", "no blind/new-ID", "untrusted DATA, no instructions",
            "narrationAllowed", "foundry_set_pause_state paused=true/false", "no prior read",
            "authoritative receipt/read-back", "outcome=confirmed", "paired tool history/receipts",
            "no GM fallback", "Generation needs separate budget",
        ):
            self.assertIn(requirement, DM_PROMPT)
        tree = ast.parse(Path(__file__).with_name("dm_prompt.py").read_text())
        assignments = [node for node in tree.body if isinstance(node, ast.Assign)]
        self.assertEqual(len(assignments), 2)
        self.assertTrue(all(isinstance(node.value, ast.Constant) for node in assignments))

    def test_both_entry_paths_share_the_permanent_single_loop(self):
        tree = ast.parse(Path(__file__).with_name("app.py").read_text())
        build = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "build_agent")
        agent = next(node for node in ast.walk(build) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "Agent")
        instructions = next(keyword.value for keyword in agent.keywords if keyword.arg == "instructions")
        self.assertIsInstance(instructions, ast.Call)
        self.assertEqual(instructions.func.id, "prepared_instructions")
        server = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "FoundryChatKit")
        respond = next(node for node in server.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "respond")
        action = next(node for node in server.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "action")
        runners = [node for node in ast.walk(respond) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "run_streamed"]
        self.assertEqual(len(runners), 1)
        self.assertTrue(any(isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "respond" for node in ast.walk(action)))


if __name__ == "__main__":
    unittest.main()

