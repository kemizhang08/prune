"""Replay proof: re-send recorded requests to the new setup and compare answers.

The hackathon build replays from seeded recordings (each recording holds the answer
the old setup gave and the answer the candidate model gave). A live backend that
re-sends requests through the team's own gateway and key plugs in behind
`ReplayBackend`; it is not configured here.
"""

import json
import re
from collections import Counter
from pathlib import Path

from . import costing

STOP = set(
    "the a an and or i i'm my me to of for is it in on at was be can you your with this that these those please "
    "what how do does did not no just are have has had but so if from out one get got want".split()
)
MAX_GUARD_SHARE = 0.25


class ReplayBackend:
    """Interface: answer(request_input, model) -> answer text."""

    def answer(self, request_input, model):
        raise NotImplementedError


class GatewayReplay(ReplayBackend):
    """Would re-send through the team's AI gateway (e.g. Chalk AI Gateway) with their key."""

    def answer(self, request_input, model):
        raise RuntimeError("No AI gateway configured. Set one up to replay live; using recordings instead.")


def load_recordings(root, function):
    path = Path(root) / "recordings" / f"{function}.jsonl"
    if not path.exists():
        return None
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _words(text):
    return {w for w in re.findall(r"[a-z']+", text.lower()) if len(w) > 2 and w not in STOP}


def suggest_guard(rows, diffs):
    """Smallest set of rare words that covers every differing request."""
    if not diffs:
        return None
    docfreq = Counter()
    for r in rows:
        docfreq.update(_words(r["input"]))
    total = len(rows)
    diff_sets = [_words(r["input"]) for r in diffs]
    candidates = {w for s in diff_sets for w in s if docfreq[w] / total <= MAX_GUARD_SHARE}
    uncovered = set(range(len(diffs)))
    chosen = []
    while uncovered and candidates:
        best = max(
            sorted(candidates),
            key=lambda w: (
                sum(1 for i in uncovered if w in diff_sets[i]),
                sum(1 for s in diff_sets if w in s),
                docfreq[w],
            ),
        )
        covered = {i for i in uncovered if best in diff_sets[i]}
        if not covered:
            break
        chosen.append(best)
        uncovered -= covered
        candidates.discard(best)
    hits = sum(1 for r in rows if _words(r["input"]) & set(chosen))
    return {"keywords": chosen, "share": round(hits / total, 4), "requests": hits,
            "covers": len(diffs) - len(uncovered), "of": len(diffs)}


def run(rows, old_model, new_model, after_profile):
    results = []
    for r in rows:
        new = r["after"].get(new_model)
        if new is None:
            raise RuntimeError(f"No recorded answer for {new_model}; a live gateway is needed to replay it.")
        results.append({"id": r["id"], "input": r["input"], "before": r["before"], "after": new, "same": new == r["before"]})
    diffs = [r for r in results if not r["same"]]
    same = [r for r in results if r["same"]]
    total, matched = len(results), len(same)
    replay_cost = costing.per_call_cost(new_model, after_profile) * total
    return {
        "old_model": old_model,
        "new_model": new_model,
        "total": total,
        "matched": matched,
        "match_rate": round(matched / total, 4) if total else 0,
        "rows": diffs + same[:37],  # most different first
        "guard": suggest_guard(results, diffs),
        "replay_cost_usd": round(replay_cost, 2),
        "source": f"{total} recorded requests from last week, names and addresses removed",
    }
