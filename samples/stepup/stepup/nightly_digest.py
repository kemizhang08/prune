"""Summarize product reviews for the merchandising dashboard."""

import time

from stepup import reviews
from stepup.llm import client


def summarize_review(text):
    resp = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=300,
        messages=[{"role": "user", "content": "Summarize this product review in one sentence:\n" + text}],
    )
    return resp.choices[0].message.content


def run_digest():
    recent = reviews.fetch_recent(hours=24)
    summaries = []
    for review in recent:
        summaries.append(summarize_review(review))
    reviews.save_digest(summaries)


def main():
    while True:
        run_digest()
        time.sleep(600)  # refresh every 10 minutes
