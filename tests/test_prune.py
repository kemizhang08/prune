"""Regression tests: the StepUp walkthrough numbers, the ledger beat, budgets, and linked-repo safety."""

import json
import tempfile
import unittest
from pathlib import Path

from prune import engine, fetch
from prune.analyzer import Project
from prune.ledger import Ledger
from prune.store import BudgetStore


def isolate():
    d = Path(tempfile.mkdtemp())
    engine.LEDGER = Ledger(d / "ledger.json")
    engine.BUDGETS = BudgetStore(d / "budgets.json")
    return d


class StepUpFlowTest(unittest.TestCase):
    def setUp(self):
        isolate()

    def test_classify_ticket_end_to_end(self):
        s = engine.new_project(sample="stepup")
        gid = "stepup/classify.py::classify_ticket"
        g = s.groups[gid]
        self.assertEqual(g["site"]["answer"]["labels"], ["refund", "shipping", "other"])
        self.assertEqual(g["before"]["calls"], 40000)
        self.assertAlmostEqual(g["summary"]["cost_before"], 700, delta=1)
        badges = {f["rule"]: f["badge"]["label"] for f in g["findings"]}
        self.assertEqual(badges, {"model_too_big": "Check pending", "max_tokens_high": "Same answer", "uncached_prompt": "Same answer"})
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
        self.assertEqual(next(f for f in s.groups[gid]["findings"] if f["rule"] == "model_too_big")["badge"]["detail"], "497/500")
        record = s.accept(gid)
        self.assertGreater(record["saved_usd"], 600)
        r = record["receipt"]
        self.assertAlmostEqual(r["net_usd"], r["saved_usd"] - r["review_cost_usd"], places=2)
        self.assertGreater(r["review_wh"][0], 0)
        self.assertEqual(r["tests"], "passed")
        self.assertNotIn(gid, {k for k, v in s.groups.items() if v["has_edits"]})
        energy = s.payload()["energy"]
        self.assertTrue(energy["done"])
        self.assertEqual([x["label"] for x in energy["steps"]][:2], ["Before Prune", "classify_ticket"])
        self.assertEqual(energy["top"][0]["name"], "classify_ticket")

        bank = engine.new_project(sample="bank")
        f = next(f for f in bank.groups["bank/categorize.py::categorize_transaction"]["findings"] if f["rule"] == "model_too_big")
        self.assertEqual(f["proof"], "ledger")
        self.assertEqual(f["badge"]["label"], "Checked")

    def test_every_stepup_fix_passes_its_tests(self):
        s = engine.new_project(sample="stepup")
        for gid, g in list(s.groups.items()):
            if g["has_edits"] and not g["needs_replay"]:
                self.assertTrue(s.run_tests(gid)["passed"], gid)


class BudgetTest(unittest.TestCase):
    def setUp(self):
        isolate()

    def test_waiting_change_is_flagged(self):
        w = engine.new_project(sample="stepup").payload()["budget"]["waiting"]
        self.assertTrue(w["flagged"])
        self.assertAlmostEqual(w["added_usd"], 1200, delta=100)
        self.assertEqual({r["kind"] for r in w["reasons"]}, {"threshold", "feature"})

    def test_settings_survive_a_reload(self):
        s = engine.new_project(sample="stepup")
        s.set_limit("storefront", 5000)
        s.set_threshold(2000)
        s.add_limit("Search suggestions", 80)
        s.decide_change("sent back")
        b = engine.new_project(sample="stepup").payload()["budget"]
        self.assertEqual(b["threshold"], 2000)
        self.assertEqual(next(r for r in b["rows"] if r["key"] == "storefront")["limit"], 5000)
        self.assertTrue(any(r["key"] == "Search suggestions" for r in b["rows"]))
        self.assertFalse(b["waiting"]["flagged"])
        self.assertEqual(b["waiting"]["decision"], "sent back")


class LinkTest(unittest.TestCase):
    def setUp(self):
        isolate()

    def test_only_github_https_links(self):
        ok = fetch.parse_github_url("https://github.com/psf/requests")
        self.assertEqual((ok["owner"], ok["repo"], ok["kind"]), ("psf", "requests", "repo"))
        f = fetch.parse_github_url("https://github.com/a/b/blob/main/src/app.py")
        self.assertEqual((f["kind"], f["ref"], f["path"]), ("file", "main", "src/app.py"))
        for bad in ["http://github.com/a/b", "https://gitlab.com/a/b", "https://github.com/a",
                    "https://github.com/a/b/blob/main/x.js", "https://github.com/a/b/tree/main/../etc", "file:///etc/passwd"]:
            with self.assertRaises(fetch.FetchError, msg=bad):
                fetch.parse_github_url(bad)

    def test_archive_paths_cannot_escape(self):
        self.assertIsNone(fetch._safe_rel("repo-sha/../../etc/passwd", ""))
        self.assertIsNone(fetch._safe_rel("repo-sha/.git/hooks/x.py", ""))
        self.assertIsNone(fetch._safe_rel("repo-sha/src/app.py", "docs"))
        self.assertEqual(str(fetch._safe_rel("repo-sha/src/app.py", "src")), "src/app.py")

    def test_linked_code_is_never_run(self):
        d = Path(tempfile.mkdtemp())
        marker = d / "ran.txt"
        (d / "src").mkdir()
        (d / "src" / "app.py").write_text(
            f"open({str(marker)!r}, 'w').write('ran')\n"
            "from openai import OpenAI\nclient = OpenAI()\n\n"
            "def is_spam(text):\n"
            "    r = client.chat.completions.create(model='gpt-4o', messages=[{'role': 'user', 'content': text}])\n"
            "    return r.choices[0].message.content.strip() in ('yes', 'no')\n")
        (d / "src" / "tests").mkdir()
        (d / "src" / "tests" / "test_x.py").write_text(f"open({str(marker)!r}, 'w').write('ran')\n")
        s = engine._register(engine.ProjectState("x/y", "repo", "repo:x/y", files_root=d / "src", source={"kind": "repo"}))
        p = s.payload()
        self.assertEqual(len(p["sites"]), 1)
        g = p["groups"][0]
        self.assertTrue(g["status"]["tests"]["skipped"])
        with self.assertRaises(PermissionError):
            s.run_tests(g["id"])
        with self.assertRaises(PermissionError):
            s.run_replay(g["id"])
        if g["status"]["can_accept"]:
            s.accept(g["id"])
        self.assertFalse(marker.exists(), "downloaded code must never run")

    def test_notebooks_and_repeated_calls(self):
        nb = {"cells": [{"cell_type": "code", "source": ["!pip install openai\n", "from openai import OpenAI\n", "c = OpenAI()\n"]},
                        {"cell_type": "markdown", "source": ["hi"]},
                        {"cell_type": "code", "source": "def f(q):\n    a = c.chat.completions.create(model='gpt-4o', messages=[])\n"
                                                         "    b = c.chat.completions.create(model='gpt-4o', messages=[])\n    return a, b\n"}]}
        d = Path(tempfile.mkdtemp())
        (d / "demo.ipynb").write_text(json.dumps(nb))
        sites = Project.from_dir(d).analyze()
        self.assertEqual(len({s["id"] for s in sites}), 2)


if __name__ == "__main__":
    unittest.main()
