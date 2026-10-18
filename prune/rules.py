"""Launch rules: turn analyzed AI call sites into fix groups.

One group per call site (one comment per change). Each group holds the findings,
the exact line edits, a before/after traffic profile and what proof it needs.
"""

import copy
import math

from . import catalog, costing, fixes
from .analyzer import size_class

FIX_KINDS = {
    "same_answer": "Same answer, cheaper — passing tests are enough",
    "code_change": "Code change — the team's tests must pass",
    "model_change": "Different model — needs replay proof",
    "less_context": "Less context — needs replay proof",
    "advice": "Advice only",
}

DEFAULT_USER_TOKENS = 300
HISTORY_KEEP = 6
EST_HISTORY_KEEP_SHARE = 0.4  # share of history tokens left after trimming to the last 6 messages
MAX_AGENT_STEPS = 8


def baseline_profile(site, usage_rec, usage_source, override, default_calls, calls_override=None):
    if override:
        p = copy.deepcopy(override)
        p["source"] = "projected after the accepted fix"
        return p
    model = site["model"] or "unknown"
    if usage_rec:
        return costing.make_profile(
            usage_rec.get("model_seen") or model,
            usage_rec["calls_per_month"],
            usage_rec["avg_input_tokens"],
            usage_rec["avg_output_tokens"],
            cached_tokens=usage_rec.get("cached_tokens", 0),
            estimate=False,
            source=usage_source,
        )
    if "est_input_tokens" in site:  # traced through a wrapper: sizes come from the prompt actually built
        inp, out = site["est_input_tokens"], site["est_output_tokens"]
        if site["history_appended"] or site.get("history_in_prompt"):
            inp += 1500
    else:
        sys_t = (site["system"] or {}).get("tokens", 0)
        inp = sys_t + DEFAULT_USER_TOKENS + (1500 if site["history_appended"] else 0)
        if site["answer"]["kind"] in ("label", "number", "boolean"):
            out = min(site["max_tokens"] or 20, 20)
        else:
            out = min(site["max_tokens"] or 300, 300)
    if calls_override:
        calls, who = calls_override, "set by you"
    elif site.get("est_calls"):
        calls, who = site["est_calls"], site.get("est_calls_source", "from the call graph")
    else:
        calls, who = default_calls, "default"
    p = costing.make_profile(
        model, calls, inp, out, estimate=True,
        source=f"estimate: {int(calls):,} calls a month ({who}), tokens estimated from the prompt",
    )
    if site.get("fanout"):
        p["fanout"] = list(site["fanout"])
        p["calls"] = calls / len(site["fanout"])  # calls counts every model; each model gets its share
    return p


def needed_tokens(answer):
    kind = answer["kind"]
    if kind == "label":
        longest = max((len(l) for l in answer["labels"]), default=8)
        return max(5, math.ceil(longest / 4) + 2)
    if kind == "number":
        return 10
    if kind == "boolean":
        return 3
    if answer["display_chars"]:
        return int(math.ceil(answer["display_chars"] / 4 * 1.25 / 50) * 50)
    return None


def _line(module, n):
    return module.lines[n - 1]


TASK_CUES = (
    ("grammar", "a grammar fix"),
    ("title for this conversation", "a 3-word title"),
    ("3-word title", "a 3-word title"),
    ("translate", "a translation"),
    ("search query", "rewriting a search query"),
    ("critique", "critiquing a report"),
)


def _what(answer):
    return {"label": f"one of {len(answer['labels'])} labels" if answer["labels"] else "a label",
            "boolean": "a yes/no", "number": "a number", "structured": "a few JSON fields",
            "vector": "an embedding"}.get(answer["kind"], "a short answer")


