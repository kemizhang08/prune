"""Budget settings that outlive a page reload: per-feature limits, added limits, the
per-change approval threshold and decisions on waiting changes. One JSON file, keyed by
project (a sample's name or a repo URL)."""

import json
import threading
from pathlib import Path

_lock = threading.Lock()


class BudgetStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _read(self):
        try:
            return json.loads(self.path.read_text())
        except (OSError, json.JSONDecodeError):
            return {}

    def get(self, key):
        d = self._read().get(key, {})
        return {"limits": d.get("limits", {}), "added": d.get("added", {}),
                "threshold": d.get("threshold"), "decisions": d.get("decisions", {})}

    def update(self, key, fn):
        """Apply fn(settings) to one project's settings and save."""
        with _lock:
            data = self._read()
            cur = {"limits": {}, "added": {}, "threshold": None, "decisions": {}}
            cur.update(data.get(key, {}))
            fn(cur)
            data[key] = cur
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=2))
            tmp.replace(self.path)
            return cur

    def reset(self, key):
        with _lock:
            data = self._read()
            data.pop(key, None)
            self.path.write_text(json.dumps(data, indent=2))
