"""Turn a traffic profile into dollars, kWh and carbon.

A profile describes one AI call site per month:
    calls, input_tokens, cached_tokens, output_tokens (per call averages), model,
    plus an optional split where a share of calls stays on another model (a guard),
    and a batch flag (Batch APIs bill at half price).
"""

from . import catalog


def make_profile(model, calls, input_tokens, output_tokens, cached_tokens=0, estimate=False, source=""):
    return {
        "model": model,
        "calls": float(calls),
        "input_tokens": float(input_tokens),
        "cached_tokens": float(cached_tokens),
        "output_tokens": float(output_tokens),
        "guard_model": None,
        "guard_share": 0.0,
        "batch": False,
        "estimate": estimate,
        "source": source,
    }


def _parts(p):
    """Split a profile into (model, calls) parts, honouring a guard split."""
    if p.get("guard_model") and p.get("guard_share"):
        g = p["guard_share"]
        return [(p["model"], p["calls"] * (1 - g)), (p["guard_model"], p["calls"] * g)]
    return [(p["model"], p["calls"])]


def _price(model):
    info = catalog.model_info(model)
    if info is None:
        # Unknown model: price it like a mid-size model so it still ranks.
        return (1.0, 0.5, 4.0, "medium", "unknown")
    return info


def per_call_cost(model, p):
    inp, cached, out, _, _ = _price(model)
    uncached = max(p["input_tokens"] - p["cached_tokens"], 0)
    cost = (uncached * inp + p["cached_tokens"] * cached + p["output_tokens"] * out) / 1e6
    if p.get("batch"):
        cost *= 0.5
    return cost


def monthly_cost(p):
    return sum(per_call_cost(m, p) * calls for m, calls in _parts(p))


def monthly_energy(p):
    """(low, high) kWh per month."""
    lo = hi = 0.0
    for m, calls in _parts(p):
        size = _price(m)[3]
        e_lo, e_hi = catalog.ENERGY_PER_1K[size]
        uncached = max(p["input_tokens"] - p["cached_tokens"], 0)
        k_tokens = (uncached + p["cached_tokens"] * catalog.CACHED_TOKEN_ENERGY_WEIGHT + p["output_tokens"]) / 1000
        lo += k_tokens * calls * e_lo
        hi += k_tokens * calls * e_hi
    return lo, hi


def carbon(kwh_range):
    g_lo, g_hi = catalog.GRID_KG_PER_KWH
    return kwh_range[0] * g_lo, kwh_range[1] * g_hi


def summarize(before, after):
    """Dollar/kWh/carbon before, after and saved for a pair of profiles."""
    cb, ca = monthly_cost(before), monthly_cost(after)
    eb, ea = monthly_energy(before), monthly_energy(after)
    # Savings range pairs low with low and high with high: same assumptions on both sides.
    saved_kwh = (max(eb[0] - ea[0], 0), max(eb[1] - ea[1], 0))
    return {
        "cost_before": round(cb, 2),
        "cost_after": round(ca, 2),
        "saved_usd": round(cb - ca, 2),
        "kwh_before": [round(x, 1) for x in eb],
        "kwh_after": [round(x, 1) for x in ea],
        "saved_kwh": [round(x, 1) for x in saved_kwh],
        "saved_kg_co2e": [round(x, 1) for x in carbon(saved_kwh)],
    }


def profile_summary(p):
    e = monthly_energy(p)
    return {
        "cost": round(monthly_cost(p), 2),
        "kwh": [round(x, 1) for x in e],
        "kg_co2e": [round(x, 1) for x in carbon(e)],
    }