def call_site_rules(site, before, add, model, ctx):
    """Advice for one call through a wrapper, from the parameters actually passed."""
    answer = site["answer"]
    kind = answer["kind"]
    short = kind in ("label", "boolean", "number", "structured")
    what = _what(answer)
    low = site.get("prompt_text", "").lower()
    task = next((label for cue, label in TASK_CUES if cue in low), None)
    via = site["via"]
    line = [site["line"]]
    loops = [lp for lp in site.get("loops", []) if lp["kind"] in ("for", "comprehension") and not lp.get("early_exit")]

    # Several frontier models asked the same question, then a vote.
    fan = site.get("fanout") or []
    if len(fan) > 1:
        target = catalog.smaller_model(fan[0]) or "openai/gpt-4o-mini"
        add("ensemble", "Several frontier models for one simple answer",
            f"Every call goes to {len(fan)} models ({', '.join(fan)}) through {via}, and the code takes a vote, all to get {what}. "
            f"One small model gives the same {what} for a fraction of the cost.",
            "model_change", "advice", [], lambda p, t=target: p.update(fanout=None, model=t), line,
            f"Ask one small model ({target}) instead of {len(fan)} frontier models", included=False)

    # One call per item in a loop (N+1).
    if loops and not site.get("overwritten"):
        lp = loops[0]
        n = lp["count"]
        count = f"{n} calls" if n else "one call per item"
        if kind == "vector":
            add("per_item_calls", "Embeds the same data again on every request",
                f"`{lp['iter']}` is re-embedded one item at a time ({count}) every time this runs. Embed the knowledge base once, "
                f"store the vectors, and embed only the new question.",
                "code_change", "advice", [], lambda p, k=n or 1: p.update(calls=p["calls"] / k), [lp["line"]],
                "Embed the knowledge base once and reuse the vectors", included=False, estimate=True)
        else:
            add("per_item_calls", "One AI call per item in a loop",
                f"The loop over `{lp['iter']}` (line {lp['line']}) makes {count}, each re-sending the whole prompt, to get {what} per item. "
                f"Ask once with all the items and read back a list.",
                "code_change", "advice", [],
                lambda p, k=n or 1: p.update(calls=p["calls"] / k, output_tokens=p["output_tokens"] * min(k, 4)), [lp["line"]],
                f"Ask once for all {n or 'the'} items instead of one call each", included=False, estimate=True)

    ow = site.get("overwritten")
    if ow:
        add("overwritten_loop", "Re-runs the AI for every message but keeps only the last answer",
            f"`{ow['var']}` is overwritten on every pass of the loop on line {ow['line']}, so only the final call matters."
            + (" Each call also re-sends every earlier message, so the cost grows with the square of the thread length." if ow["quadratic"] else "")
            + " Call it once, after the loop, on the whole thread.",
            "code_change", "advice", [], lambda p: None, [ow["line"]], "Call once on the whole thread", included=False, estimate=True)

    dw = site.get("dup_work")
    if dw:
        add("duplicate_work", "The same AI call runs more than once per request",
            f"For every run of {dw['entry']}(), this call happens {dw['count']} times (via {', '.join(f'{v}()' for v in dw['via'])}). "
            f"Compute it once and pass the result along.",
            "code_change", "advice", [], lambda p, k=dw["count"]: p.update(calls=p["calls"] / k), line,
            "Compute it once and pass the result along", included=False, estimate=True)

    ub = site.get("unbounded_via")
    if ub:
        add("unbounded_loop", "Loops with no limit until another AI call says yes",
            f"{ub['function']}() repeats this in a `while` loop (line {ub['line']}) until a checker approves, with no cap. "
            f"A checker that keeps saying no means the bill never stops. Cap it at one retry.",
            "code_change", "advice", [], lambda p: None, [ub["line"]], "Cap the retry loop", included=False, estimate=True)

    jr = site.get("json_retry")
    if jr:
        add("json_retries", "Re-sends the whole prompt when the JSON is malformed",
            f"If the reply isn't valid JSON, the loop on line {jr['line']} sends the full prompt again"
            + (f", up to {jr['max']} times." if jr.get("max") else ".")
            + " Ask for structured output (JSON mode or response_format) so it parses the first time.",
            "code_change", "advice", [], lambda p: p.update(calls=p["calls"] * 0.85), [jr["line"]],
            "Use structured output instead of retrying", included=False, estimate=True)

    na = site.get("no_ai_needed")
    if na:
        title = {"language": "AI used to detect a language", "count": "AI used to count items",
                 "health": "Health check calls a model", "extract": "AI used to find IDs and emails"}[na["kind"]]
        keep = 0.4 if na["kind"] == "extract" else 0.0
        add("no_ai_needed", title, na["how"], "code_change", "advice", [],
            lambda p, k=keep: p.update(calls=p["calls"] * k), line, title.replace("AI used to", "Use plain code to"),
            included=False, estimate=True)

    big = site.get("prompt_tokens", 0)
    if big >= 2000 and (short or na or task):
        add("huge_prompt", "Sends a huge prompt for a small task",
            f"Every call sends about {big:,} tokens of instructions"
            + (" (the whole policy handbook and knowledge base, rebuilt from disk each time)" if site.get("static_tokens", 0) >= 1500 else "")
            + f" to get {task or what}. Send only the part this task needs.",
            "less_context", "advice", [], lambda p: p.update(input_tokens=min(p["input_tokens"], 700)), line,
            "Send only the instructions this task needs", included=False, estimate=True)

    hidden = site.get("hidden_tokens", 0)
    if hidden and (short or na or task):
        how = (f"extended thinking with a {site['thinking_budget']:,}-token budget" if site.get("thinking_budget")
               else f'reasoning_effort="{site["reasoning_effort"]}"' if site.get("reasoning_effort") else f"{model}, a reasoning model,")
        add("reasoning_overkill", "Pays for hidden thinking on a simple task",
            f"This call uses {how}, which bills roughly {hidden:,} hidden thinking tokens per call, to produce {task or what}. "
            f"Turn reasoning off or use a regular model.",
            "model_change", "advice", [], lambda p, h=hidden: p.update(output_tokens=max(p["output_tokens"] - h, 10)), line,
            "Turn off hidden reasoning for this call", included=False, estimate=True)

    if site.get("reasons_first") and short:
        add("reasoning_first", "Asks for paragraphs of analysis before a one-word answer",
            f"The prompt asks the model to explain its thinking first, but the code only reads {what}. Those extra words are paid for and thrown away.",
            "less_context", "advice", [], lambda p: p.update(output_tokens=min(p["output_tokens"], 10)), line,
            f"Ask for {what} only", included=False, estimate=True)

    t = site.get("temperature")
    if isinstance(t, (int, float)) and t >= 0.7 and short:
        ops = []
        if site.get("temperature_span"):
            ops = [(site["file"], fixes.span(site["temperature_span"], "0"))]
        add("hot_temperature", "Random answers on a decision",
            f"Temperature {t} makes {what} change from run to run, which causes re-checks and retries. Use 0 for decisions.",
            "code_change", "advice", ops, lambda p: None, line, "Use temperature 0 for decisions", included=False)

    if site.get("history_in_prompt"):
        add("history_in_prompt", "Sends the whole chat history for a tiny task",
            "The full conversation is turned into JSON and sent on every turn, just to make a short title. Make the title once, from the first message.",
            "less_context", "advice", [], lambda p: p.update(input_tokens=min(p["input_tokens"], 300)), line,
            "Make the title once, from the first message", included=False, estimate=True)

    if kind == "free_text" and task and model and not fan:
        target = catalog.smaller_model(model)
        if target and (catalog.is_reasoning_model(model) or size_class(model) == "large"):
            add("model_overkill", "Frontier model for a routine text task",
                f"{model} is used for {task}. A small model ({target}) does this well. Check a few outputs side by side before switching.",
                "model_change", "advice", [], lambda p, t=target: p.update(model=t), line, f"Use {target} for {task}", included=False)

    if kind == "vector" and model and "large" in model:
        target = catalog.smaller_model(model)
        if target:
            add("embedding_model", "Large embedding model for search",
                f"{model} costs about 6 times more than {target}, which is usually close enough for matching help articles.",
                "model_change", "advice", [], lambda p, t=target: p.update(model=t), line, f"Use {target}", included=False)

    if any(h in site["file"].lower() for h in ("nightly", "cron", "batch", "scripts/", "jobs/")) and kind != "vector":
        add("batch_job", "Background job paying full price",
            "This runs in a scheduled job where nobody waits for the answer. Send it through the provider's Batch API, "
            "which costs half as much, and reuse yesterday's results instead of recomputing everything.",
            "code_change", "advice", [], lambda p: p.update(batch=True), line, "Use the Batch API for the nightly job",
            included=False, estimate=True)


