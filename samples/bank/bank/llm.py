"""Shared AI client. Tests replace `client` with a fake."""

try:
    from openai import OpenAI

    client = OpenAI()
except Exception:
    client = None
