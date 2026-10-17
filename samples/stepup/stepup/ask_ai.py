"""The "Ask AI" chat widget on stepupshoes.example."""

from stepup.llm import client
from stepup.policy import STORE_POLICY

SESSIONS = {}


def answer_question(session_id, question):
    history = SESSIONS.setdefault(session_id, [{"role": "system", "content": STORE_POLICY}])
    history.append({"role": "user", "content": question})
    resp = client.chat.completions.create(
        model="gpt-4o",
        messages=history,
    )
    reply = resp.choices[0].message.content
    history.append({"role": "assistant", "content": reply})
    return reply[:600]  # the widget bubble shows at most 600 characters