WRAPPER_ISSUES = {
    "broad_retry": ("Retries every error, including ones that can't succeed",
                    "This wrapper retries any exception with a fixed short pause. A wrong key or a bad request fails the same way every time, "
                    "so those retries are wasted calls. Retry only rate limits and server errors, with a growing wait."),
    "client_per_call": ("Creates a new API client on every call",
                        "A new client means a new connection and setup each time. Create one client when the module loads and reuse it."),
    "no_timeout": ("No timeout on the HTTP call",
                   "Without a timeout a stuck request hangs the worker, and the retry loop can stack up. Set a timeout."),
    "huge_default_limit": ("Very high default answer limit",
                           "Every caller can get up to {value:,} output tokens unless it passes its own limit. Set a small default and let callers raise it."),
    "hot_default": ("Random answers by default",
                    "Temperature {value} is the default for every caller, including ones that make decisions. Default to 0."),
}


def wrapper_rules(site, add):
    for issue in site.get("wrapper_issues", []):
        title, detail = WRAPPER_ISSUES[issue["kind"]]
        detail = detail.format(**issue) if "{" in detail else detail
        share = 0.03 if issue["kind"] == "broad_retry" else 0.0
        add(f"wrapper_{issue['kind']}", title,
            detail + f" It affects every call through {site['function']}() ({', '.join(site.get('callers') or []) or 'its callers'}).",
            "code_change", "advice", [], lambda p, k=share: p.update(calls=p["calls"] * (1 - k)), [issue["line"]], title,
            included=False, estimate=True)


