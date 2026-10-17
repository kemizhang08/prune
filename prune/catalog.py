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
    "claude-opus-4-1": (15.00, 1.50, 75.00, "large", "anthropic"),
    "claude-sonnet-4-5": (3.00, 0.30, 15.00, "medium", "anthropic"),
    "claude-3-5-sonnet-latest": (3.00, 0.30, 15.00, "medium", "anthropic"),
    "claude-haiku-4-5": (1.00, 0.10, 5.00, "small", "anthropic"),
    "claude-3-5-haiku-latest": (0.80, 0.08, 4.00, "small", "anthropic"),
    "gemini-2.5-pro": (1.25, 0.31, 10.00, "large", "google"),
    "gemini-2.5-flash": (0.30, 0.075, 2.50, "small", "google"),
    "gemini-2.0-flash": (0.10, 0.025, 0.40, "small", "google"),
    "llama-3.1-70b": (0.59, 0.59, 0.79, "medium", "open"),
    "llama-3.1-8b": (0.05, 0.05, 0.08, "small", "open"),
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
    "gemini-2.5-pro": "gemini-2.5-flash",
    "llama-3.1-70b": "llama-3.1-8b",
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


def model_info(name):
    """Return (input, cached, output, size, provider) or None for unknown models."""
    if name in MODELS:
        return MODELS[name]
    # Tolerate dated snapshots like gpt-4o-2024-08-06.
    for key in sorted(MODELS, key=len, reverse=True):
        if name.startswith(key):
            return MODELS[key]
    return None


def smaller_model(name):
    for key in sorted(SMALLER, key=len, reverse=True):
        if name == key or name.startswith(key + "-20"):
            return SMALLER[key]
    return None


def as_json():
    return {
        "models": {
            k: {"input": v[0], "cached": v[1], "output": v[2], "size": v[3], "provider": v[4]}
            for k, v in MODELS.items()
        },
        "energy_per_1k": ENERGY_PER_1K,
        "grid_kg_per_kwh": GRID_KG_PER_KWH,
        "cache_hit_rate": CACHE_HIT_RATE,
        "sources": ENERGY_SOURCES,
    }
