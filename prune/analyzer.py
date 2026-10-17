"""Find AI calls in Python code and trace what the program does with each answer.

Pure static analysis with the standard library's `ast`. No AI is used here.
"""

import ast
import re
from pathlib import Path

from . import catalog

SKIP_DIRS = {"tests", "test", ".venv", "venv", "node_modules", "incoming", "__pycache__", ".git"}
LANGCHAIN_CLASSES = {"ChatOpenAI", "ChatAnthropic", "ChatGoogleGenerativeAI", "ChatLiteLLM", "AzureChatOpenAI", "ChatGroq"}
OPENAI_STYLE_HOSTS = {
    "openrouter": "OpenRouter",
    "groq": "Groq",
    "together": "Together",
    "localhost": "local server",
    "127.0.0.1": "local server",
    "fireworks": "Fireworks",
}
TIMER_DECORATOR_HINTS = ("schedule", "cron", "interval", "periodic", "repeat_every", "every")
JOB_MODULE_HINTS = ("job", "batch", "nightly", "digest", "cron", "worker", "etl")
ID_EXAMPLE = re.compile(r"\b([A-Z]{1,5})-(\d{3,})\b")


def est_tokens(text):
    return max(1, round(len(text) / 4)) if text else 0


def attr_chain(node):
    """`client.chat.completions.create` -> ['client', 'chat', 'completions', 'create']."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Call):
        inner = attr_chain(node.func)
        if inner is None:
            return None
        return inner + ["()"] + parts[::-1]
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return parts[::-1]
    return None


def names_in(node):
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}


def kwarg(call, *names):
    for kw in call.keywords:
        if kw.arg in names:
            return kw
    return None


class Module:
    def __init__(self, rel_path, src):
        self.path = rel_path
        self.dotted = rel_path[:-3].replace("/", ".").removesuffix(".__init__")
        self.src = src
        self.lines = src.splitlines()
        self.tree = ast.parse(src)
        for node in ast.walk(self.tree):
            for child in ast.iter_child_nodes(node):
                child._parent = node
        self.constants = {}  # NAME -> str
        self.const_sets = {}  # NAME -> [str]
        self.imports = {}  # local name -> (module, name)
        self.litellm_names = set()
        self.langchain_vars = {}  # var -> (class, model, model_node, call)
        self.gemini_models = {}  # var -> model name
        self.base_url_label = None
        self.import_lines = []
        self._index()

    def _index(self):
        for node in self.tree.body:
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                self.import_lines.append(node.lineno)
            if isinstance(node, ast.ImportFrom) and node.module:
                for a in node.names:
                    self.imports[a.asname or a.name] = (node.module, a.name)
                    if node.module.startswith("litellm") and a.name in ("completion", "acompletion"):
                        self.litellm_names.add(a.asname or a.name)
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                name = node.targets[0].id
                s = self.literal_str(node.value)
                if s is not None:
                    self.constants[name] = s
                if isinstance(node.value, (ast.Set, ast.Tuple, ast.List)):
                    vals = [e.value for e in node.value.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)]
                    if vals and len(vals) == len(node.value.elts):
                        self.const_sets[name] = vals
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
                ch = attr_chain(node.value.func) or []
                target = node.targets[0].id if isinstance(node.targets[0], ast.Name) else None
                if not target or not ch:
                    continue
                if ch[-1] in LANGCHAIN_CLASSES:
                    m = kwarg(node.value, "model", "model_name")
                    model = m.value.value if m and isinstance(m.value, ast.Constant) else None
                    self.langchain_vars[target] = (ch[-1], model, m.value if m else None, node.value)
                if ch[-1] == "GenerativeModel":
                    arg = node.value.args[0] if node.value.args else (kwarg(node.value, "model_name") or ast.Constant(None)).value
                    if isinstance(arg, ast.Constant):
                        self.gemini_models[target] = arg.value
            if isinstance(node, ast.Call):
                ch = attr_chain(node.func) or []
                if ch and ch[-1] in ("OpenAI", "AsyncOpenAI"):
                    bu = kwarg(node, "base_url")
                    if bu and isinstance(bu.value, ast.Constant) and isinstance(bu.value.value, str):
                        for hint, label in OPENAI_STYLE_HOSTS.items():
                            if hint in bu.value.value:
                                self.base_url_label = label

    def literal_str(self, node):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.JoinedStr):
            out = []
            for v in node.values:
                out.append(v.value if isinstance(v, ast.Constant) else "{…}")
            return "".join(out)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            left, right = self.literal_str(node.left), self.literal_str(node.right)
            if left is not None or right is not None:
                return (left or "{…}") + (right or "{…}")
        return None

    def segment(self, node):
        return ast.get_source_segment(self.src, node) or ""


class Project:
    def __init__(self, files):
        """files: {relative posix path: source}."""
        self.modules = {}
        self.errors = []
        for path, src in sorted(files.items()):
            try:
                self.modules[path] = Module(path, src)
            except SyntaxError as e:
                self.errors.append(f"{path}:{e.lineno}: {e.msg}")
        self.by_dotted = {m.dotted: m for m in self.modules.values()}

    @classmethod
    def from_dir(cls, root):
        root = Path(root)
        files = {}
        for p in root.rglob("*.py"):
            rel = p.relative_to(root)
            if any(part in SKIP_DIRS for part in rel.parts):
                continue
            files[rel.as_posix()] = p.read_text()
        return cls(files)

    def resolve_str(self, module, node):
        """Resolve a string expression to (text, const_name, is_constant)."""
        s = module.literal_str(node)
        if s is not None:
            return s, None, "{…}" not in s
        if isinstance(node, ast.Name):
            if node.id in module.constants:
                return module.constants[node.id], node.id, True
            if node.id in module.imports:
                mod, name = module.imports[node.id]
                other = self.by_dotted.get(mod)
                if other and name in other.constants:
                    return other.constants[name], node.id, True
        return None, getattr(node, "id", None), False

    def resolve_set(self, module, node):
        if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
            vals = [e.value for e in node.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)]
            return vals if vals and len(vals) == len(node.elts) else None
        if isinstance(node, ast.Name):
            return module.const_sets.get(node.id)
        return None

    # ----- AI call detection -------------------------------------------------

    def detect(self, module, call):
        ch = attr_chain(call.func)
        if not ch:
            return None
        if ch[-3:] == ["chat", "completions", "create"]:
            label = module.base_url_label
            return ("OpenAI-style" + (f" ({label})" if label else ""), "chat.completions.create")
        if ch[-2:] == ["responses", "create"]:
            return ("OpenAI", "responses.create")
        if ch[-2:] == ["messages", "create"] and "threads" not in ch:
            return ("Anthropic", "messages.create")
        if ch[-1] == "generate_content":
            return ("Gemini", "generate_content")
        if ch[:2] in (["litellm", "completion"], ["litellm", "acompletion"]) or (
            len(ch) == 1 and ch[0] in module.litellm_names
        ):
            return ("LiteLLM", "completion")
        if len(ch) == 2 and ch[1] in ("invoke", "ainvoke", "predict", "batch") and ch[0] in module.langchain_vars:
            return ("LangChain", f"{module.langchain_vars[ch[0]][0]}.{ch[1]}")
        return None

    def enclosing_function(self, node):
        p = getattr(node, "_parent", None)
        while p is not None:
            if isinstance(p, (ast.FunctionDef, ast.AsyncFunctionDef)):
                return p
            p = getattr(p, "_parent", None)
        return None

    def analyze(self):
        sites = []
        for module in self.modules.values():
            for node in ast.walk(module.tree):
                if isinstance(node, ast.Call):
                    kind = self.detect(module, node)
                    if kind:
                        sites.append(self._site(module, node, kind))
        self._project_context(sites)
        return sites

    def _site(self, module, call, kind):
        fn = self.enclosing_function(call)
        fname = fn.name if fn else "<module>"
        site = {
            "id": f"{module.path}::{fname}",
            "file": module.path,
            "function": fname,
            "function_line": fn.lineno if fn else 1,
            "function_end": fn.end_lineno if fn else len(module.lines),
            "line": call.lineno,
            "end_line": call.end_lineno,
            "provider": kind[0],
            "api": kind[1],
            "model": None,
            "model_span": None,
            "max_tokens": None,
            "max_tokens_span": None,
            "max_tokens_param": "max_tokens",
            "kw_lines": {},
            "system": None,
            "user_var": None,
            "messages_var": None,
            "history_appended": False,
            "cache_marked": False,
            "has_tools": bool(kwarg(call, "tools", "functions")),
            "decorators": [module.segment(d) for d in fn.decorator_list] if fn else [],
            "prompt_text": "",
        }
        self._model_and_limits(module, call, site)
        self._messages(module, call, fn, site)
        site["answer"] = self._trace_answer(module, call, fn)
        self._loops(module, call, fn, site)
        self._plain_code(site)
        site["code"] = "\n".join(module.lines[site["function_line"] - 1 : site["function_end"]])
        return site

    def _span(self, node):
        return {"line": node.lineno, "col": node.col_offset, "end_col": node.end_col_offset, "end_line": node.end_lineno}

    def _model_and_limits(self, module, call, site):
        for kw in call.keywords:
            if kw.arg:
                site["kw_lines"][kw.arg] = kw.value.lineno
        m = kwarg(call, "model")
        ch = attr_chain(call.func) or []
        if m:
            text, name, _ = self.resolve_str(module, m.value)
            site["model"] = text
            if isinstance(m.value, ast.Constant):
                site["model_span"] = self._span(m.value)
        elif site["provider"] == "LangChain":
            cls, model, node, _ = module.langchain_vars[ch[0]]
            site["model"] = model
            if node is not None and isinstance(node, ast.Constant):
                site["model_span"] = self._span(node)
        elif site["provider"] == "Gemini" and ch and ch[0] in module.gemini_models:
            site["model"] = module.gemini_models[ch[0]]
        mt = kwarg(call, "max_tokens", "max_completion_tokens", "max_output_tokens")
        if mt:
            site["max_tokens_param"] = mt.arg
            if isinstance(mt.value, ast.Constant):
                site["max_tokens"] = mt.value.value
                site["max_tokens_span"] = self._span(mt.value)
        if kwarg(call, "prompt_cache_key") or "cache_control" in module.segment(call):
            site["cache_marked"] = True

    def _messages(self, module, call, fn, site):
        prompt_parts = []
        sys_kw = kwarg(call, "system")
        if sys_kw is not None:
            text, name, const = self.resolve_str(module, sys_kw.value)
            if text:
                site["system"] = {"text": text, "tokens": est_tokens(text), "name": name, "constant": const,
                                  "line": sys_kw.value.lineno, "span": self._span(sys_kw.value)}
                prompt_parts.append(text)
        msgs = kwarg(call, "messages")
        if msgs is None and call.args and site["provider"] in ("LangChain", "Gemini"):
            msgs = ast.keyword(arg="messages", value=call.args[0])
        if msgs is None:
            site["prompt_text"] = "\n".join(prompt_parts)
            return
        value = msgs.value
        if isinstance(value, ast.Name):
            site["messages_var"] = {"name": value.id, "span": self._span(value)}
            if fn is not None:
                for node in ast.walk(fn):
                    if (
                        isinstance(node, ast.Call)
                        and isinstance(node.func, ast.Attribute)
                        and node.func.attr in ("append", "extend")
                        and isinstance(node.func.value, ast.Name)
                        and node.func.value.id == value.id
                    ):
                        site["history_appended"] = True
                    if isinstance(node, ast.Assign) and any(
                        isinstance(t, ast.Name) and t.id == value.id for t in node.targets
                    ):
                        for d in ast.walk(node.value):
                            if isinstance(d, ast.Dict):
                                self._read_message_dict(module, d, site, prompt_parts)
        elif isinstance(value, (ast.List, ast.Tuple)):
            for d in value.elts:
                if isinstance(d, ast.Dict):
                    self._read_message_dict(module, d, site, prompt_parts)
        site["prompt_text"] = "\n".join(prompt_parts)

    def _read_message_dict(self, module, d, site, prompt_parts):
        entry = {}
        for k, v in zip(d.keys, d.values):
            if isinstance(k, ast.Constant):
                entry[k.value] = v
        role = entry.get("role")
        role = role.value if isinstance(role, ast.Constant) else None
        content = entry.get("content")
        if content is None:
            return
        text, name, const = self.resolve_str(module, content)
        if role == "system" and site["system"] is None and text:
            site["system"] = {"text": text, "tokens": est_tokens(text), "name": name, "constant": const, "line": content.lineno}
        if text:
            prompt_parts.append(text)
        if role == "user" and site["user_var"] is None:
            vars_ = [n.id for n in ast.walk(content) if isinstance(n, ast.Name)]
            if vars_:
                site["user_var"] = vars_[0]

    # ----- answer tracing ----------------------------------------------------

    def _trace_answer(self, module, call, fn):
        line_text = lambda n: module.lines[n - 1].strip()
        path = [{"line": call.lineno, "code": line_text(call.lineno), "note": "AI call"}]
        parent = call._parent
        if isinstance(parent, ast.Await):
            parent = parent._parent
        result_var = None
        if isinstance(parent, ast.Assign) and isinstance(parent.targets[0], ast.Name):
            result_var = parent.targets[0].id
        elif isinstance(parent, ast.Return):
            path.append({"line": parent.lineno, "code": line_text(parent.lineno), "note": "raw response returned to the caller"})
            return {"kind": "free_text", "labels": [], "display_chars": None, "path": path,
                    "summary": "The raw response leaves this function, so Prune treats it as free text."}
        if fn is None or result_var is None:
            return {"kind": "free_text", "labels": [], "display_chars": None, "path": path,
                    "summary": "Prune couldn't follow the answer, so it is treated as free text."}

        tainted = {result_var}
        assigns = sorted(
            (n for n in ast.walk(fn) if isinstance(n, (ast.Assign, ast.AugAssign, ast.AnnAssign)) and n.lineno > call.end_lineno),
            key=lambda n: n.lineno,
        )
        for a in assigns:
            if a.value is not None and names_in(a.value) & tainted:
                targets = a.targets if isinstance(a, ast.Assign) else [a.target]
                for t in targets:
                    if isinstance(t, ast.Name):
                        if t.id not in tainted:
                            seg = module.segment(a.value)
                            if re.search(r"\.(content|text|output_text)\b|\[.content.\]", seg):
                                path.append({"line": a.lineno, "code": line_text(a.lineno), "note": f"answer text read into `{t.id}`"})
                        tainted.add(t.id)

        labels, eq_consts, number, structured, display, returns = [], [], False, False, None, []
        for node in ast.walk(fn):
            if getattr(node, "lineno", 0) <= call.end_lineno:
                continue
            if isinstance(node, ast.Compare) and names_in(node.left) & tainted:
                for op, comp in zip(node.ops, node.comparators):
                    if isinstance(op, (ast.In, ast.NotIn)):
                        vals = self.resolve_set(module, comp)
                        if vals and len(vals) >= 2:
                            labels = vals
                            path.append({"line": node.lineno, "code": line_text(node.lineno),
                                         "note": f"only compared against {len(vals)} labels: {', '.join(vals)}"})
                    elif isinstance(op, (ast.Eq, ast.NotEq)) and isinstance(comp, ast.Constant) and isinstance(comp.value, str):
                        eq_consts.append(comp.value)
            elif isinstance(node, ast.Call) and node.args and names_in(node.args[0]) & tainted:
                ch = attr_chain(node.func) or []
                if ch in (["int"], ["float"]):
                    number = True
                    path.append({"line": node.lineno, "code": line_text(node.lineno), "note": "parsed as a number"})
                if ch[-2:] == ["json", "loads"] or ch[-1:] == ["model_validate_json"]:
                    structured = True
            elif isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Slice) and names_in(node.value) & tainted:
                up = node.slice.upper
                if node.slice.lower is None and isinstance(up, ast.Constant) and isinstance(up.value, int):
                    display = up.value
                    path.append({"line": node.lineno, "code": line_text(node.lineno), "note": f"only the first {up.value} characters are shown"})
            elif isinstance(node, ast.Return) and node.value is not None and names_in(node.value) & tainted:
                returns.append(node.lineno)

        if labels:
            kind = "label"
            summary = f"The code only checks whether the answer is one of {len(labels)} words ({', '.join(labels)})."
        elif number:
            kind, summary = "number", "The answer is only used as a number."
        elif eq_consts and {c.lower() for c in eq_consts} <= {"yes", "no", "true", "false"}:
            kind, summary = "boolean", "The answer is only compared to yes/no."
        elif structured:
            kind, summary = "structured", "The answer is parsed as JSON."
        else:
            kind = "free_text"
            summary = "The answer text is returned or shown, so Prune treats it as free text."
            if display:
                summary = f"The answer is shown to users, but only the first {display} characters."
        for ln in returns:
            if not any(p["line"] == ln for p in path):
                path.append({"line": ln, "code": line_text(ln), "note": "returned to the caller"})
        path.sort(key=lambda p: p["line"])
        return {"kind": kind, "labels": labels, "display_chars": display, "path": path, "summary": summary,
                "eq_consts": eq_consts}

    # ----- loops, retries, agents ------------------------------------------

    def _loops(self, module, call, fn, site):
        site["retry_storm"] = None
        site["agent_unbounded"] = None
        p = call._parent
        try_node = None
        while p is not None and p is not fn:
            if isinstance(p, ast.Try) and try_node is None:
                try_node = p
            if isinstance(p, ast.While) and isinstance(p.test, ast.Constant) and p.test.value is True:
                loop_src = module.segment(p)
                if try_node is not None:
                    for h in try_node.handlers:
                        body_calls = [attr_chain(n.func) or [] for n in ast.walk(h) if isinstance(n, ast.Call)]
                        has_sleep = any(c and ("sleep" in c[-1] or "backoff" in c[-1]) for c in body_calls)
                        cont = [n for n in ast.walk(h) if isinstance(n, (ast.Continue, ast.Pass))]
                        if cont and not has_sleep:
                            site["retry_storm"] = {"while_line": p.lineno, "continue_line": cont[0].lineno,
                                                   "handler_line": h.lineno}
                if site["has_tools"] or "tool_calls" in loop_src:
                    site["agent_unbounded"] = {"while_line": p.lineno, "end_line": p.end_lineno}
                if site["retry_storm"]:
                    site["retry_storm"]["end_line"] = p.end_lineno
                break
            p = getattr(p, "_parent", None)

    def _plain_code(self, site):
        site["plain_code"] = None
        text = site["prompt_text"]
        if site["answer"]["kind"] != "free_text" or "extract" not in text.lower():
            return
        m = ID_EXAMPLE.search(text)
        if not m or not site["user_var"]:
            return
        pattern = rf"{m.group(1)}-\d{{{len(m.group(2))}}}"
        sentinel = next((c for c in site["answer"].get("eq_consts", []) if c.isupper()), None)
        site["plain_code"] = {"pattern": pattern, "example": m.group(0), "sentinel": sentinel}

    # ----- project-wide context: timers, batches, duplicates ----------------

    def _project_context(self, sites):
        ai_funcs = {}
        for s in sites:
            ai_funcs.setdefault(s["function"], s)
        calls_from = {}  # function name -> list of (callee, call node, module, fn)
        timer_roots = {}
        for module in self.modules.values():
            for fn in ast.walk(module.tree):
                if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                calls = []
                for n in ast.walk(fn):
                    if isinstance(n, ast.Call):
                        ch = attr_chain(n.func) or []
                        if ch:
                            calls.append((ch[-1], n))
                calls_from[fn.name] = (calls, module, fn)
                for d in fn.decorator_list:
                    seg = module.segment(d).lower()
                    if any(h in seg for h in TIMER_DECORATOR_HINTS):
                        timer_roots[fn.name] = {"line": d.lineno, "how": module.segment(d), "file": module.path}
                for n in ast.walk(fn):
                    if isinstance(n, ast.While) and isinstance(n.test, ast.Constant) and n.test.value is True:
                        for c in ast.walk(n):
                            if isinstance(c, ast.Call) and (attr_chain(c.func) or [""])[-1] == "sleep" and c.args:
                                secs = c.args[0].value if isinstance(c.args[0], ast.Constant) else None
                                timer_roots[fn.name] = {"line": c.lineno, "how": module.lines[c.lineno - 1].strip(),
                                                        "file": module.path, "seconds": secs}
            for n in ast.walk(module.tree):
                if isinstance(n, ast.Call) and (attr_chain(n.func) or [""])[-1] == "do" and n.args:
                    if isinstance(n.args[0], ast.Name):
                        timer_roots[n.args[0].id] = {"line": n.lineno, "how": module.lines[n.lineno - 1].strip(), "file": module.path}

        def reachable(root):
            seen, stack, parents = {root}, [root], {}
            while stack:
                f = stack.pop()
                for callee, _ in calls_from.get(f, ([], None, None))[0]:
                    if callee in calls_from and callee not in seen:
                        seen.add(callee)
                        parents[callee] = f
                        stack.append(callee)
            return seen, parents

        for s in sites:
            s["timer"] = None
            s["batchable"] = None
            s["duplicates"] = None
        for root, info in timer_roots.items():
            seen, parents = reachable(root)
            for s in sites:
                if s["function"] in seen and s["timer"] is None:
                    chain_, f = [s["function"]], s["function"]
                    while f in parents:
                        f = parents[f]
                        chain_.append(f)
                    s["timer"] = {**info, "root": root, "chain": chain_[::-1]}

        for fname, (calls, module, fn) in calls_from.items():
            is_job = any(h in module.path.lower() for h in JOB_MODULE_HINTS)
            for callee, node in calls:
                if callee not in ai_funcs or callee == fname:
                    continue
                site = ai_funcs[callee]
                p = node._parent
                while p is not None and p is not fn:
                    if isinstance(p, (ast.For, ast.AsyncFor, ast.comprehension)):
                        if is_job or site["timer"]:
                            site["batchable"] = {"caller": fname, "line": node.lineno, "file": module.path,
                                                 "code": module.lines[node.lineno - 1].strip()}
                        break
                    p = getattr(p, "_parent", None)
            # duplicate identical calls to an AI function inside one function
            groups = {}
            for callee, node in calls:
                if callee in ai_funcs and callee != fname:
                    groups.setdefault(ast.unparse(node), []).append(node)
            for expr, nodes in groups.items():
                if len(nodes) < 2:
                    continue
                assign = None
                for n in nodes:
                    par = n._parent
                    if isinstance(par, ast.Assign) and isinstance(par.targets[0], ast.Name) and par.lineno == par.end_lineno:
                        assign = {"line": par.lineno, "var": par.targets[0].id}
                ai_funcs[expr.split("(")[0].split(".")[-1]]["duplicates"] = {
                    "caller": fname,
                    "file": module.path,
                    "expr": expr,
                    "lines": sorted(n.lineno for n in nodes),
                    "assign": assign,
                    "caller_line": fn.lineno,
                }


def size_class(model):
    info = catalog.model_info(model or "")
    return info[3] if info else "unknown"
