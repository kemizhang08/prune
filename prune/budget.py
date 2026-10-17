"""Per-feature monthly AI budgets from the repo's prune.toml."""

import fnmatch
import tomllib
from pathlib import Path


def load_config(root):
    path = Path(root) / "prune.toml"
    if not path.exists():
        return {"review": {"approval_threshold_usd": 50}, "features": {}}
    return tomllib.loads(path.read_text())


def feature_for(config, file):
    for name, f in config.get("features", {}).items():
        if any(fnmatch.fnmatch(file, pat) for pat in f.get("paths", [])):
            return name
    return None


def report(config, site_costs):
    """site_costs: list of {file, cost}. Returns rows per feature."""
    rows = []
    for name, f in config.get("features", {}).items():
        cost = sum(s["cost"] for s in site_costs if feature_for(config, s["file"]) == name)
        budget = f.get("budget_usd", 0)
        rows.append({"feature": name, "budget": budget, "cost": round(cost, 2), "over": cost > budget,
                     "paths": f.get("paths", [])})
    return rows


def check_change(config, file, added_cost, current_feature_cost):
    threshold = config.get("review", {}).get("approval_threshold_usd", 50)
    feature = feature_for(config, file)
    budget = config.get("features", {}).get(feature, {}).get("budget_usd") if feature else None
    projected = current_feature_cost + added_cost
    return {
        "threshold": threshold,
        "needs_approval": added_cost > threshold,
        "feature": feature,
        "budget": budget,
        "feature_cost_now": round(current_feature_cost, 2),
        "feature_cost_after": round(projected, 2),
        "over_budget": budget is not None and projected > budget,
    }
