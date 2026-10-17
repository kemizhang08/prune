"""Draft a first reply for an agent to edit."""

from stepup.llm import client


def summarize(ticket_text):
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        max_tokens=120,
        messages=[
            {"role": "system", "content": "Summarize this support ticket in two sentences."},
            {"role": "user", "content": ticket_text},
        ],
    )
    return resp.choices[0].message.content


def draft_reply(ticket_text, log):
    log.info("ticket summary: %s", summarize(ticket_text))
    summary = summarize(ticket_text)
    return f"Hi there,\n\nThanks for reaching out. Here's what we understood: {summary}\n\nStepUp Support"
