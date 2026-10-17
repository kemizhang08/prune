"""An agent that handles return requests with tools."""

import json

from stepup.llm import client

AGENT_PROMPT = "You handle StepUp Shoes return requests. Use the tools, then answer the customer."

TOOL_SPECS = [
    {"type": "function", "function": {"name": "lookup_order", "parameters": {"type": "object", "properties": {"order_id": {"type": "string"}}}}},
    {"type": "function", "function": {"name": "create_label", "parameters": {"type": "object", "properties": {"order_id": {"type": "string"}}}}},
]


def lookup_order(order_id):
    return {"order_id": order_id, "status": "delivered", "days_since_delivery": 12}


def create_label(order_id):
    return {"label_url": f"https://labels.example/{order_id}.pdf"}


TOOLS = {"lookup_order": lookup_order, "create_label": create_label}


def run_returns_agent(request):
    messages = [{"role": "system", "content": AGENT_PROMPT}, {"role": "user", "content": request}]
    while True:
        try:
            resp = client.chat.completions.create(model="gpt-4o", messages=messages, tools=TOOL_SPECS)
        except Exception:
            continue  # try again
        msg = resp.choices[0].message
        if not msg.tool_calls:
            return msg.content
        messages.append(msg)
        for call in msg.tool_calls:
            result = TOOLS[call.function.name](**json.loads(call.function.arguments))
            messages.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps(result)})
