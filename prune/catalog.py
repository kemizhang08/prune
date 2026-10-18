"""Model prices, sizes and energy ranges.

Prices are public list prices in USD per 1M tokens. Teams can edit them here.
Energy is always a low-high range per 1,000 tokens by model size class, because
providers don't publish per-model energy. The ranges are stand-ins derived from
published estimates (Epoch AI's GPT-4o per-query estimate, Hugging Face AI Energy
Score and the ML.ENERGY leaderboard for open models of similar size).
"""

# name: (input, cached_input, output, size_class, provider)
MODELS = {
    "gpt-4o": (2.50, 1.25, 10.00, "large", "openai"),
    "gpt-4o-mini": (0.15, 0.075, 0.60, "small", "openai"),
    "gpt-4.1": (2.00, 0.50, 8.00, "large", "openai"),
    "gpt-4.1-mini": (0.40, 0.10, 1.60, "small", "openai"),
    "gpt-4.1-nano": (0.10, 0.025, 0.40, "small", "openai"),
    "gpt-5": (1.25, 0.125, 10.00, "large", "openai"),
    "gpt-5-mini": (0.25, 0.025, 2.00, "small", "openai"),
    "gpt-5-nano": (0.05, 0.005, 0.40, "small", "openai"),
    "o3": (2.00, 0.50, 8.00, "large", "openai"),
    "gpt-4-turbo": (10.00, 10.00, 30.00, "large", "openai"),
    "gpt-4": (30.00, 30.00, 60.00, "large", "openai"),
    "gpt-3.5-turbo": (0.50, 0.50, 1.50, "medium", "openai"),
    "o1": (15.00, 7.50, 60.00, "large", "openai"),
    "o3-mini": (1.10, 0.55, 4.40, "medium", "openai"),
    "o4-mini": (1.10, 0.275, 4.40, "medium", "openai"),
    "claude-opus-4-1": (15.00, 1.50, 75.00, "large", "anthropic"),
    "claude-opus-4": (15.00, 1.50, 75.00, "large", "anthropic"),
    "claude-sonnet-4": (3.00, 0.30, 15.00, "medium", "anthropic"),
    "claude-3-7-sonnet": (3.00, 0.30, 15.00, "medium", "anthropic"),
    "claude-3-5-sonnet": (3.00, 0.30, 15.00, "medium", "anthropic"),
    "claude-3-5-haiku": (0.80, 0.08, 4.00, "small", "anthropic"),
    "claude-3-opus": (15.00, 1.50, 75.00, "large", "anthropic"),
    "claude-3-haiku": (0.25, 0.03, 1.25, "small", "anthropic"),
    "claude-sonnet-4-5": (3.00, 0.30, 15.00, "medium", "anthropic"),
    "claude-3-5-sonnet-latest": (3.00, 0.30, 15.00, "medium", "anthropic"),
    "claude-haiku-4-5": (1.00, 0.10, 5.00, "small", "anthropic"),
    "claude-3-5-haiku-latest": (0.80, 0.08, 4.00, "small", "anthropic"),
    "gemini-2.5-pro": (1.25, 0.31, 10.00, "large", "google"),
    "gemini-2.5-flash": (0.30, 0.075, 2.50, "small", "google"),
    "gemini-2.0-flash": (0.10, 0.025, 0.40, "small", "google"),
    "llama-3.1-70b": (0.59, 0.59, 0.79, "medium", "open"),
    "llama-3.3-70b": (0.59, 0.59, 0.79, "medium", "open"),
    "llama-3.1-8b": (0.05, 0.05, 0.08, "small", "open"),
    "llama-3.1-405b": (3.00, 3.00, 3.00, "large", "open"),
    "claude-opus-4-5": (5.00, 0.50, 25.00, "large", "anthropic"),
    "grok-4": (3.00, 0.75, 15.00, "large", "xai"),
    # Embeddings: input only, no output tokens.
    "text-embedding-3-large": (0.13, 0.13, 0.0, "small", "openai"),
    "text-embedding-3-small": (0.02, 0.02, 0.0, "small", "openai"),
    "text-embedding-ada-002": (0.10, 0.10, 0.0, "small", "openai"),
}

# Big model -> the small sibling Prune proposes first (same provider, cheapest that
# usually holds up on classification-style work).
SMALLER = {
    "gpt-4o": "gpt-4o-mini",
    "gpt-4.1": "gpt-4.1-mini",
    "gpt-5": "gpt-5-mini",
    "o3": "gpt-4.1-mini",
    "gpt-4-turbo": "gpt-4o-mini",
    "claude-opus-4-1": "claude-haiku-4-5",
    "claude-sonnet-4-5": "claude-haiku-4-5",
    "claude-3-5-sonnet-latest": "claude-3-5-haiku-latest",
    "claude-opus-4": "claude-haiku-4-5",
    "claude-sonnet-4": "claude-haiku-4-5",
    "claude-3-7-sonnet": "claude-3-5-haiku-latest",
    "claude-3-5-sonnet": "claude-3-5-haiku-latest",
    "claude-3-opus": "claude-3-haiku",
    "gpt-4": "gpt-4o-mini",
    "gemini-2.5-pro": "gemini-2.5-flash",
    "llama-3.1-70b": "llama-3.1-8b",
    "llama-3.3-70b": "llama-3.1-8b",
    "llama-3.1-405b": "llama-3.1-8b",
    "claude-opus-4-5": "claude-haiku-4-5",
    "grok-4": "gpt-4o-mini",
    "text-embedding-3-large": "text-embedding-3-small",
}

