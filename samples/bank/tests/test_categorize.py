import unittest
from types import SimpleNamespace as NS

from bank import categorize


class Fake:
    def __init__(self, text):
        self.chat = NS(completions=NS(create=lambda **kw: NS(choices=[NS(message=NS(content=text))])))


class CategorizeTest(unittest.TestCase):
    def test_known_category(self):
        categorize.client = Fake("Groceries")
        self.assertEqual(categorize.categorize_transaction("WHOLE FOODS #123", 54.2), "groceries")

    def test_unknown_category(self):
        categorize.client = Fake("Probably entertainment")
        self.assertEqual(categorize.categorize_transaction("CINEMA", 12.0), "other")
