"""Product review storage (stub)."""

_REVIEWS = []
_DIGESTS = []


def fetch_recent(hours=24):
    return list(_REVIEWS)


def save_digest(summaries):
    _DIGESTS.append(summaries)
