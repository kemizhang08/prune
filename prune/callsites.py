"""Wrapper-aware call sites and the call graph. Static analysis only.

Real code rarely calls an AI SDK directly from business logic. It calls a small
wrapper (`anthropic_client.message(prompt, max_tokens=8192)`) that calls the SDK with
`model=model`. Looking only at the SDK line, the model is just a parameter. So:

1. A function that makes a raw AI call, takes parameters and is called from another
   module is a *wrapper*. A function that only forwards to a wrapper (for example
   asking five models in a loop) is a *composite wrapper* with a fan-out.
2. Every call to a wrapper becomes its own call site. The model, limits, temperature,
   reasoning settings and prompts are traced from the arguments actually passed,
   falling back to the wrapper's defaults (resolved through config modules).
3. The call graph counts AI calls per run of each entry point (API routes, scripts),
   through loops whose length can be read statically, and finds repeated work.
"""

import ast
import re
from collections import Counter

from . import catalog
from .analyzer import attr_chain, est_tokens, kwarg, names_in

DYNAMIC_TEXT_TOKENS = 300  # a ticket, a message, a question: unknown user text
DEFAULT_LOOP = 1  # loop over something whose length can't be read: counted once in totals, flagged as per-item
ROUTE_DECORATORS = ("get", "post", "put", "patch", "delete", "route", "api_route", "websocket")
PROMPT_PARAMS = ("prompt", "text", "input", "content", "contents", "question", "query", "message", "user_prompt")
SYSTEM_PARAMS = ("system", "system_prompt", "instructions", "system_instruction")
HISTORY_PARAMS = ("history", "messages", "chat_history", "conversation")
REASONING_CUES = ("step by step", "explain", "analysis", "paragraph", "justify", "reasoning", "in great detail", "think deeply")
CLIENT_CLASSES = {"OpenAI", "AsyncOpenAI", "Anthropic", "AsyncAnthropic", "Client", "Groq", "Together", "Mistral"}


def _src(module, node):
    return module.segment(node) if node is not None else ""


