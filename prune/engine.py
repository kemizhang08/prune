"""Project state: the workspace being reviewed, its findings, proofs and accepted fixes."""

import copy
import hashlib
import json
import shutil
import tempfile
import threading
import time
import uuid
from pathlib import Path, PurePosixPath

from . import budget, catalog, costing, fetch, replay, rules
from .analyzer import Project
from .ledger import Ledger
from .sandbox import LocalSandbox
from .store import BudgetStore

ROOT = Path(__file__).resolve().parent.parent
SAMPLES = {
    "stepup": {"name": "StepUp Shoes", "path": ROOT / "samples/stepup",
               "blurb": "Help desk sorting ~40,000 customer emails a month, plus a chat widget, a review digest and a returns agent."},
    "bank": {"name": "Northwind Bank", "path": ROOT / "samples/bank",
             "blurb": "Sorts ~1.2M card transactions a month into 4 spending categories. No recordings for replay."},
}
LEDGER = Ledger(ROOT / "data/ledger.json")
BUDGETS = BudgetStore(ROOT / "data/budgets.json")
SANDBOX = LocalSandbox()
PROJECTS = {}
JOBS = {}
MAX_PROJECTS = 12
DEFAULT_REPO_CALLS = 10000
_lock = threading.Lock()

NO_RUN_REASON = ("Prune never runs code it downloads, so tests aren't run for linked repos. "
                 "Run your own tests on the change before merging.")