# kWh per 1,000 tokens processed, (low, high), by size class.
ENERGY_PER_1K = {
    "large": (0.00022, 0.00061),
    "medium": (0.00008, 0.00022),
    "small": (0.00002, 0.00006),
}
# Tokens served from a prompt cache skip most prefill compute.
CACHED_TOKEN_ENERGY_WEIGHT = 0.1

# kg CO2e per kWh, (low, high): typical cloud-region grid mix.
GRID_KG_PER_KWH = (0.25, 0.45)

# Share of cacheable-prefix tokens actually served from cache. Caches expire after
# minutes of idle time, so bursty traffic misses often. An estimate, editable.
CACHE_HIT_RATE = 0.5

# Providers only cache prefixes at least this long.
MIN_CACHEABLE_TOKENS = 1024

ENERGY_SOURCES = [
    "Epoch AI (2025), 'How much energy does ChatGPT use?' — ~0.3 Wh per typical GPT-4o query",
    "Hugging Face AI Energy Score — measured open models, used as stand-ins by size",
    "ML.ENERGY leaderboard — per-token energy for open models on A100/H100",
]


# Typical prices by size, used only for models missing from the list above.
FAMILY_PRICES = {
    "large": (2.50, 1.25, 10.00),
    "medium": (3.00, 0.30, 15.00),
    "small": (0.25, 0.025, 1.25),
}
SMALL_HINTS = ("mini", "nano", "haiku", "flash", "lite", "small", "8b", "7b", "3b", "embedding")
MEDIUM_HINTS = ("sonnet", "70b", "mixtral", "medium")


def normalize(name):
    """'openai/o3' -> 'o3', 'anthropic/claude-opus-4.5' -> 'claude-opus-4-5'. Returns (vendor prefix, name)."""
    name = (name or "").strip()
    prefix = ""
    if "/" in name:
        prefix, name = name.split("/", 1)
        prefix += "/"
    if name.startswith("claude"):
        name = name.replace(".", "-")
    return prefix, name


def _lookup(table, name):
    if name in table:
        return table[name]
    # Dated snapshots and suffixed variants: gpt-4o-2024-08-06, llama-3.3-70b-versatile.
    for key in sorted(table, key=len, reverse=True):
        if name.startswith(key + "-"):
            return table[key]
    return None


def model_info(name):
    """Return (input, cached, output, size, provider) or None for unknown models."""
    return _lookup(MODELS, normalize(name)[1])


def price_for(name):
    """(input, cached, output, size, provider) plus where the price came from.

    Known models use list prices. Anything else is priced by size class guessed from
    its name and labelled as an estimate, so new or self-hosted models still rank.
    """
    info = model_info(name or "")
    if info:
        return info, "list price"
    low = (name or "").lower()
    if not low or low == "unknown":
        size, source = "medium", "model not set in the code: priced as a mid-size model"
    elif any(h in low for h in SMALL_HINTS):
        size, source = "small", "estimated: priced as a small model"
    elif any(h in low for h in MEDIUM_HINTS):
        size, source = "medium", "estimated: priced as a mid-size model"
    else:
        size, source = "large", "estimated: priced as a large model"
    provider = "anthropic" if "claude" in low else "google" if "gemini" in low else "openai" if low.startswith(("gpt", "o1", "o3", "o4")) else "unknown"
    return (*FAMILY_PRICES[size], size, provider), source


def smaller_model(name):
    """The small sibling Prune suggests, keeping an OpenRouter-style vendor prefix."""
    prefix, base = normalize(name)
    if price_for(name)[0][3] == "small":
        return None
    target = _lookup(SMALLER, base)
    if target is None:
        low = base.lower()
        if low.startswith("claude") and ("opus" in low or "sonnet" in low):
            target = "claude-haiku-4-5"
        elif low.startswith("gemini") and "pro" in low:
            target = "gemini-2.5-flash"
        elif low.startswith(("o1", "o3", "gpt-5", "gpt-4")) and not any(h in low for h in SMALL_HINTS):
            target = "gpt-4o-mini"
    if target is None:
        return None
    if prefix and not target.startswith(("claude", "gemini", "llama")):
        return "openai/" + target if prefix != "openai/" else prefix + target
    if prefix:
        vendor = {"claude": "anthropic/", "gemini": "google/", "llama": "meta-llama/"}[target.split("-")[0]]
        return vendor + target
    return target


REASONING_MODELS = ("o1", "o3", "o4", "gpt-5")


def is_reasoning_model(name):
    """Models that spend hidden 'thinking' tokens on every answer."""
    base = normalize(name)[1].lower()
    return base.startswith(("o1", "o3", "o4")) or (base.startswith("gpt-5") and "chat" not in base)


# Everyday comparisons, applied to the middle of each range. Estimates.
EQUIVALENTS = {
    "kwh_per_phone_charge": 0.015,  # a full smartphone charge, ~12–19 Wh
    "kwh_per_home_day": 29.0,  # average US home, EIA: ~10,800 kWh a year
    "kg_co2_per_km": 0.25,  # average passenger car, EPA: ~400 g CO2 a mile
}
EQUIVALENT_SOURCES = "Comparisons: EIA average US home use; EPA average car emissions per mile."


def as_json():
    return {
        "models": {
            k: {"input": v[0], "cached": v[1], "output": v[2], "size": v[3], "provider": v[4]}
            for k, v in MODELS.items()
        },
        "energy_per_1k": ENERGY_PER_1K,
        "grid_kg_per_kwh": GRID_KG_PER_KWH,
        "cache_hit_rate": CACHE_HIT_RATE,
        "cached_token_weight": CACHED_TOKEN_ENERGY_WEIGHT,
        "equivalents": EQUIVALENTS,
        "sources": ENERGY_SOURCES + [EQUIVALENT_SOURCES],
    }