class Graph:
    def __init__(self, project, raw_sites):
        self.p = project
        self.raw = raw_sites
        self.funcs = {}  # key -> (module, FunctionDef)
        self.key_of = {}  # id(FunctionDef) -> key
        for m in project.modules.values():
            for node in m.tree.body:
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    key = f"{m.path}::{node.name}"
                    self.funcs[key] = (m, node)
                    self.key_of[id(node)] = key
        self.memo_est = {}
        self.edges = {}  # caller key -> list of (callee key, call node)
        self.callers = {}  # callee key -> set of caller keys
        for key, (m, fn) in self.funcs.items():
            for n in ast.walk(fn):
                if isinstance(n, ast.Call):
                    tgt = self.resolve_function(m, n.func)
                    if tgt:
                        self.edges.setdefault(key, []).append((tgt, n))
                        self.callers.setdefault(tgt, set()).add(key)
        # module-level code (e.g. `if __name__ == "__main__": main()`) also calls functions
        self.main_called = set()
        for m in self.p.modules.values():
            for node in m.tree.body:
                if isinstance(node, ast.If) and "__main__" in _src(m, node.test):
                    for n in ast.walk(node):
                        if isinstance(n, ast.Call):
                            tgt = self.resolve_function(m, n.func)
                            if tgt:
                                self.main_called.add(tgt)

    # ----- resolution ---------------------------------------------------------

    def module_alias(self, module, name):
        """`config` in `from app import config` -> the app/config.py Module."""
        if name in module.imports:
            pkg, attr = module.imports[name]
            return self.p.by_dotted.get(f"{pkg}.{attr}")
        if name in module.mod_aliases:
            return self.p.by_dotted.get(module.mod_aliases[name])
        return None

    def resolve_function(self, module, func):
        if isinstance(func, ast.Name):
            if f"{module.path}::{func.id}" in self.funcs:
                return f"{module.path}::{func.id}"
            if func.id in module.imports:
                pkg, name = module.imports[func.id]
                other = self.p.by_dotted.get(pkg)
                if other and f"{other.path}::{name}" in self.funcs:
                    return f"{other.path}::{name}"
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            other = self.module_alias(module, func.value.id)
            if other and f"{other.path}::{func.attr}" in self.funcs:
                return f"{other.path}::{func.attr}"
        return None

    def value(self, module, node, fn=None, depth=0):
        """A Python value for constant expressions, else None."""
        if node is None or depth > 6:
            return None
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, (ast.List, ast.Tuple)):
            vals = [self.value(module, e, fn, depth + 1) for e in node.elts]
            return vals if all(v is not None for v in vals) else None
        if isinstance(node, ast.Dict):
            out = {}
            for k, v in zip(node.keys, node.values):
                kv = self.value(module, k, fn, depth + 1) if k is not None else None
                vv = self.value(module, v, fn, depth + 1)
                if kv is None or vv is None:
                    return None
                out[kv] = vv
            return out
        if isinstance(node, ast.Name):
            if fn is not None:
                local = self.local_assign(fn, node.id, node.lineno)
                if local is not None:
                    return self.value(module, local, fn, depth + 1)
                names, defaults = self.params(fn)
                if node.id in defaults:  # e.g. max_attempts: int = 6
                    return self.value(module, defaults[node.id], None, depth + 1)
            if node.id in module.values:
                return module.values[node.id]
            if node.id in module.imports:
                pkg, name = module.imports[node.id]
                other = self.p.by_dotted.get(pkg)
                if other and name in other.values:
                    return other.values[name]
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
            other = self.module_alias(module, node.value.id)
            if other and node.attr in other.values:
                return other.values[node.attr]
        s = module.literal_str(node)
        if s is not None and "{…}" not in s:
            return s
        return None

    def local_assign(self, fn, name, before_line):
        best = None
        for n in ast.walk(fn):
            if isinstance(n, ast.Assign) and n.lineno < before_line:
                for t in n.targets:
                    if isinstance(t, ast.Name) and t.id == name and (best is None or n.lineno > best.lineno):
                        best = n
        return best.value if best is not None else None

    def params(self, fn):
        a = fn.args
        pos = [x.arg for x in a.posonlyargs + a.args]
        defaults = dict(zip(pos[len(pos) - len(a.defaults):], a.defaults))
        for x, d in zip(a.kwonlyargs, a.kw_defaults):
            if d is not None:
                defaults[x.arg] = d
        return pos + [x.arg for x in a.kwonlyargs], defaults

    def bind(self, fn, call):
        """Parameter name -> argument expression for a call to fn."""
        names, _ = self.params(fn)
        out = {}
        for name, arg in zip(names, call.args):
            if not isinstance(arg, ast.Starred):
                out[name] = arg
        for kw in call.keywords:
            if kw.arg:
                out[kw.arg] = kw.value
        return out

    # ----- text size estimates ----------------------------------------------------

    def est(self, module, node, fn, depth=0):
        """(tokens, static tokens, literal texts) for a prompt expression."""
        if node is None:
            return 0, 0, []
        if depth > 8:
            return DYNAMIC_TEXT_TOKENS, 0, []
        if isinstance(node, ast.Constant):
            if isinstance(node.value, str):
                t = est_tokens(node.value)
                return t, t, [node.value]
            return 0, 0, []
        if isinstance(node, ast.JoinedStr):
            tot = st = 0
            texts = []
            for v in node.values:
                a, b, c = self.est(module, v.value if isinstance(v, ast.FormattedValue) else v, fn, depth + 1)
                tot, st, texts = tot + a, st + b, texts + c
            return tot, st, texts
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            a = self.est(module, node.left, fn, depth + 1)
            b = self.est(module, node.right, fn, depth + 1)
            return a[0] + b[0], a[1] + b[1], a[2] + b[2]
        if isinstance(node, ast.Name):
            if fn is not None:
                names, _ = self.params(fn)
                local = self.local_assign(fn, node.id, node.lineno)
                if local is not None:
                    return self.est(module, local, fn, depth + 1)
                if node.id in names:
                    return DYNAMIC_TEXT_TOKENS, 0, []
            v = self.value(module, node)
            if isinstance(v, str):
                t = est_tokens(v)
                return t, t, [v]
            return DYNAMIC_TEXT_TOKENS, 0, []
        if isinstance(node, ast.Attribute):
            v = self.value(module, node)
            if isinstance(v, str):
                t = est_tokens(v)
                return t, t, [v]
            return DYNAMIC_TEXT_TOKENS, 0, []
        if isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Attribute) and f.attr == "format":
                tot, st, texts = self.est(module, f.value, fn, depth + 1)
                for a in list(node.args) + [k.value for k in node.keywords]:
                    x = self.est(module, a, fn, depth + 1)
                    tot, st, texts = tot + x[0], st + x[1], texts + x[2]
                return tot, st, texts
            if isinstance(f, ast.Attribute) and f.attr in ("strip", "lower", "upper", "replace", "rstrip", "lstrip"):
                return self.est(module, f.value, fn, depth + 1)
            data = self.data_file_arg(node)
            if data:
                t = est_tokens("x" * data["size"])
                return t, t, []
            tgt = self.resolve_function(module, f)
            if tgt:
                key = (tgt, depth)
                if key not in self.memo_est:
                    self.memo_est[key] = (DYNAMIC_TEXT_TOKENS, 0, [])  # recursion guard
                    m2, fn2 = self.funcs[tgt]
                    best = (DYNAMIC_TEXT_TOKENS, 0, [])
                    for r in ast.walk(fn2):
                        if isinstance(r, ast.Return) and r.value is not None:
                            x = self.est(m2, r.value, fn2, depth + 1)
                            if x[0] > best[0]:
                                best = x
                    self.memo_est[key] = best
                return self.memo_est[key]
            ch = attr_chain(f) or []
            if ch[-2:] == ["json", "dumps"]:
                return 500, 0, []
            return DYNAMIC_TEXT_TOKENS, 0, []
        return DYNAMIC_TEXT_TOKENS, 0, []

    def data_file_arg(self, call):
        for a in call.args:
            if isinstance(a, ast.Constant) and isinstance(a.value, str):
                d = self.p.data.get(a.value.rsplit("/", 1)[-1])
                if d:
                    return d
        return None

    def iter_len(self, module, node, fn, depth=0):
        """How many items a loop runs over, if it can be read from the code."""
        if node is None or depth > 6:
            return None
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            return len(node.elts)
        if isinstance(node, ast.Call):
            ch = attr_chain(node.func) or []
            if ch == ["range"]:
                vals = [self.value(module, a, fn) for a in node.args]
                if vals and all(isinstance(v, int) for v in vals):
                    return max(0, vals[-1] - (vals[0] if len(vals) > 1 else 0))
                return None
            if ch[-1:] in (["values"], ["items"], ["keys"]) and isinstance(node.func, ast.Attribute):
                return self.iter_len(module, node.func.value, fn, depth + 1)
            if ch[-1:] == ["enumerate"] and node.args:
                return self.iter_len(module, node.args[0], fn, depth + 1)
            data = self.data_file_arg(node)
            if data:
                return data.get("items")
            if node.args and ch[-1:] in (["loads"], ["load"]):
                return self.iter_len(module, node.args[0], fn, depth + 1)
            tgt = self.resolve_function(module, node.func)
            if tgt:
                m2, fn2 = self.funcs[tgt]
                for r in ast.walk(fn2):
                    if isinstance(r, ast.Return) and r.value is not None:
                        n = self.iter_len(m2, r.value, fn2, depth + 1)
                        if n:
                            return n
            return None
        if isinstance(node, ast.Name) and fn is not None:
            local = self.local_assign(fn, node.id, node.lineno)
            if local is not None:
                return self.iter_len(module, local, fn, depth + 1)
        v = self.value(module, node, fn)
        if isinstance(v, (list, tuple, dict, set)):
            return len(v)
        return None

    # ----- loops around a call ---------------------------------------------------

    def loops(self, module, call, fn):
        """Loops between a call and its function: [{kind, count, line, iter, var}]."""
        out = []
        node, p = call, getattr(call, "_parent", None)

        def exits_early(loop):
            # A retry or find-first loop returns or breaks on success, so it usually runs once.
            return any(isinstance(n, (ast.Return, ast.Break)) for b in loop.body for n in ast.walk(b))

        while p is not None and p is not fn:
            if isinstance(p, (ast.For, ast.AsyncFor)) and node is not p.iter:
                out.append({"kind": "for", "count": self.iter_len(module, p.iter, fn), "line": p.lineno,
                            "iter": _src(module, p.iter), "var": _src(module, p.target), "node": p,
                            "early_exit": exits_early(p)})
            elif isinstance(p, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
                for g in p.generators:
                    if node is not g.iter:
                        out.append({"kind": "comprehension", "count": self.iter_len(module, g.iter, fn), "line": p.lineno,
                                    "iter": _src(module, g.iter), "var": _src(module, g.target), "node": p})
            elif isinstance(p, ast.While):
                bounded = isinstance(p.test, ast.Compare) and any(isinstance(o, (ast.Lt, ast.LtE, ast.Gt, ast.GtE)) for o in p.test.ops)
                forever = isinstance(p.test, ast.Constant) and p.test.value is True
                out.append({"kind": "while", "count": None, "line": p.lineno, "iter": _src(module, p.test), "var": "",
                            "node": p, "unbounded": not bounded, "in_test": node is p.test, "forever": forever})
            node, p = p, getattr(p, "_parent", None)
        return out

    @staticmethod
    def multiplier(loops):
        """Calls per run in the usual case. Retry loops succeed first time; `while <check>` loops
        usually don't repeat (only the check in the condition runs); `while True` runs at least once."""
        mult, estimated, unbounded = 1, False, False
        for lp in loops:
            if lp["kind"] == "while":
                unbounded = unbounded or lp.get("unbounded", False)
                if not lp.get("in_test") and not lp.get("forever"):
                    mult = 0
                continue
            if lp.get("early_exit"):
                continue
            if lp["count"] is None:
                mult *= DEFAULT_LOOP
                estimated = True
            else:
                mult *= max(lp["count"], 1)
        return mult, estimated, unbounded

    # ----- wrappers ----------------------------------------------------------------

    def find_wrappers(self):
        by_fn = {}
        for s in self.raw:
            key = f"{s['file']}::{s['function']}"
            if key in self.funcs:
                by_fn.setdefault(key, []).append(s)
        wrappers = {}
        for key, sites in by_fn.items():
            m, fn = self.funcs[key]
            names, _ = self.params(fn)
            outside = {c for c in self.callers.get(key, ()) if c.split("::")[0] != m.path}
            if names and outside:
                wrappers[key] = {"key": key, "module": m, "fn": fn, "sites": sites, "fanout": None, "inner": None}
        # Composite wrappers: forward to a wrapper, optionally across several models.
        for _ in range(3):
            added = False
            for key, (m, fn) in self.funcs.items():
                if key in wrappers or key in by_fn:
                    continue
                names, _ = self.params(fn)
                outside = {c for c in self.callers.get(key, ()) if c.split("::")[0] != m.path}
                if not names or not outside:
                    continue
                for tgt, call in self.edges.get(key, []):
                    if tgt not in wrappers or not (names_in(call) & set(names)):
                        continue
                    fan = None
                    for lp in self.loops(m, call, fn):
                        models = self.value(m, lp["node"].generators[0].iter if lp["kind"] == "comprehension" else lp["node"].iter, fn)
                        bound = self.bind(wrappers[tgt]["fn"], call)
                        mexpr = bound.get("model")
                        if isinstance(models, list) and mexpr is not None and _src(m, mexpr) == lp["var"]:
                            fan = [str(x) for x in models]
                    if not fan:
                        continue  # only a loop over several models makes a forwarding function a wrapper
                    wrappers[key] = {"key": key, "module": m, "fn": fn, "sites": wrappers[tgt]["sites"], "fanout": fan,
                                     "inner": (tgt, call)}
                    added = True
                    break
            if not added:
                break
        self.wrappers = wrappers
        return wrappers

    def raw_kw(self, site):
        return site.get("_kw", {})

    def effective(self, w, call_module, call, caller_fn):
        """Trace one call to wrapper w into effective model, limits and prompt expressions."""
        chain = []  # (module, fn, bound args) outermost first
        cur, cur_call, cur_mod, cur_fn = w, call, call_module, caller_fn
        while True:
            chain.append((cur, self.bind(cur["fn"], cur_call), cur_mod, cur_fn))
            if not cur["inner"]:
                break
            tgt, inner_call = cur["inner"]
            cur_mod, cur_fn, cur_call, cur = cur["module"], cur["fn"], inner_call, self.wrappers[tgt]

        raw = cur["sites"][0]
        kw = raw.get("_kw", {})

        def trace(expr, level):
            """Follow a parameter outwards to the expression the caller actually passed."""
            while level >= 0:
                wr, bound, mod, fn_ctx = chain[level]
                inner_mod, inner_fn = wr["module"], wr["fn"]
                if isinstance(expr, ast.Name):
                    names, defaults = self.params(inner_fn)
                    if expr.id in names:
                        if expr.id in bound:
                            expr = bound[expr.id]
                            if level == 0:
                                return expr, mod, fn_ctx
                            level -= 1
                            continue
                        return defaults.get(expr.id), inner_mod, inner_fn
                return expr, inner_mod, inner_fn
            return expr, call_module, caller_fn

        def resolve(name):
            node = kw.get(name)
            if node is None:
                return None, None, None
            return trace(node, len(chain) - 1)

        out = {}
        for k in ("model", "max_tokens", "temperature", "reasoning_effort", "thinking", "system", "n"):
            out[k] = resolve(k)
        # The prompt and history parameters of the outermost wrapper, as passed by the caller.
        names, defaults = self.params(w["fn"])
        bound = chain[0][1]
        prompt_p = next((n for n in names if n in PROMPT_PARAMS), names[0] if names else None)
        system_p = next((n for n in names if n in SYSTEM_PARAMS), None)
        history_p = next((n for n in names if n in HISTORY_PARAMS), None)
        out["prompt"] = (bound.get(prompt_p), call_module, caller_fn) if prompt_p else (None, None, None)
        if system_p:
            out["system"] = (bound.get(system_p), call_module, caller_fn) if system_p in bound else (defaults.get(system_p), w["module"], w["fn"])
        out["history"] = bound.get(history_p) if history_p else None
        out["params"] = {"model": "model" if "model" in names else None,
                         "max_tokens": "max_tokens" if "max_tokens" in names else None,
                         "temperature": "temperature" if "temperature" in names else None}
        out["raw"] = raw
        out["fanout"] = w["fanout"]
        return out


def expand(project, raw_sites):
    """Replace raw sites inside wrappers with one site per call to the wrapper."""
    g = Graph(project, raw_sites)
    wrappers = g.find_wrappers()
    wrapped_raw = {id(s) for w in wrappers.values() for s in w["sites"]}
    composite_keys = {k for k, w in wrappers.items() if w["inner"]}
    sites = [s for s in raw_sites if id(s) not in wrapped_raw]

    call_sites = []
    for caller, edges in g.edges.items():
        if caller in wrappers:
            continue
        m, fn = g.funcs[caller]
        for tgt, call in edges:
            if tgt in wrappers:
                call_sites.append(_call_site(project, g, m, fn, call, wrappers[tgt]))
    call_sites.sort(key=lambda s: (s["file"], s["line"]))
    sites += call_sites

    # Each wrapper also gets a site for problems inside the wrapper itself.
    for key, w in wrappers.items():
        if key in composite_keys:
            continue
        for raw in w["sites"]:
            raw["wrapper"] = True
            raw["wrapper_issues"] = _wrapper_issues(project, g, w, raw)
            raw["callers"] = sorted({s["function"] for s in call_sites if s["via_key"] == key})
            sites.append(raw)

    seen = set()
    for s in sites:
        if s["id"] in seen:
            s["id"] = f"{s['id']}@{s['line']}"
        seen.add(s["id"])
    _counts(g, sites)
    return sites, g


def _call_site(project, g, m, fn, call, w):
    eff = g.effective(w, m, call, fn)
    raw = eff["raw"]
    rm, rfn = w["module"], w["fn"]

    def val(k):
        node, mod, ctx = eff[k]
        return g.value(mod, node, ctx) if node is not None else None

    model = val("model")
    fanout = eff["fanout"]
    if fanout:
        model = fanout[0]
    max_tokens = val("max_tokens")
    if raw["api"] == "generate_content" and max_tokens is None:
        max_tokens = raw.get("max_tokens")
    thinking = val("thinking")
    p_tok, p_static, p_text = g.est(*_ctx(eff["prompt"]))
    s_tok, s_static, s_text = g.est(*_ctx(eff["system"])) if eff["system"][0] is not None else (0, 0, [])
    text = "\n".join(p_text + s_text)
    static = p_static + s_static
    site = {
        "id": f"{m.path}::{fn.name}",
        "file": m.path,
        "function": fn.name,
        "function_line": fn.lineno,
        "function_end": fn.end_lineno,
        "line": call.lineno,
        "end_line": call.end_lineno,
        "provider": raw["provider"],
        "api": raw["api"],
        "via": f"{w['module'].dotted.rsplit('.', 1)[-1]}.{w['fn'].name}",
        "via_key": w["key"],
        "via_line": raw["line"],
        "via_file": raw["file"],
        "model": model if isinstance(model, str) else None,
        "fanout": fanout,
        "model_span": _kw_span(g, call, "model"),
        "model_param": eff["params"]["model"],
        "call_span": {"line": call.lineno, "col": call.col_offset, "end_line": call.end_lineno, "end_col": call.end_col_offset},
        "max_tokens": max_tokens if isinstance(max_tokens, int) else None,
        "max_tokens_span": _kw_span(g, call, "max_tokens"),
        "max_tokens_param": eff["params"]["max_tokens"] or "max_tokens",
        "temperature": val("temperature"),
        "temperature_span": _kw_span(g, call, "temperature"),
        "reasoning_effort": val("reasoning_effort"),
        "thinking_budget": thinking.get("budget_tokens") if isinstance(thinking, dict) else None,
        "kw_lines": {},
        "system": None,
        "user_var": next(iter(sorted(names_in(eff["prompt"][0]))), None) if eff["prompt"][0] is not None else None,
        "messages_var": None,
        "history_appended": False,
        "cache_marked": raw.get("cache_marked", False),
        "has_tools": raw.get("has_tools", False),
        "decorators": [m.segment(d) for d in fn.decorator_list],
        "prompt_text": text,
        "prompt_tokens": p_tok + s_tok,
        "static_tokens": static,
        "code": "\n".join(m.lines[fn.lineno - 1: fn.end_lineno]),
    }
    if static >= 200:
        sys_name = _src(eff["system"][1], eff["system"][0]) if eff["system"][0] is not None else "the prompt template"
        site["system"] = {"text": text[:4000], "tokens": static, "name": sys_name or "the shared instructions",
                          "constant": True, "line": call.lineno}
    hist = eff["history"]
    if isinstance(hist, ast.Name):
        appended = any(isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in ("append", "extend")
                       and isinstance(n.func.value, ast.Name) and n.func.value.id == hist.id for n in ast.walk(fn))
        if appended:
            site["messages_var"] = {"name": hist.id, "span": None}
            site["history_appended"] = True
    if "json.dumps" in _src(m, eff["prompt"][0]) and any(isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                                                          and n.func.attr == "append" for n in ast.walk(fn)):
        site["history_in_prompt"] = True
    site["answer"] = project._trace_answer(m, call, fn)
    if raw["api"] == "embeddings.create":
        site["answer"] = {"kind": "vector", "labels": [], "display_chars": None, "path": site["answer"]["path"],
                          "summary": "The result is an embedding vector used for similarity search.", "eq_consts": []}
    project._loops(m, call, fn, site)
    loops = g.loops(m, call, fn)
    mult, est_loop, unbounded = Graph.multiplier(loops)
    site["loops"] = [{k: v for k, v in lp.items() if k != "node"} for lp in loops]
    site["per_run"] = mult * (len(fanout) if fanout else 1)
    site["loop_estimated"] = est_loop
    site["timer"] = site["batchable"] = site["duplicates"] = None
    site["plain_code"] = None
    project._plain_code(site)
    site["no_ai_needed"] = _no_ai_needed(m, fn, site, text)
    site["json_retry"] = _json_retry(m, call, fn, loops)
    site["overwritten"] = _overwritten(m, call, fn, loops)
    site["reasons_first"] = any(c in text.lower() for c in REASONING_CUES)
    site["est_input_tokens"] = max(p_tok + s_tok, 50)
    base_out = _est_output({**site, "reasoning_effort": None, "thinking_budget": None}, "")
    site["est_output_tokens"] = _est_output(site, model if isinstance(model, str) else "")
    site["hidden_tokens"] = max(0, site["est_output_tokens"] - base_out)
    site["wrapper_params"] = g.params(w["fn"])[0]
    return site


def _ctx(triple):
    node, mod, fn = triple
    return mod, node, fn


def _kw_span(g, call, name):
    kw = kwarg(call, name)
    if kw and isinstance(kw.value, ast.Constant):
        v = kw.value
        return {"line": v.lineno, "col": v.col_offset, "end_col": v.end_col_offset, "end_line": v.end_lineno}
    return None


def _est_output(site, model):
    kind = site["answer"]["kind"]
    mt = site["max_tokens"]
    if kind == "vector":
        return 0
    if kind in ("label", "boolean", "number"):
        out = 5
    elif kind == "structured":
        out = 120
    else:
        out = 400
    if site["reasons_first"]:
        out = max(out, 600)  # the prompt asks for reasoning before the answer
    if mt:
        out = min(out, mt)
    # Hidden reasoning tokens are billed as output.
    effort = site.get("reasoning_effort")
    if site.get("thinking_budget"):
        out += site["thinking_budget"] // 4
    elif effort == "high":
        out += 2000
    elif effort == "medium" or (model and catalog.is_reasoning_model(model)):
        out += 800
    elif effort == "low":
        out += 200
    return out


NO_AI = [
    ("language", ("what language", "detect the language", "which language"), "A language-detection library (langdetect, fastText) does this offline in microseconds."),
    ("count", ("how many",), "Count it in code with len(). The data is already parsed."),
    ("health", ("reply with the word ok", "respond with ok", "say ok"), "A health check shouldn't call a model. Check the API key and network instead."),
]


def _no_ai_needed(m, fn, site, text):
    low = text.lower()
    for kind, cues, how in NO_AI:
        if any(c in low for c in cues):
            if kind == "count" and not any(w in low for w in ("json", "items", "list", "tickets", "rows", "records")):
                continue
            return {"kind": kind, "how": how}
    if "extract" in low and any(w in low for w in ("email", "order_id", "order id", "order number", "phone")):
        return {"kind": "extract", "how": "Order IDs, emails and amounts follow fixed patterns. A regular expression finds them for free; keep AI only for free-text fields."}
    return None


def _json_retry(m, call, fn, loops):
    for lp in loops:
        if lp["kind"] in ("for", "while"):
            body = lp["node"]
            seg = m.segment(body)
            if "json" in seg and ("JSONDecodeError" in seg or "ValueError" in seg) and "continue" in seg:
                return {"line": lp["line"], "max": lp["count"]}
    return None


def _overwritten(m, call, fn, loops):
    """`summary = ai(...)` inside a loop where only the last answer is kept."""
    par = call._parent
    if not loops or not isinstance(par, ast.Assign) or not isinstance(par.targets[0], ast.Name):
        return None
    var = par.targets[0].id
    loop = loops[0]
    if loop["kind"] != "for":
        return None
    body = loop["node"]
    used_in_loop = any(isinstance(n, ast.Name) and n.id == var and isinstance(n.ctx, ast.Load) for n in ast.walk(body))
    if used_in_loop:
        return None
    quadratic = bool(re.search(r"\[\s*:\s*" + re.escape(loop["var"] or "~~") + r"\s*\+\s*1\s*\]", m.segment(body))) if loop["var"] else False
    return {"var": var, "line": loop["line"], "quadratic": quadratic}


def _wrapper_issues(project, g, w, raw):
    m, fn = w["module"], w["fn"]
    issues = []
    for n in ast.walk(fn):
        if isinstance(n, ast.Call):
            ch = attr_chain(n.func) or []
            if ch and ch[-1] in CLIENT_CLASSES and (len(ch) == 1 or ch[0] in ("anthropic", "openai", "genai", "groq")):
                issues.append({"kind": "client_per_call", "line": n.lineno})
                break
    for n in ast.walk(fn):
        if isinstance(n, (ast.For, ast.While)):
            seg = m.segment(n)
            if "except" in seg and ("except Exception" in seg or "except:" in seg):
                sleeps = [c for c in ast.walk(n) if isinstance(c, ast.Call) and (attr_chain(c.func) or [""])[-1] == "sleep"]
                fixed = all(c.args and isinstance(c.args[0], ast.Constant) and isinstance(c.args[0].value, (int, float)) and c.args[0].value < 1 for c in sleeps)
                if fixed:
                    issues.append({"kind": "broad_retry", "line": n.lineno, "count": g.iter_len(m, n.iter, fn) if isinstance(n, ast.For) else None})
    for n in ast.walk(fn):
        if isinstance(n, ast.Call) and (attr_chain(n.func) or [""])[-1] in ("post", "get") and (attr_chain(n.func) or [""])[0] in ("requests", "httpx"):
            if not kwarg(n, "timeout"):
                issues.append({"kind": "no_timeout", "line": n.lineno})
    mt = raw.get("max_tokens")
    if isinstance(mt, int) and mt >= 8000:
        issues.append({"kind": "huge_default_limit", "value": mt, "line": raw.get("max_tokens_line") or raw["line"]})
    t = raw.get("temperature_default")
    if isinstance(t, (int, float)) and t >= 0.9:
        issues.append({"kind": "hot_default", "value": t, "line": raw["line"]})
    return issues


def _counts(g, sites):
    """AI calls per run of each entry point, repeated work and unbounded loops."""
    direct = {}  # function key -> list of (site, mult, unbounded)
    for s in sites:
        if s.get("wrapper"):
            continue
        key = f"{s['file']}::{s['function']}"
        direct.setdefault(key, []).append(s)
    memo, dup_memo = {}, {}

    def repeats(loops):
        """True when a loop really runs the call many times (not a retry or a `while` check)."""
        return any(lp["kind"] in ("for", "comprehension") and not lp.get("early_exit") for lp in loops)

    def per_run(key, stack=()):
        if key in memo:
            return memo[key]
        if key in stack:
            return Counter()
        total = Counter()
        for s in direct.get(key, []):
            total[s["id"]] += s.get("per_run", 1)
        m, fn = g.funcs.get(key, (None, None))
        for tgt, call in g.edges.get(key, []):
            if tgt in g.wrappers or tgt not in g.funcs:
                continue
            mult, _, _ = Graph.multiplier(g.loops(m, call, fn))
            for sid, c in per_run(tgt, stack + (key,)).items():
                total[sid] += c * mult
        memo[key] = total
        return total

    def reaches(key, stack=()):
        """Site id -> one first-hop name per path, counting only calls outside loops."""
        if key in dup_memo:
            return dup_memo[key]
        if key in stack:
            return {}
        out = {}
        for s in direct.get(key, []):
            if not repeats(s.get("loops", [])):
                out.setdefault(s["id"], []).append(s["function"])
        m, fn = g.funcs.get(key, (None, None))
        for tgt, call in g.edges.get(key, []):
            if tgt in g.wrappers or tgt not in g.funcs or repeats(g.loops(m, call, fn)):
                continue
            for sid, paths in reaches(tgt, stack + (key,)).items():
                out.setdefault(sid, []).extend([tgt.split("::")[1]] * len(paths))
        dup_memo[key] = out
        return out

    def unbounded_from(key, stack=()):
        """Sites reached through a `while` with no limit somewhere below key."""
        out = {}
        if key in stack:
            return out
        m, fn = g.funcs.get(key, (None, None))
        for tgt, call in g.edges.get(key, []):
            if tgt in g.wrappers or tgt not in g.funcs:
                continue
            lps = g.loops(m, call, fn)
            if any(lp.get("unbounded") for lp in lps):
                for sid in per_run(tgt):
                    out.setdefault(sid, {"function": key.split("::")[1], "line": next(lp["line"] for lp in lps if lp.get("unbounded"))})
            for sid, v in unbounded_from(tgt, stack + (key,)).items():
                out.setdefault(sid, v)
        return out

    wrapper_keys = set(g.wrappers)
    entries = []
    for key, (m, fn) in g.funcs.items():
        if key in wrapper_keys:
            continue
        decos = [m.segment(d).lower() for d in fn.decorator_list]
        is_route = any(re.search(r"\.(%s)\(" % "|".join(ROUTE_DECORATORS), d + "(") for d in decos)
        is_job = key in g.main_called
        no_callers = not g.callers.get(key)
        if is_route or is_job or no_callers:
            counts = per_run(key)
            if sum(counts.values()) == 0:
                continue
            entries.append({"key": key, "name": fn.name, "file": m.path, "line": fn.lineno,
                            "kind": "route" if is_route else "job" if is_job else "other",
                            "route": next((d for d in decos if any(f".{r}(" in d for r in ROUTE_DECORATORS)), None),
                            "per_run": dict(counts)})
    by_id = {s["id"]: s for s in sites}
    # Repeated work: report it in the function where the repeat starts, i.e. where the
    # same AI call is reached along two different first steps.
    for key in g.funcs:
        if key in wrapper_keys:
            continue
        for sid, firsts in reaches(key).items():
            if len(firsts) >= 2 and len(set(firsts)) >= 2 and sid in by_id:
                cur = by_id[sid].get("dup_work")
                if not cur or len(firsts) > cur["count"]:
                    by_id[sid]["dup_work"] = {"entry": key.split("::")[1], "count": len(firsts), "via": sorted(set(firsts))}
    for e in entries:
        for sid, v in unbounded_from(e["key"]).items():
            if sid in by_id and not by_id[sid].get("unbounded_via"):
                by_id[sid]["unbounded_via"] = v
    g.entries = entries
