"""Regression tests: the StepUp walkthrough numbers and the ledger beat."""

import tempfile
import unittest
from pathlib import Path

from prune import engine
from prune.ledger import Ledger


class StepUpFlowTest(unittest.TestCase):
    def setUp(self):
        engine.LEDGER = Ledger(Path(tempfile.mkdtemp()) / "ledger.json")

    def test_classify_ticket_end_to_end(self):
        s = engine.new_project(sample="stepup")
        gid = "stepup/classify.py::classify_ticket"
        g = s.groups[gid]
        self.assertEqual(g["site"]["answer"]["labels"], ["refund", "shipping", "other"])
        self.assertEqual(g["before"]["calls"], 40000)
        self.assertAlmostEqual(g["summary"]["cost_before"], 700, delta=1)
        self.assertTrue(s.run_tests(gid)["passed"])

        replay = s.run_replay(gid)
        self.assertEqual((replay["matched"], replay["total"]), (497, 500))
        self.assertEqual(replay["guard"]["keywords"], ["broken", "damaged"])
        g = s.groups[gid]
        self.assertAlmostEqual(g["summary"]["cost_after"], 60, delta=5)
        lo, hi = g["summary"]["saved_kwh"]
        self.assertAlmostEqual(lo, 40, delta=3)
        self.assertAlmostEqual(hi, 110, delta=5)

        s.decide_replay(gid, "accepted")
        record = s.accept(gid)
        self.assertGreater(record["saved_usd"], 600)
        self.assertNotIn(gid, {k for k, v in s.groups.items() if v["has_edits"]})

        bank = engine.new_project(sample="bank")
        f = next(f for f in bank.groups["bank/categorize.py::categorize_transaction"]["findings"] if f["rule"] == "model_too_big")
        self.assertEqual(f["proof"], "ledger")
        self.assertTrue(f["included"])

    def test_every_stepup_fix_passes_its_tests(self):
        s = engine.new_project(sample="stepup")
        for gid, g in list(s.groups.items()):
            if g["has_edits"] and not g["needs_replay"]:
                self.assertTrue(s.run_tests(gid)["passed"], gid)

    def test_incoming_change_needs_approval(self):
        s = engine.new_project(sample="stepup")
        inc = s.incoming()
        r = s.review_change(inc["file"], inc["code"], inc["calls_per_month"])
        self.assertTrue(r["check"]["needs_approval"])
        self.assertAlmostEqual(r["added_usd"], 1200, delta=100)


if __name__ == "__main__":
    unittest.main()
