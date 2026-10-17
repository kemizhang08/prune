"""A stand-in for the OpenAI client so tests run offline."""

from types import SimpleNamespace as NS


def _resp(content=None, tool_calls=None):
    msg = NS(content=content, tool_calls=tool_calls)
    return NS(choices=[NS(message=msg)])


class FakeClient:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []
        self.chat = NS(completions=NS(create=self._create))

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        reply = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        if isinstance(reply, Exception):
            raise reply
        if isinstance(reply, dict):
            return _resp(tool_calls=[NS(id="t1", function=NS(name=reply["tool"], arguments=reply["args"]))])
        return _resp(content=reply)
