"""Generate the seeded replay recordings for the StepUp sample.

Stands in for "500 real customer emails from last week, names and addresses removed",
with the label each model gave. Run: python3 scripts/make_recordings.py
"""

import json
import random
from pathlib import Path

random.seed(2026)
OUT = Path(__file__).resolve().parent.parent / "samples/stepup/recordings/classify_ticket.jsonl"

REFUND = [
    "I'd like to return the {shoe} I bought, they don't fit. Can I get my money back?",
    "Please refund order SU-{n}. The {shoe} are too narrow.",
    "Changed my mind about the {shoe}, how do I get a refund?",
    "Hi, I was charged twice for order SU-{n}, please refund one of them.",
    "The {shoe} squeak when I walk. I want a refund. [NAME]",
    "Can I return the {shoe} without the original box and still get a refund?",
]
SHIPPING = [
    "Where is my order SU-{n}? It's been a week.",
    "Tracking for SU-{n} hasn't updated since Monday.",
    "Do you ship the {shoe} to [ADDRESS]?",
    "My parcel says delivered but nothing arrived at [ADDRESS].",
    "Can I change the delivery address for SU-{n} to [ADDRESS]?",
    "How long does express shipping take for the {shoe}?",
]
OTHER = [
    "Do the {shoe} come in a half size?",
    "Are the {shoe} good for running on trails?",
    "How do I clean suede {shoe}?",
    "Is there a student discount? - [NAME]",
    "Can I use two gift cards on one order?",
    "When will the {shoe} be back in stock?",
]
# Emails that mention broken or damaged goods; both models agree on these.
DAMAGED_AGREE = [
    ("The {shoe} arrived with a broken buckle, I want a refund please.", "refund"),
    ("Box was damaged in transit but the {shoe} look fine, just letting you know.", "other"),
    ("Strap broken after two days, can I return the {shoe} for my money back?", "refund"),
    ("Delivery van left my parcel damaged and soaked at [ADDRESS], where is the replacement shipment?", "shipping"),
    ("Is a broken lace covered by the warranty on the {shoe}?", "other"),
]
# The three emails where the small model disagrees, shown first in replay.
DIFFS = [
    ("My shoes arrived broken, I want my money back", "refund", "shipping"),
    ("Box was damaged and the heel is broken. Refund please?", "refund", "shipping"),
    ("Sneakers came damaged, can you send new ones or credit my card?", "refund", "other"),
]
SHOES = ["trail runners", "suede loafers", "Cloudstep sneakers", "leather boots", "kids' sandals", "court shoes"]


def fill(t):
    return t.format(shoe=random.choice(SHOES), n=random.randint(100000, 999999))


rows = []
for text, before, after in DIFFS:
    rows.append({"input": text, "before": before, "after": {"gpt-4o-mini": after}})
for _ in range(57):
    t, label = random.choice(DAMAGED_AGREE)
    rows.append({"input": fill(t), "before": label, "after": {"gpt-4o-mini": label}})
pools = [(REFUND, "refund")] * 4 + [(SHIPPING, "shipping")] * 4 + [(OTHER, "other")] * 2
while len(rows) < 500:
    pool, label = random.choice(pools)
    rows.append({"input": fill(random.choice(pool)), "before": label, "after": {"gpt-4o-mini": label}})
random.shuffle(rows)
with OUT.open("w") as f:
    for i, r in enumerate(rows, 1):
        f.write(json.dumps({"id": i, **r}) + "\n")
print(f"wrote {len(rows)} recordings to {OUT}")