def build_group(site, module, modules, ctx):
    """ctx: usage, usage_source, overrides, ledger, options, default_calls."""
    u = ctx["usage"].get(site["id"], {})
    before = baseline_profile(site, u, ctx["usage_source"], ctx["overrides"].get(site["id"]), ctx["default_calls"],
                              ctx.get("traffic", {}).get(site["id"]))
    opts = ctx["options"].get(site["id"], {})
    model = before["model"]
    answer = site["answer"]
    findings = []
    recorded = u.get("recorded_requests", 0)

    def add(rule, title, detail, kind, proof, ops, transform, lines, bullet, included=True, note=None, estimate=False):
        if included and ctx.get("linked") and kind == "code_change":
            included, proof = False, "advice"
            note = "Prune never runs code it downloads, so changes that need your tests stay as advice for linked repos."
        if included and site["file"].endswith(".ipynb"):
            included, proof = False, "advice"
            note = "This is a notebook, so the change is shown as advice. Copy it into the cell by hand."
        findings.append({
            "rule": rule, "title": title, "detail": detail, "fix_kind": kind, "fix_kind_label": FIX_KINDS[kind],
            "proof": proof, "ops": ops, "transform": transform, "lines": lines, "bullet": bullet,
            "included": included, "note": note, "estimate": estimate,
        })

    # Why a change that alters answers can't be proven here.
    no_history_note = (
        "Proving this needs real past requests from the running app, and a GitHub link only includes the code, so it stays a suggestion."
        if ctx.get("linked") else
        "Proving this needs real past requests to compare answers, and none are saved for this call yet, so it stays a suggestion."
    )
    via = site.get("via")
    model_line = site["kw_lines"].get("model")
    multiline_call = model_line is not None and model_line != site["line"]
    kw_indent = fixes.indent_of(_line(module, model_line)) if model_line else ""

    if site.get("wrapper"):
        wrapper_rules(site, add)

    # 1. AI doing work plain code could do
    pc = None if site.get("wrapper") else site["plain_code"]
    if pc:
        ind = fixes.indent_of(_line(module, site["line"]))
        tail = "None" if pc["sentinel"] else '""'
        ops = [
            (site["file"], fixes.replace_lines(site["line"], site["function_end"], [
                f'{ind}match = re.search(r"{pc["pattern"]}", {site["user_var"]})',
                f"{ind}return match.group(0) if match else {tail}",
            ])),
            (site["file"], fixes.ensure_import(module, "import re")),
        ]
        add("plain_code", "AI doing work plain code could do",
            f"The prompt asks the model to extract an ID shaped like {pc['example']}. A regular expression does that "
            f"exactly, instantly and for free.", "code_change", "tests", ops,
            lambda p: p.update(calls=0), [site["line"]],
            f"Replace the AI call with a regular expression for {pc['example']}-style IDs: no AI needed")

    if not pc and not site.get("wrapper"):
        # 2. duplicate calls (edit lives in the caller)
        dup = site["duplicates"]
        if dup:
            caller_mod = modules[dup["file"]]
            share = u.get("duplicate_share", 0.5)
            first = dup["lines"][0]
            ops = []
            if dup["assign"]:
                var, a_line = dup["assign"]["var"], dup["assign"]["line"]
                if a_line > first:
                    first_text = _line(caller_mod, first)
                    ops.append((dup["file"], fixes.replace_lines(first, first, [
                        f"{fixes.indent_of(first_text)}{var} = {dup['expr']}",
                        first_text.replace(dup["expr"], var),
                    ])))
                    ops.append((dup["file"], fixes.delete_line(a_line)))
                else:
                    for ln in dup["lines"]:
                        if ln != a_line:
                            ops.append((dup["file"], fixes.replace_lines(ln, ln, [_line(caller_mod, ln).replace(dup["expr"], var)])))
            add("duplicate_call", "Duplicate calls",
                f"{dup['caller']}() calls {dup['expr']} {len(dup['lines'])} times with the same input. "
                f"Call it once and reuse the answer.", "same_answer", "tests", ops,
                lambda p, s=share: p.update(calls=p["calls"] * (1 - s)), dup["lines"],
                f"Reuse one {site['function']}() result instead of calling it twice: same answer",
                estimate="duplicate_share" not in u)

        # 3. model called on a timer
        tm = site["timer"]
        if tm and not any("cache" in d for d in site["decorators"]):
            share = u.get("unique_request_share", 0.2)
            every = f"every {tm['seconds'] // 60} minutes" if tm.get("seconds") else "on a timer"
            ind = fixes.indent_of(_line(module, site["function_line"]))
            ops = [
                (site["file"], fixes.insert_before(site["function_line"], [f"{ind}@functools.lru_cache(maxsize=4096)  # same input, same summary: reuse it"])),
                (site["file"], fixes.ensure_import(module, "import functools")),
            ]
            add("timer", "Model called on a timer",
                f"{' → '.join(c + '()' for c in tm['chain'])} runs {every} ({tm['how']}) and re-sends the same inputs each time. "
                f"Usage data: only {share * 100:.1f}% of these requests are unique. Remember answers for inputs already seen.",
                "same_answer", "tests", ops, lambda p, s=share: p.update(calls=p["calls"] * s), [tm["line"]],
                f"Stop re-summarizing the same inputs {every}: only {share * 100:.1f}% are new",
                estimate="unique_request_share" not in u)

        # 4. retry storms and agents with no step limit (share the loop rewrite)
        rs, ag = site["retry_storm"], site["agent_unbounded"]
        if rs or ag:
            loop = ag or rs
            while_text = _line(module, loop["while_line"])
            w_ind = fixes.indent_of(while_text)
            var = "_step" if ag else "_attempt"
            bound = "MAX_STEPS" if ag else "5"
            loop_ops = [
                (site["file"], fixes.replace_lines(loop["while_line"], loop["while_line"], [f"{w_ind}for {var} in range({bound}):"])),
                (site["file"], fixes.insert_after(loop["end_line"], [f'{w_ind}raise RuntimeError(f"stopped after {{{bound}}} attempts without an answer")'])),
            ]
            if ag:
                ops = loop_ops + [(site["file"], fixes.insert_before(site["function_line"], [f"MAX_STEPS = {MAX_AGENT_STEPS}  # hard cap on agent steps per request", "", ""]))]
                share = u.get("runaway_call_share", 0.15)
                add("agent_unbounded", "AI agent with no step or token limit",
                    f"The agent loops with `while True:` and stops only when the model decides to. Usage data: "
                    f"{share * 100:.0f}% of its calls come from runaway conversations. Cap it at {MAX_AGENT_STEPS} steps.",
                    "code_change", "tests", ops, lambda p, s=share: p.update(calls=p["calls"] * (1 - s)),
                    [loop["while_line"]], f"Cap the agent at {MAX_AGENT_STEPS} steps: runaway loops stop billing",
                    estimate="runaway_call_share" not in u)
            if rs:
                c_line = rs["continue_line"]
                c_ind = fixes.indent_of(_line(module, c_line))
                ops = ([] if ag else loop_ops) + [
                    (site["file"], fixes.replace_lines(c_line, c_line, [
                        f"{c_ind}time.sleep(min(2 ** {var}, 30))  # back off instead of hammering the API",
                        f"{c_ind}continue",
                    ])),
                    (site["file"], fixes.ensure_import(module, "import time")),
                ]
                share = u.get("retry_call_share", 0.1)
                add("retry_storm", "Retry storm",
                    f"Any error jumps straight back to the AI call with no wait and no limit (line {c_line}), so an outage "
                    f"turns into thousands of paid retries. Usage data: {share * 100:.0f}% of calls are instant retries.",
                    "code_change", "tests", ops, lambda p, s=share: p.update(calls=p["calls"] * (1 - s)),
                    [rs["handler_line"], c_line], "Back off between retries with a limit: no more retry storms",
                    estimate="retry_call_share" not in u)

        # 5. full chat history resent every turn
        mv = site["messages_var"]
        if mv and site["history_appended"] and not ag and not site["has_tools"]:
            v = mv["name"]
            prefix = u.get("cacheable_prefix_tokens", (site["system"] or {}).get("tokens", 0))
            ops = [(site["file"], fixes.span(mv["span"], f"{v}[:1] + {v}[-{HISTORY_KEEP}:]"))] if mv.get("span") else []
            can_replay = recorded > 0
            add("full_history", "Full chat history resent every turn",
                f"`{v}` grows by two messages per turn and the whole list is sent every time. Keep the system prompt "
                f"plus the last {HISTORY_KEEP} messages.", "less_context", "replay" if can_replay else "advice", ops,
                lambda p, pre=prefix: p.update(input_tokens=pre + (p["input_tokens"] - pre) * EST_HISTORY_KEEP_SHARE),
                [mv["span"]["line"] if mv.get("span") else site["line"]], f"Send only the last {HISTORY_KEEP} chat messages",
                included=can_replay,
                note=None if can_replay else no_history_note,
                estimate=True)

        # 6. repeated prompt that isn't cached
        sysp = site["system"]
        prefix = u.get("cacheable_prefix_tokens") or (sysp or {}).get("tokens", 0)
        if sysp and sysp["constant"] and not site["cache_marked"] and prefix >= catalog.MIN_CACHEABLE_TOKENS:
            name = sysp["name"] or "the system prompt"
            ops = []
            if site["provider"].startswith("Anthropic") and sysp.get("span"):
                ops = [(site["file"], fixes.span(sysp["span"], f'[{{"type": "text", "text": {name}, "cache_control": {{"type": "ephemeral"}}}}]'))]
            elif site["provider"].startswith(("OpenAI", "LiteLLM")) and multiline_call:
                ops = [(site["file"], fixes.insert_after(model_line, [f'{kw_indent}prompt_cache_key="{site["function"]}",  # {name} never changes: marked as cacheable']))]
            words = len(sysp["text"].split())
            add("uncached_prompt", "Repeated prompt that isn't cached",
                f"{name} (~{words:,} words, ~{prefix:,} tokens) is identical on every call but sent fresh each time. "
                f"Providers discount reused prompt text (prompt caching). Prune assumes a {catalog.CACHE_HIT_RATE:.0%} cache hit rate.",
                "same_answer" if ops else "advice", "tests" if ops else "advice", ops,
                lambda p, pre=prefix: p.update(cached_tokens=min(pre, p["input_tokens"]) * catalog.CACHE_HIT_RATE),
                [sysp["line"]], f"Cache {name}: same answers, lower cost", included=bool(ops), estimate=True)

        # 7. answer limit far above what's read
        need = needed_tokens(answer)
        mt = site["max_tokens"]
        too_high = need and (mt is None or mt > (4 if answer["kind"] != "free_text" else 1.5) * need)
        if too_high and not ag:
            param = site["max_tokens_param"]
            if site["max_tokens_span"]:
                ops = [(site["file"], fixes.span(site["max_tokens_span"], str(need)))]
            elif via and site.get("call_span") and "max_tokens" in (site.get("wrapper_params") or ()):
                ops = [(site["file"], fixes.add_kwarg(site["call_span"], module.lines, "max_tokens", str(need)))]
            elif not via and multiline_call and not site["provider"].startswith("Gemini"):
                ops = [(site["file"], fixes.insert_after(model_line, [f"{kw_indent}{param}={need},"]))]
            else:
                ops = []
            if site.get("reasons_first"):
                ops = []  # the prompt asks for analysis first: a cap would cut off the answer
            reads = {"label": "one word", "boolean": "yes or no", "number": "a number"}.get(answer["kind"]) or (
                f"{answer['display_chars']} characters" if answer["display_chars"] else "a short value")
            expected = 3 if answer["kind"] != "free_text" else need
            add("max_tokens_high", "Answer limit far above what's read",
                f"The call allows {'an unlimited' if mt is None else f'a {mt:,}-token'} answer, but the code only reads {reads}. "
                f"{'Estimated' if before['estimate'] else 'Usage data:'} answers average {before['output_tokens']:.0f} tokens."
                + (" The prompt asks for analysis before the answer, so ask for the answer alone first, then cap it." if site.get("reasons_first") else ""),
                "same_answer" if ops else "advice", "tests" if ops else "advice", ops,
                lambda p, e=expected: p.update(output_tokens=min(p["output_tokens"], e)),
                [site["max_tokens_span"]["line"] if site["max_tokens_span"] else site["line"]],
                f"Cap answer length at {need} tokens: the code only reads {reads}", included=bool(ops))

        # 8. model too big for the task
        target = catalog.smaller_model(model or "")
        if answer["kind"] in ("label", "number", "boolean") and target and size_class(model) in ("large", "medium") and not site.get("fanout"):
            labels = len(answer["labels"]) or None
            ev = ctx["ledger"].match(answer["kind"], labels, model, target)
            replay = opts.get("replay")
            guard = opts.get("guard") if (opts.get("guard") or {}).get("enabled") else None
            if recorded:
                proof, included, note = "replay", True, None
                if replay and replay.get("decision") == "rejected":
                    included, note = False, "You rejected the replay, so the model switch is dropped (and the ledger learned from it)."
            elif ev and ev["confidence"] == "high":
                proof, included = "ledger", True
                note = (f"High confidence without replay: the ledger has {ev['entries']} accepted replay(s) of similar "
                        f"tasks, {ev['matched']:,}/{ev['total']:,} matched ({ev['match_rate'] * 100:.1f}%).")
            else:
                proof, included = "advice", False
                note = no_history_note + " Prune hasn't seen a similar switch proven before either."
            if site["model_span"]:
                if guard:
                    uv = site["user_var"] or "text"
                    words = ", ".join(f'"{w}"' for w in guard["keywords"]) + ("," if len(guard["keywords"]) == 1 else "")
                    expr = f'"{model}" if any(w in {uv}.lower() for w in ({words})) else "{target}"'
                else:
                    expr = f'"{target}"'
                ops = [(site["file"], fixes.span(site["model_span"], expr))]
            elif via and site.get("model_param") and site.get("call_span"):
                ops = [(site["file"], fixes.add_kwarg(site["call_span"], module.lines, "model", f'"{target}"'))]
            else:
                ops, included = [], False
                note = "The model name isn't a literal at this call, so Prune can't edit it here."

            def to_small(p, t=target, g=guard, old=model):
                p.update(model=t)
                if g:
                    p.update(guard_model=old, guard_share=g["share"])

            what = {"label": f"{labels} labels", "number": "a number", "boolean": "yes/no"}[answer["kind"]]
            add("model_too_big", "Model too big for the task",
                f"{model} is a {size_class(model)} model, but the code only needs {what}. Prune proposes {target}.",
                "model_change", proof, ops, to_small, [site["model_span"]["line"] if site["model_span"] else site["line"]],
                f"Smaller model ({target})", included=included, note=note)
            findings[-1]["target_model"] = target
            findings[-1]["ledger"] = ev
            findings[-1]["guard"] = guard

        # 9. work that could be batched (advice: needs a code restructure)
        bt = site["batchable"]
        if bt:
            add("batchable", "Work that could be batched",
                f"{bt['caller']}() calls {site['function']}() once per item in a loop in a background job "
                f"({bt['file']}:{bt['line']}). Nothing is waiting on these answers: send them through the provider's "
                f"Batch API, which costs half as much.",
                "advice", "advice", [], lambda p: p.update(batch=True), [bt["line"]],
                "Batch the loop through the Batch API", included=False, estimate=True)

    if via:
        call_site_rules(site, before, add, model, ctx)

    if not findings:
        return None

    # Standalone value of each finding, then the combined after-profile of the included ones.
    for f in findings:
        p = copy.deepcopy(before)
        f["transform"](p)
        f["saved_usd"] = round(costing.monthly_cost(before) - costing.monthly_cost(p), 2)
    after = copy.deepcopy(before)
    order = ["plain_code", "duplicate_call", "timer", "agent_unbounded", "retry_storm", "full_history",
             "uncached_prompt", "max_tokens_high", "model_too_big"]
    for rule in order:
        for f in findings:
            if f["rule"] == rule and f["included"]:
                f["transform"](after)
    advice_profile = copy.deepcopy(after)
    for f in findings:
        if not f["included"]:
            # Advice is worth what it would add on top of the fix, not on top of today's code.
            p = copy.deepcopy(after)
            f["transform"](p)
            f["saved_usd"] = round(costing.monthly_cost(after) - costing.monthly_cost(p), 2)
            f["transform"](advice_profile)

    ops_by_file, advice_ops_by_file = {}, {}
    for f in findings:
        target = ops_by_file if f["included"] else advice_ops_by_file
        for file, op in f["ops"]:
            if op:
                target.setdefault(file, []).append(op)
    findings.sort(key=lambda f: (not f["included"], -f["saved_usd"]))
    replay = opts.get("replay") or {}
    for f in findings:
        f["badge"] = badge_for(f, replay)
    for f in findings:
        f.pop("transform")
        f["ops"] = [op for _, op in f["ops"] if op]

    return {
        "id": site["id"],
        "file": site["file"],
        "function": site["function"],
        "line": site["line"],
        "provider": site["provider"],
        "model": model,
        "site": site,
        "findings": findings,
        "ops_by_file": ops_by_file,
        "advice_ops_by_file": advice_ops_by_file,
        "before": before,
        "after": after,
        "summary": costing.summarize(before, after),
        "advice_extra_usd": round(costing.monthly_cost(after) - costing.monthly_cost(advice_profile), 2),
        "advice_summary": costing.summarize(after, advice_profile),
        "needs_replay": any(f["included"] and f["proof"] == "replay" for f in findings),
        "recorded_requests": recorded,
        "has_edits": bool(ops_by_file),
    }


