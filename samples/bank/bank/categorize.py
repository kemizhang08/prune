"""Tag card transactions for the spending insights screen (~1.2M a month)."""

from bank.llm import client

CATEGORY_PROMPT = (
    "You categorize card transactions for a retail bank. "
    "Reply with exactly one of: groceries, travel, bills, other."
)
CATEGORIES = {"groceries", "travel", "bills", "other"}


def categorize_transaction(description, amount):
    resp = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=500,
        messages=[
            {"role": "system", "content": CATEGORY_PROMPT},
            {"role": "user", "content": f"{description} ({amount:.2f} USD)"},
        ],
    )
    category = resp.choices[0].message.content.strip().lower()
    if category not in {"groceries", "travel", "bills", "other"}:
        category = "other"
    return category
