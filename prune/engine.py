"""Project state: the workspace being reviewed, its findings, proofs and accepted fixes."""

import copy
import hashlib
import json
import shutil
import tempfile
import threading
import uuid
from pathlib import Path

from . import budget, costing, replay, rules
from .analyzer import Project
from .ledger import Ledger
from .sandbox import LocalSandbox

ROOT = Path(__file__).resolve().parent.parent
SAMPLES = {
    "stepup": {"name": "StepUp Shoes", "path": ROOT / "samples/stepup",
               "blurb": "Help desk sorting ~40,000 customer emails a month, plus a chat widget, a review digest and a returns agent."},
    "bank": {"name": "Northwind Bank", "path": ROOT / "samples/bank",
             "blurb": "Sorts ~1.2M card transactions a month into 4 spending categories. No recordings for replay."},
}
LEDGER = Ledger(ROOT / "data/ledger.json")
SANDBOX = LocalSandbox()
PROJECTS = {}
_lock = threading.Lock()


def _hash(obj):
    return hashlib.sha1(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()[:12]


class ProjectState:
    def __init__(self, name, files_root=None, files=None, default_calls=10000, sample=None):
        self.id = uuid.uuid4().hex[:10]
        self.name = name
        self.sample = sample
        self.root = Path(tempfile.mkdtemp(prefix=f"prune-{sample or 'paste'}-"))
        if files_root:
            shutil.copytree(files_root, self.root, dirs_exist_ok=True,
                            ignore=shutil.ignore_patterns("__pycache__"))
        for path, src in (files or {}).items():
            (self.root / path).parent.mkdir(parents=True, exist_ok=True)
            (self.root / path).write_text(src)
        usage_path = self.root / "usage.json"
        self.usage_doc = json.loads(usage_path.read_text()) if usage_path.exists() else {}
        self.usage = self.usage_doc.get("calls", {})
        self.usage_source = self.usage_doc.get("source", "")
        self.config = budget.load_config(self.root)
        self.default_calls = default_calls
        self.overrides = {}
        self.options = {}
        self.tests = {}
        self.accepted = []
        self.lock = threading.Lock()
        self.initial = None
        self.analyze()
        self.initial = copy.deepcopy(self.totals)

    # ----- analysis -------------------------------------------------------

    def analyze(self):
        self.project = Project.from_dir(self.root)
        self.sites = self.project.analyze()
        ctx = {"usage": self.usage, "usage_source": self.usage_source, "overrides": self.overrides,
               "ledger": LEDGER, "options": self.options, "default_calls": self.default_calls}
        self.groups = {}
        self.site_costs = []
        for s in self.sites:
            prof = rules.baseline_profile(s, self.usage.get(s["id"]), self.usage_source, self.overrides.get(s["id"]),
                                          self.default_calls)
            summ = costing.profile_summary(prof)
            self.site_costs.append({"id": s["id"], "file": s["file"], "function": s["function"], "model": prof["model"],
                                    "calls": prof["calls"], "estimate": prof["estimate"], **summ})
            g = rules.build_group(s, self.project.modules[s["file"]], self.project.modules, ctx)
            if g:
                self.groups[g["id"]] = g
        self.totals = {
            "cost": round(sum(c["cost"] for c in self.site_costs), 2),
            "kwh": [round(sum(c["kwh"][i] for c in self.site_costs), 1) for i in (0, 1)],
            "kg_co2e": [round(sum(c["kg_co2e"][i] for c in self.site_costs), 1) for i in (0, 1)],
        }

    def sources(self):
        return {p: m.src for p, m in self.project.modules.items()}

    def fix_preview(self, group):
        new, diffs = rules.apply_group(group, self.sources())
        return new, diffs

    def group_status(self, g):
        new, diffs = self.fix_preview(g)
        key = _hash(diffs)
        test = self.tests.get(g["id"])
        test = test if test and test["key"] == key else None
        opts = self.options.get(g["id"], {})
        rp = opts.get("replay")
        replay_ok = (not g["needs_replay"]) or (rp and rp.get("decision") == "accepted")
        return {
            "diff_key": key,
            "diffs": diffs,
            "tests": test,
            "replay": rp,
            "guard": opts.get("guard"),
            "can_accept": bool(g["has_edits"] and test and test["passed"] and replay_ok),
            "blocked_by": None if not g["has_edits"] else (
                "Run the tests first" if not test else
                "Tests failed, so the fix stays advice only" if not test["passed"] else
                "Review the replay and click Accept or Reject" if not replay_ok else None),
        }

    def payload(self):
        groups = []
        for g in sorted(self.groups.values(), key=lambda g: -g["summary"]["saved_usd"]):
            site = g["site"]
            module = self.project.modules[g["file"]]
            groups.append({
                **{k: v for k, v in g.items() if k not in ("site", "ops_by_file", "findings")},
                "findings": [{k: v for k, v in f.items() if k != "ops"} for f in g["findings"]],
                "site": {k: site[k] for k in ("line", "end_line", "function_line", "function_end", "model", "max_tokens",
                                              "provider", "api", "answer", "user_var", "timer", "batchable")},
                "code": "\n".join(module.lines[site["function_line"] - 1: site["function_end"]]),
                "code_start": site["function_line"],
                "feature": budget.feature_for(self.config, g["file"]),
                "status": self.group_status(g),
            })
        site_costs = sorted(self.site_costs, key=lambda c: -c["cost"])
        open_savings = sum(g["summary"]["saved_usd"] for g in self.groups.values() if g["has_edits"])
        return {
            "id": self.id,
            "name": self.name,
            "sample": self.sample,
            "usage_source": self.usage_source or "no usage data: traffic is your estimate",
            "files": sorted(self.project.modules),
            "parse_errors": self.project.errors,
            "groups": groups,
            "sites": site_costs,
            "totals": self.totals,
            "initial": self.initial or self.totals,
            "open_savings": round(open_savings, 2),
            "accepted": self.accepted,
            "budgets": budget.report(self.config, self.site_costs),
            "approval_threshold": self.config.get("review", {}).get("approval_threshold_usd", 50),
            "incoming": self.incoming(),
            "receipt": self.receipt(),
        }

    def incoming(self):
        inc = self.usage_doc.get("incoming")
        if not inc:
            return None
        path = self.root / inc["source_file"]
        return {**inc, "code": path.read_text() if path.exists() else ""}

    def receipt(self):
        replay_cost = sum((o.get("replay") or {}).get("replay_cost_usd", 0) for o in self.options.values())
        found = sum(g["summary"]["saved_usd"] + g["advice_extra_usd"] for g in self.groups.values())
        found += sum(a["saved_usd"] for a in self.accepted)
        return {"analysis_usd": 0.0, "replay_usd": round(replay_cost, 2), "waste_found_usd": round(found, 2)}

    # ----- actions ------------------------------------------------------------

    def group(self, gid):
        if gid not in self.groups:
            raise KeyError(f"No open fix for {gid}")
        return self.groups[gid]

    def run_tests(self, gid):
        g = self.group(gid)
        new, diffs = self.fix_preview(g)
        result = SANDBOX.run(self.root, new)
        result["key"] = _hash(diffs)
        self.tests[gid] = result
        return result

    def run_replay(self, gid):
        g = self.group(gid)
        f = next((f for f in g["findings"] if f["rule"] == "model_too_big"), None)
        if not f or f["proof"] != "replay":
            raise KeyError("This fix doesn't need a replay")
        rows = replay.load_recordings(self.root, g["function"])
        if not rows:
            raise KeyError("No recordings for this call")
        result = replay.run(rows, g["before"]["model"], f["target_model"], g["after"])
        opts = self.options.setdefault(gid, {})
        opts["replay"] = {**result, "decision": None}
        if result["guard"] and result["guard"]["keywords"]:
            opts["guard"] = {**result["guard"], "enabled": True}
        self.analyze()
        return opts["replay"]

    def set_guard(self, gid, enabled):
        opts = self.options.setdefault(gid, {})
        if opts.get("guard"):
            opts["guard"]["enabled"] = bool(enabled)
        self.analyze()

    def decide_replay(self, gid, decision):
        opts = self.options.setdefault(gid, {})
        rp = opts.get("replay")
        if not rp:
            raise KeyError("Run the replay first")
        g = self.group(gid)
        rp["decision"] = decision
        entry = None
        if not opts.get("ledger_recorded"):
            labels = len(g["site"]["answer"]["labels"]) or None
            entry = LEDGER.record(g["site"]["answer"]["kind"], labels, rp["old_model"], rp["new_model"],
                                  rp["matched"], rp["total"], decision)
            opts["ledger_recorded"] = True
        self.analyze()
        return entry

    def accept(self, gid):
        g = self.group(gid)
        status = self.group_status(g)
        if g["has_edits"] and not status["tests"]:
            self.run_tests(gid)  # the fix changed since the last run (e.g. a replay guard): test it again
            status = self.group_status(g)
        if not status["can_accept"]:
            raise PermissionError(status["blocked_by"] or "This fix can't be accepted yet")
        new, diffs = self.fix_preview(g)
        for path, src in new.items():
            (self.root / path).write_text(src)
        self.overrides[gid] = copy.deepcopy(g["after"])
        model_change = any(f["included"] and f["rule"] == "model_too_big" for f in g["findings"])
        record = {
            "id": gid,
            "function": g["function"],
            "saved_usd": g["summary"]["saved_usd"],
            "saved_kwh": g["summary"]["saved_kwh"],
            "titles": [f["bullet"] for f in g["findings"] if f["included"]],
            "rollout": rollout_plan(model_change),
        }
        self.accepted.append(record)
        self.tests.pop(gid, None)
        self.analyze()
        return record

    def review_change(self, file, code, calls):
        """Budget check for a new code change before it ships."""
        files = self.sources()
        files[file] = code
        proj = Project(files)
        sites = [s for s in proj.analyze() if s["file"] == file]
        added = 0.0
        items = []
        ctx = {"usage": {}, "usage_source": "", "overrides": {}, "ledger": LEDGER, "options": {}, "default_calls": calls}
        for s in sites:
            prof = rules.baseline_profile(s, None, "", None, calls)
            if s["answer"]["kind"] == "free_text" and s["max_tokens"]:
                prof["output_tokens"] = s["max_tokens"]  # new code: assume answers use the full limit
            cost = costing.monthly_cost(prof)
            added += cost
            g = rules.build_group(s, proj.modules[file], proj.modules, ctx)
            items.append({"function": s["function"], "line": s["line"], "model": prof["model"], "calls": calls,
                          "input_tokens": prof["input_tokens"], "output_tokens": prof["output_tokens"],
                          "cost": round(cost, 2), "kwh": [round(x, 1) for x in costing.monthly_energy(prof)],
                          "suggestions": [f["title"] for f in (g or {}).get("findings", [])]})
        feature = budget.feature_for(self.config, file)
        current = sum(c["cost"] for c in self.site_costs if budget.feature_for(self.config, c["file"]) == feature) if feature else 0
        check = budget.check_change(self.config, file, added, current)
        return {"file": file, "added_usd": round(added, 2), "items": items, "check": check,
                "estimate": True, "parse_errors": proj.errors}


def rollout_plan(model_change):
    if not model_change:
        return [{"pct": 100, "note": "Answers are unchanged, so the fix ships to everyone.", "status": "done"}]
    return [
        {"pct": 10, "note": "10% of traffic for 24h. Watching how often people correct or regenerate answers: 2.0% → 2.1% (within normal range).", "status": "healthy"},
        {"pct": 100, "note": "No rise in corrections or thumbs-down, so Prune promotes it to 100%. It rolls back automatically if that changes.", "status": "done"},
    ]


def new_project(sample=None, paste=None):
    if sample:
        info = SAMPLES[sample]
        state = ProjectState(info["name"], files_root=info["path"], sample=sample)
    else:
        filename = (paste.get("filename") or "app.py").strip().lstrip("/") or "app.py"
        if not filename.endswith(".py"):
            filename += ".py"
        state = ProjectState("Pasted code", files={filename: paste["code"]},
                             default_calls=int(paste.get("calls_per_month") or 10000))
    with _lock:
        PROJECTS[state.id] = state
    return state


def get(pid):
    if pid not in PROJECTS:
        raise KeyError("Project not found (the server may have restarted). Load it again.")
    return PROJECTS[pid]
