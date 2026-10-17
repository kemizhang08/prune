import unittest

from stepup import classify
from tests.fakes import FakeClient


class ClassifyTicketTest(unittest.TestCase):
    def test_known_label_passes_through(self):
        classify.client = FakeClient([" Refund\n"])
        self.assertEqual(classify.classify_ticket("I want my money back"), "refund")

    def test_unknown_label_falls_back_to_other(self):
        classify.client = FakeClient(["I think this is about a refund because..."])
        self.assertEqual(classify.classify_ticket("hello"), "other")

    def test_sends_policy_and_email(self):
        fake = FakeClient(["shipping"])
        classify.client = fake
        classify.classify_ticket("Where is my parcel?")
        messages = fake.calls[0]["messages"]
        self.assertEqual(messages[-1]["content"], "Where is my parcel?")


class ExtractOrderIdTest(unittest.TestCase):
    def test_finds_order_number(self):
        classify.client = FakeClient(["SU-482913"])
        self.assertEqual(classify.extract_order_id("Order SU-482913 never arrived"), "SU-482913")

    def test_no_order_number(self):
        classify.client = FakeClient(["NONE"])
        self.assertIsNone(classify.extract_order_id("Do you sell kids' sizes?"))
