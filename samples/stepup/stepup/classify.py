"""Sort incoming help-desk emails (about 40,000 a month)."""

from stepup.llm import client
from stepup.policy import STORE_POLICY


def classify_ticket(email_text):
    resp = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=1000,
        messages=[
            {"role": "system", "content": STORE_POLICY},
            {"role": "user", "content": email_text},
        ],
    )
    label = resp.choices[0].message.content.strip().lower()
    if label in ("refund", "shipping", "other"):
        return label
    return "other"


def extract_order_id(email_text):
    resp = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {
                "role": "system",
                "content": "Extract the order number from the email. Order numbers look like SU-123456. "
                "Reply with the order number only, or NONE if there isn't one.",
            },
            {"role": "user", "content": email_text},
        ],
    )
    answer = resp.choices[0].message.content.strip()
    if answer == "NONE":
        return None
    return answer
