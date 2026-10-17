import unittest

from stepup import nightly_digest, returns_agent, reviews
from tests.fakes import FakeClient


class DigestTest(unittest.TestCase):
    def test_digest_summarizes_each_review(self):
        nightly_digest.client = FakeClient(["Great fit."])
        reviews._REVIEWS[:] = ["Love these!", "Runs small."]
        nightly_digest.run_digest()
        self.assertEqual(reviews._DIGESTS[-1], ["Great fit.", "Great fit."])


class ReturnsAgentTest(unittest.TestCase):
    def test_agent_uses_tool_then_answers(self):
        returns_agent.client = FakeClient([
            {"tool": "lookup_order", "args": '{"order_id": "SU-1"}'},
            "Your return label is on its way.",
        ])
        self.assertEqual(returns_agent.run_returns_agent("Return SU-1"), "Your return label is on its way.")

    def test_agent_recovers_from_one_error(self):
        returns_agent.client = FakeClient([RuntimeError("rate limited"), "Done."])
        self.assertEqual(returns_agent.run_returns_agent("Return SU-2"), "Done.")
