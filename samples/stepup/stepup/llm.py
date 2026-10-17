"""Shared AI client. Tests replace `client` with a fake, so no network is needed."""

try:
    from openai import OpenAI

    client = OpenAI()
except Exception:  # openai not installed or no API key (e.g. in tests)
    client = None
