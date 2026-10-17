"""The equivalence ledger: what accepted (and rejected) replays taught Prune.

Stores only the pattern (kind of task, number of labels, which two models, the
match rate), never prompts or answers.
"""

import json
import threading
import time
from pathlib import Path

from . import catalog

_lock = threading.Lock()

TASK_NAMES = {
    "label": "Sorting short text into {n} labels",
    "number": "Pulling a number out of short text",
    "boolean": "Answering yes/no about short text",
}


class Ledger:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self._write([])

    def _read(self):
        try:
            return json.loads(self.path.read_text())
        except (OSError, json.JSONDecodeError):
            return []

    def _write(self, entries):
        self.path.write_text(json.dumps(entries, indent=2))

    def entries(self):
        return self._read()

    def reset(self):
        with _lock:
            self._write([])

    def record(self, kind, label_count, from_model, to_model, matched, total, decision):
        rate = matched / total if total else 0
        task = TASK_NAMES.get(kind, "Short-answer task").format(n=label_count)
        entry = {
            "task": task,
            "answer_kind": kind,
            "label_count": label_count,
            "from_model": from_model,
            "to_model": to_model,
            "matched": matched,
            "total": total,
            "match_rate": round(rate, 4),
            "decision": decision,
            "recorded_at": time.strftime("%Y-%m-%d %H:%M"),
            "lesson": f"{task}: the small model matched the big model {rate * 100:.1f}% of the time.",
        }
        with _lock:
            entries = self._read()
            entries.append(entry)
            self._write(entries)
        return entry

    def match(self, kind, label_count, from_model, to_model):
        """Evidence from similar accepted replays, or None."""
        def size(m):
            info = catalog.model_info(m or "")
            return info[3] if info else None

        def same_models(e):
            if (e["from_model"], e["to_model"]) == (from_model, to_model):
                return True
            return (size(e["from_model"]), size(e["to_model"])) == (size(from_model), size(to_model))

        similar = [
            e for e in self._read()
            if e["decision"] == "accepted"
            and e["answer_kind"] == kind
            and abs((e["label_count"] or 0) - (label_count or 0)) <= 2
            and same_models(e)
        ]
        rejected = [
            e for e in self._read()
            if e["decision"] == "rejected" and e["answer_kind"] == kind and (e["from_model"], e["to_model"]) == (from_model, to_model)
        ]
        if not similar:
            return None
        matched = sum(e["matched"] for e in similar)
        total = sum(e["total"] for e in similar)
        rate = matched / total
        high = rate >= 0.98 and total >= 200 and not rejected
        return {
            "entries": len(similar),
            "rejected": len(rejected),
            "matched": matched,
            "total": total,
            "match_rate": round(rate, 4),
            "confidence": "high" if high else "medium",
            "lessons": [e["lesson"] for e in similar[-3:]],
        }
