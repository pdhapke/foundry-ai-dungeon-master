"""Configuration bounds only; no provider or Foundry calls."""
import os
import unittest
from unittest.mock import patch

from app import max_model_turns


class ModelRequestLimitTests(unittest.TestCase):
    def test_normal_usage_has_no_app_turn_cap(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(max_model_turns())
        with patch.dict(os.environ, {"AI_DM_CHATKIT_MAX_TURNS": "invalid"}):
            self.assertIsNone(max_model_turns())

    def test_legacy_environment_cap_does_not_limit_normal_use(self):
        for configured, expected in [("1", 1), ("3", 3), ("8", 8),
                                     ("15", 15), ("16", 15), ("1000", 15),
                                     ("0", 1), ("-5", 1)]:
            with self.subTest(configured=configured):
                with patch.dict(os.environ, {"AI_DM_CHATKIT_MAX_TURNS": configured}):
                    self.assertIsNone(max_model_turns())

    def test_only_exact_test_binding_imposes_a_ceiling(self):
        for ceiling in (1,2,3,4,5,6):
            self.assertEqual(max_model_turns({'_acceptanceBudget':{'maxModelRequests':ceiling}}), ceiling)