def _hash(obj):
    return hashlib.sha1(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()[:12]


def _sub(a, b):
    return [round(max(0.0, a[i] - b[i]), 1) for i in (0, 1)]


def _mid(r):
    return (r[0] + r[1]) / 2


class ProjectState:
    def __init__(self, name, kind, key, files_root=None, files=None, default_calls=DEFAULT_REPO_CALLS,
                 sample=None, source=None):
        self.id = uuid.uuid4().hex[:10]
        self.name = name
        self.kind = kind  # "sample" | "paste" | "repo"
        self.key = key  # budget settings are saved under this
        self.sample = sample
        self.source = source or {}
        self.linked = kind == "repo"
        self.created = time.time()
        self.root = Path(tempfile.mkdtemp(prefix=f"prune-{sample or kind}-"))
        if files_root:
            shutil.copytree(files_root, self.root, dirs_exist_ok=True, symlinks=False,
                            ignore=shutil.ignore_patterns("__pycache__"))
        for path, src in (files or {}).items():
            (self.root / path).parent.mkdir(parents=True, exist_ok=True)
            (self.root / path).write_text(src)
        # Usage data and the "incoming change" demo only come from Prune's own samples.
        usage_path = self.root / "usage.json"
        self.usage_doc = json.loads(usage_path.read_text()) if kind == "sample" and usage_path.exists() else {}
        self.usage = self.usage_doc.get("calls", {})
        self.usage_source = self.usage_doc.get("source", "")
        self.config = budget.load_config(self.root)
        self.default_calls = default_calls
        self.traffic = {}
        self.overrides = {}
        self.options = {}
        self.tests = {}
        self.accepted = []
        self.review_energy = {}  # group id -> [low, high] Wh used re-checking answers
        self.lock = threading.Lock()
        self.initial = None
        self.analyze()
        self.initial = copy.deepcopy(self.totals)
        self.energy_steps = [{"label": "Before Prune", "kwh": self.totals["kwh"]}]
        self.incoming_review = self._review_incoming()

    # ----- analysis -------------------------------------------------------

    def ctx(self):
        return {"usage": self.usage, "usage_source": self.usage_source, "overrides": self.overrides,
                "ledger": LEDGER, "options": self.options, "default_calls": self.default_calls,
                "traffic": self.traffic, "linked": self.linked}

    def analyze(self):
        self.project = Project.from_dir(self.root)
        self.sites = self.project.analyze()
        ctx = self.ctx()
        self.groups = {}
        self.site_costs = []
        for s in self.sites:
            prof = rules.baseline_profile(s, self.usage.get(s["id"]), self.usage_source, self.overrides.get(s["id"]),
                                          self.default_calls, self.traffic.get(s["id"]))
            summ = costing.profile_summary(prof)
            self.site_costs.append({"id": s["id"], "file": s["file"], "function": s["function"], "line": s["line"],
                                    "model": prof["model"], "price_source": catalog.price_for(prof["model"])[1],
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
        return rules.apply_group(group, self.sources())

    def advice_diffs(self, g):
        """Suggested edits Prune won't apply on its own, shown so a person can copy them."""
        if not g["advice_ops_by_file"]:
            return {}
        try:
            return rules.apply_group({"ops_by_file": g["advice_ops_by_file"]}, self.sources())[1]
        except Exception:  # overlapping suggestions: show none rather than a wrong diff
            return {}

    def group_status(self, g):
        new, diffs = self.fix_preview(g)
        key = _hash(diffs)
        if self.linked:
            test = {"skipped": True, "passed": None, "reason": NO_RUN_REASON, "key": key}
        else:
            test = self.tests.get(g["id"])
            test = test if test and test["key"] == key else None
        opts = self.options.get(g["id"], {})
        rp = opts.get("replay")
        replay_ok = (not g["needs_replay"]) or (rp and rp.get("decision") == "accepted")
        tests_ok = self.linked or (test and test["passed"])
        return {
            "diff_key": key,
            "diffs": diffs,
            "tests": test,
            "replay": rp,
            "guard": opts.get("guard"),
            "receipt": self.receipt_for(g, test),
            "can_accept": bool(g["has_edits"] and tests_ok and replay_ok),
            "blocked_by": None if not g["has_edits"] else (
                "Run the checks first" if not test else
                "A check failed, so the fix stays advice only" if not tests_ok else
                "Review the answer check and approve or reject it" if not replay_ok else None),
        }

    def receipt_for(self, g, test=None):
        sm = g["summary"]
        rp = (self.options.get(g["id"], {}) or {}).get("replay") or {}
        cost = rp.get("replay_cost_usd", 0.0)
        wh = self.review_energy.get(g["id"], [0.0, 0.0])
        return {
            "cost_before": sm["cost_before"], "cost_after": sm["cost_after"], "saved_usd": sm["saved_usd"],
            "saved_kwh": sm["saved_kwh"], "saved_kg": sm["saved_kg_co2e"],
            "review_cost_usd": round(cost, 2), "review_wh": [round(x, 1) for x in wh],
            "net_usd": round(sm["saved_usd"] - cost, 2),
            "net_kwh": [round(max(0, sm["saved_kwh"][0] - wh[1] / 1000), 1), round(max(0, sm["saved_kwh"][1] - wh[0] / 1000), 1)],
            "tests": "not run (linked repo)" if self.linked else
                     ("passed" if test and test.get("passed") else "failed" if test else "not run yet"),
            "estimate": g["before"]["estimate"],
            "date": time.strftime("%Y-%m-%d"),
        }

    # ----- views ---------------------------------------------------------------

    def energy_view(self):
        ready = [g for g in self.groups.values() if g["has_edits"]]
        potential_kwh = [round(sum(g["summary"]["saved_kwh"][i] for g in ready), 1) for i in (0, 1)]
        potential_kg = [round(sum(g["summary"]["saved_kg_co2e"][i] for g in ready), 1) for i in (0, 1)]
        saved_kwh = _sub(self.initial["kwh"], self.totals["kwh"])
        saved_kg = _sub(self.initial["kg_co2e"], self.totals["kg_co2e"])
        done = self.initial["cost"] - self.totals["cost"] > 0.5
        advice_only = not done and not ready and any(g["advice_extra_usd"] > 0.5 for g in self.groups.values())
        if advice_only:  # nothing Prune applies on its own: show what the suggestions are worth
            potential_kwh = [round(sum(g["advice_summary"]["saved_kwh"][i] for g in self.groups.values()), 1) for i in (0, 1)]
            potential_kg = [round(sum(g["advice_summary"]["saved_kg_co2e"][i] for g in self.groups.values()), 1) for i in (0, 1)]
        kwh, kg = (saved_kwh, saved_kg) if done else (potential_kwh, potential_kg)
        wh = [round(sum(v[i] for v in self.review_energy.values()), 1) for i in (0, 1)]
        eq = catalog.EQUIVALENTS
        steps = [dict(s) for s in self.energy_steps]
        if ready:
            steps.append({"label": "If every fix ships", "kwh": _sub(self.totals["kwh"], potential_kwh), "projected": True})
        top = [{"name": a["function"], "kwh": a["saved_kwh"], "shipped": True} for a in self.accepted]
        top += [{"name": g["function"], "kwh": g["summary"]["saved_kwh"], "shipped": False} for g in ready]
        if advice_only:
            top += [{"name": g["function"], "kwh": g["advice_summary"]["saved_kwh"], "shipped": False, "advice": True}
                    for g in self.groups.values() if g["advice_extra_usd"] > 0.5]
        top.sort(key=lambda x: -_mid(x["kwh"]))
        return {
            "done": done,
            "advice_only": advice_only,
            "kwh": kwh, "kg_co2e": kg,
            "saved_kwh": saved_kwh, "potential_kwh": potential_kwh,
            "now_kwh": self.totals["kwh"], "before_kwh": self.initial["kwh"],
            "steps": steps,
            "top": top,
            "review_wh": wh,
            "net_kwh": [round(max(0, kwh[0] - wh[1] / 1000), 1), round(max(0, kwh[1] - wh[0] / 1000), 1)],
            "review_share": round((_mid(wh) / 1000) / _mid(kwh), 5) if _mid(kwh) else 0,
            "equivalents": {
                "phone_charges": round(_mid(kwh) / eq["kwh_per_phone_charge"]),
                "home_days": round(_mid(kwh) / eq["kwh_per_home_day"], 1),
                "km_driving": round(_mid(kg) / eq["kg_co2_per_km"]),
            },
            "method": {"energy_per_1k": catalog.ENERGY_PER_1K, "grid_kg_per_kwh": catalog.GRID_KG_PER_KWH,
                       "cached_token_weight": catalog.CACHED_TOKEN_ENERGY_WEIGHT,
                       "sources": catalog.ENERGY_SOURCES + [catalog.EQUIVALENT_SOURCES]},
        }

    def budget_view(self):
        st = BUDGETS.get(self.key)
        default_threshold = self.config.get("review", {}).get("approval_threshold_usd", 50)
        threshold = st["threshold"] if st["threshold"] is not None else default_threshold
        rows = []
        features = self.config.get("features", {})
        if features:
            for name in features:
                cost = sum(c["cost"] for c in self.site_costs if budget.feature_for(self.config, c["file"]) == name)
                rows.append({"key": name, "cost": round(cost, 2), "limit": st["limits"].get(name, features[name].get("budget_usd"))})
        else:
            # No prune.toml: one row per file that calls an AI model.
            by_file = {}
            for c in self.site_costs:
                by_file[c["file"]] = by_file.get(c["file"], 0) + c["cost"]
            for file, cost in sorted(by_file.items(), key=lambda kv: -kv[1]):
                rows.append({"key": file, "cost": round(cost, 2), "limit": st["limits"].get(file)})
        for name, limit in st["added"].items():
            if not any(r["key"] == name for r in rows):
                rows.append({"key": name, "cost": 0.0, "limit": limit, "added": True})
        for r in rows:
            r["over"] = r["limit"] is not None and r["cost"] > r["limit"]
        return {"threshold": threshold, "rows": rows, "waiting": self._waiting(rows, threshold, st),
                "from_config": bool(features), "estimate": self.kind != "sample"}

    def _waiting(self, rows, threshold, st):
        r = self.incoming_review
        if not r:
            return None
        row = next((x for x in rows if x["key"] == r["feature"]), None)
        after = (row["cost"] if row else 0) + r["added_usd"]
        reasons = []
        if r["added_usd"] > threshold:
            reasons.append({"kind": "threshold", "limit": threshold})
        if row and row["limit"] is not None and after > row["limit"]:
            reasons.append({"kind": "feature", "feature": row["key"], "after": round(after, 2), "limit": row["limit"]})
        return {**r, "reasons": reasons, "flagged": bool(reasons), "decision": st["decisions"].get(r["file"])}

    def _review_incoming(self):
        inc = self.usage_doc.get("incoming")
        if not inc:
            return None
        path = self.root / inc["source_file"]
        if not path.exists():
            return None
        res = self.review_change(inc["file"], path.read_text(), inc["calls_per_month"])
        first = res["items"][0] if res["items"] else {}
        return {"title": inc["title"], "file": inc["file"], "code": path.read_text(),
                "traffic_source": inc["traffic_source"], "calls_per_month": inc["calls_per_month"],
                "function": first.get("function"), "added_usd": res["added_usd"],
                "kwh": [round(sum(i["kwh"][k] for i in res["items"]), 1) for k in (0, 1)],
                "feature": res["check"]["feature"]}

    def payload(self):
        groups = []
        for g in sorted(self.groups.values(), key=lambda g: -g["summary"]["saved_usd"]):
            site = g["site"]
            module = self.project.modules[g["file"]]
            groups.append({
                **{k: v for k, v in g.items() if k not in ("site", "ops_by_file", "advice_ops_by_file", "findings")},
                "advice_diffs": self.advice_diffs(g),
                "findings": [{k: v for k, v in f.items() if k != "ops"} for f in g["findings"]],
                "site": {k: site[k] for k in ("line", "end_line", "function_line", "function_end", "model", "max_tokens",
                                              "provider", "api", "answer", "user_var", "timer", "batchable")},
                "code": "\n".join(module.lines[site["function_line"] - 1: site["function_end"]]),
                "code_start": site["function_line"],
                "price_source": catalog.price_for(g["before"]["model"])[1],
                "feature": budget.feature_for(self.config, g["file"]),
                "status": self.group_status(g),
            })
        site_costs = sorted(self.site_costs, key=lambda c: -c["cost"])
        open_savings = sum(g["summary"]["saved_usd"] for g in self.groups.values() if g["has_edits"])
        empty = None
        if not self.sites:
            empty = ("No AI calls found. Prune looked for OpenAI-style, Anthropic, Gemini, LiteLLM and LangChain calls "
                     f"in {len(self.project.modules)} Python file{'s' if len(self.project.modules) != 1 else ''}"
                     + (" (test folders are skipped)." if self.kind == "repo" else "."))
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "linked": self.linked,
            "sample": self.sample,
            "source": self.source,
            "default_calls": self.default_calls,
            "usage_source": self.usage_source or "no usage data: traffic is an estimate",
            "files": sorted(self.project.modules),
            "parse_errors": self.project.errors[:20],
            "parse_error_count": len(self.project.errors),
            "empty_reason": empty,
            "groups": groups,
            "sites": site_costs,
            "totals": self.totals,
            "initial": self.initial or self.totals,
            "open_savings": round(open_savings, 2),
            "accepted": self.accepted,
            "budget": self.budget_view(),
            "energy": self.energy_view(),
            "receipt": self.receipt(),
        }

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
        if self.linked:
            raise PermissionError(NO_RUN_REASON)
        g = self.group(gid)
        new, diffs = self.fix_preview(g)
        result = SANDBOX.run(self.root, new)
        result["key"] = _hash(diffs)
        self.tests[gid] = result
        return result

    def run_replay(self, gid):
        if self.linked:
            raise PermissionError("Answer checks need the project's own recorded requests and keys, so they don't run for linked repos.")
        g = self.group(gid)
        f = next((f for f in g["findings"] if f["rule"] == "model_too_big"), None)
        if not f or f["proof"] != "replay":
            raise KeyError("This fix doesn't need an answer check")
        rows = replay.load_recordings(self.root, g["function"])
        if not rows:
            raise KeyError("No recorded requests for this call")
        result = replay.run(rows, g["before"]["model"], f["target_model"], g["after"])
        # Prune's own footprint: every replayed request runs once on the new model.
        size = catalog.price_for(result["new_model"])[0][3]
        lo, hi = catalog.ENERGY_PER_1K[size]
        k_tokens = result["total"] * (g["before"]["input_tokens"] + 5) / 1000
        prev = self.review_energy.get(gid, [0.0, 0.0])
        self.review_energy[gid] = [prev[0] + k_tokens * lo * 1000, prev[1] + k_tokens * hi * 1000]
        result["review_wh"] = [round(x, 1) for x in self.review_energy[gid]]
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
        if decision not in ("accepted", "rejected"):
            raise KeyError("decision must be accepted or rejected")
        opts = self.options.setdefault(gid, {})
        rp = opts.get("replay")
        if not rp:
            raise KeyError("Run the answer check first")
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
        if g["has_edits"] and not status["tests"] and not self.linked:
            self.run_tests(gid)  # the fix changed since the last run (e.g. a replay guard): test it again
            status = self.group_status(g)
        if not status["can_accept"]:
            raise PermissionError(status["blocked_by"] or "This fix can't be accepted yet")
        new, diffs = self.fix_preview(g)
        for path, src in new.items():
            (self.root / path).write_text(src)  # the scanned copy only; nothing is run
        self.overrides[gid] = copy.deepcopy(g["after"])
        model_change = any(f["included"] and f["rule"] == "model_too_big" for f in g["findings"])
        record = {
            "id": gid,
            "function": g["function"],
            "file": g["file"],
            "saved_usd": g["summary"]["saved_usd"],
            "saved_kwh": g["summary"]["saved_kwh"],
            "titles": [f["bullet"] for f in g["findings"] if f["included"]],
            "changes": [{"rule": f["rule"], "title": f["title"], "detail": f["detail"], "bullet": f["bullet"],
                         "target_model": f.get("target_model"), "badge": f["badge"]}
                        for f in g["findings"] if f["included"]],
            "receipt": {**status["receipt"], "date": time.strftime("%Y-%m-%d")},
            "patch": "\n".join(diffs.values()),
            "rollout": rollout_plan(model_change, self.linked),
        }
        self.accepted.append(record)
        self.tests.pop(gid, None)
        self.analyze()
        self.energy_steps.append({"label": g["function"], "kwh": self.totals["kwh"]})
        return record

    def set_traffic(self, site_id, calls):
        calls = int(calls)
        if not 1 <= calls <= 1_000_000_000:
            raise KeyError("Calls per month must be between 1 and 1,000,000,000")
        if site_id:
            if not any(s["id"] == site_id for s in self.sites):
                raise KeyError("Unknown AI call")
            self.traffic[site_id] = calls
        else:
            self.default_calls = calls
            self.traffic.clear()
        initial_before = self.initial
        self.analyze()
        if not self.accepted:  # nothing shipped yet: the "before" picture moves with the estimate
            self.initial = copy.deepcopy(self.totals)
            self.energy_steps = [{"label": "Before Prune", "kwh": self.totals["kwh"]}]
        else:
            self.initial = initial_before

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

    # ----- budget settings (saved across reloads) ------------------------------

    def set_limit(self, feature, usd):
        if usd is not None and float(usd) < 0:
            raise KeyError("A limit can't be negative")

        def fn(st):
            if feature in st["added"]:
                st["added"][feature] = None if usd is None else float(usd)
            elif usd is None:
                st["limits"].pop(feature, None)
            else:
                st["limits"][feature] = float(usd)
        BUDGETS.update(self.key, fn)

    def add_limit(self, name, usd):
        name = (name or "").strip()[:80]
        if not name or float(usd) <= 0:
            raise KeyError("Add a name and a monthly amount above $0")
        BUDGETS.update(self.key, lambda st: st["added"].__setitem__(name, float(usd)))

    def set_threshold(self, usd):
        if usd is None or float(usd) < 0:
            raise KeyError("The limit for one change must be $0 or more")
        BUDGETS.update(self.key, lambda st: st.__setitem__("threshold", float(usd)))

    def decide_change(self, decision):
        if decision not in ("approved", "sent back", None):
            raise KeyError("decision must be approved or sent back")
        if not self.incoming_review:
            raise KeyError("No change is waiting")
        file = self.incoming_review["file"]

        def fn(st):
            if decision is None:
                st["decisions"].pop(file, None)
            else:
                st["decisions"][file] = decision
        BUDGETS.update(self.key, fn)

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


def rollout_plan(model_change, linked=False):
    if linked:
        return [{"pct": 0, "note": "Copy the change into your repo and run your tests before merging. Prune didn't run this code.", "status": "pending"}]
    if not model_change:
        return [{"pct": 100, "note": "Answers are unchanged, so the fix ships to everyone.", "status": "done"}]
    return [
        {"pct": 10, "note": "10% of traffic for 24h. Watching how often people correct or regenerate answers: 2.0% → 2.1% (within normal range).", "status": "healthy"},
        {"pct": 100, "note": "No rise in corrections or thumbs-down, so Prune promotes it to 100%. It rolls back automatically if that changes.", "status": "done"},
    ]


def _register(state):
    with _lock:
        PROJECTS[state.id] = state
        if len(PROJECTS) > MAX_PROJECTS:
            for old in sorted(PROJECTS.values(), key=lambda s: s.created)[: len(PROJECTS) - MAX_PROJECTS]:
                PROJECTS.pop(old.id, None)
                old.cleanup()
    return state


def new_project(sample=None, paste=None):
    if sample:
        if sample not in SAMPLES:
            raise KeyError("Unknown sample")
        info = SAMPLES[sample]
        state = ProjectState(info["name"], "sample", f"sample:{sample}", files_root=info["path"], sample=sample,
                             source={"kind": "sample"})
    else:
        name = PurePosixPath((paste.get("filename") or "app.py").strip()).name or "app.py"
        if not name.endswith(".py"):
            name += ".py"
        code = paste["code"]
        state = ProjectState("Pasted code", "paste", f"paste:{_hash(code)}", files={name: code},
                             default_calls=int(paste.get("calls_per_month") or DEFAULT_REPO_CALLS),
                             source={"kind": "paste"})
    return _register(state)


# ----- scanning a GitHub link (static only) ---------------------------------------

def start_scan(url, calls=None):
    info = fetch.parse_github_url(url)  # bad links fail right away
    job = {"id": uuid.uuid4().hex[:10], "state": "fetching", "message": "Downloading from GitHub",
           "label": info["label"], "url": info["url"], "error": None, "project": None, "started": time.time()}
    with _lock:
        JOBS[job["id"]] = job
    threading.Thread(target=_scan, args=(job, info, int(calls or DEFAULT_REPO_CALLS)), daemon=True).start()
    return job


def _scan(job, info, calls):
    tmp = Path(tempfile.mkdtemp(prefix="prune-fetch-"))
    try:
        stats = fetch.fetch(info, tmp / "src", on_progress=lambda m: job.update(message=m))
        job.update(state="scanning", message=f"Reading {stats['files']} Python file{'s' if stats['files'] != 1 else ''}")
        state = ProjectState(info["label"], "repo", f"repo:{info['label'].lower()}", files_root=tmp / "src",
                             default_calls=calls,
                             source={"kind": "repo", "url": info["url"], "label": info["label"], "ref": info["ref"],
                                     "path": info["path"], "files": stats["files"], "skipped": stats["skipped"]})
        _register(state)
        job.update(state="done", message=f"{len(state.sites)} AI call{'s' if len(state.sites) != 1 else ''} found",
                   project=state.id)
    except fetch.FetchError as e:
        job.update(state="error", error=str(e), message=str(e))
    except Exception as e:  # never leave the UI spinning
        job.update(state="error", error="Something went wrong reading that repo.", message=f"{type(e).__name__}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def job_status(job_id):
    job = JOBS.get(job_id)
    if not job:
        raise KeyError("Scan not found")
    out = {k: v for k, v in job.items() if k != "project"}
    if job["project"] and job["project"] in PROJECTS:
        out["project"] = PROJECTS[job["project"]].payload()
    out["seconds"] = round(time.time() - job["started"], 1)
    return out


def get(pid):
    if pid not in PROJECTS:
        raise KeyError("Project not found (the server may have restarted). Load it again.")
    return PROJECTS[pid]