def badge_for(f, replay):
    """The proof badge for one change, from what kind of change it is and what proved it.

    Same answer: the answer can't change (caching, duplicates, length caps), tests suffice.
    Checked: a smaller model or less context, proven by replay or by the ledger.
    Advice only: anything Prune won't apply on its own.
    """
    if not f["included"]:
        return {"kind": "advice", "label": "Advice only", "detail": ""}
    if f["fix_kind"] in ("model_change", "less_context"):
        if f["proof"] == "ledger" and f.get("ledger"):
            ev = f["ledger"]
            return {"kind": "checked", "label": "Checked", "detail": f"{ev['matched']:,}/{ev['total']:,} from memory"}
        if replay.get("decision") == "accepted":
            return {"kind": "checked", "label": "Checked", "detail": f"{replay['matched']:,}/{replay['total']:,}"}
        return {"kind": "pending", "label": "Check pending", "detail": ""}
    return {"kind": "same", "label": "Same answer", "detail": ""}


def apply_group(group, sources):
    """New sources and diffs for the group's included edits. sources: {path: text}."""
    new, diffs = {}, {}
    for path, ops in group["ops_by_file"].items():
        new[path] = fixes.apply_edits(sources[path], ops)
        diffs[path] = fixes.unified(path, sources[path], new[path])
    return new, diffs
