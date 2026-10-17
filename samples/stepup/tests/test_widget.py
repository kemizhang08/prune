import unittest

from stepup import ask_ai, reply
from tests.fakes import FakeClient


class AskAiTest(unittest.TestCase):
    def test_reply_is_trimmed_for_the_bubble(self):
        ask_ai.client = FakeClient(["x" * 2000])
        self.assertEqual(len(ask_ai.answer_question("s1", "Do you ship to Canada?")), 600)

    def test_history_grows(self):
        ask_ai.client = FakeClient(["Yes."])
        ask_ai.answer_question("s2", "Hi")
        ask_ai.answer_question("s2", "Again")
        self.assertEqual(len(ask_ai.SESSIONS["s2"]), 5)


class DraftReplyTest(unittest.TestCase):
    def test_reply_contains_summary(self):
        reply.client = FakeClient(["Customer wants a bigger size."])
        log = type("Log", (), {"info": lambda *a, **k: None})()
        self.assertIn("bigger size", reply.draft_reply("Too small!", log))
