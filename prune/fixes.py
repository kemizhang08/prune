"""Line edits on source files, and unified diffs for them."""

import difflib


def span(s, text):
    return {"type": "span", "line": s["line"], "col": s["col"], "end_col": s["end_col"], "text": text}


def insert_after(line, lines):
    return {"type": "insert_after", "line": line, "lines": lines}


def insert_before(line, lines):
    return {"type": "insert_before", "line": line, "lines": lines}


def replace_lines(start, end, lines):
    return {"type": "replace_lines", "start": start, "end": end, "lines": lines}


def delete_line(line):
    return {"type": "replace_lines", "start": line, "end": line, "lines": []}


def indent_of(line_text):
    return line_text[: len(line_text) - len(line_text.lstrip())]


def ensure_import(module, stmt):
    """An edit adding `stmt` (e.g. 'import re') unless the module already has it."""
    if any(l.strip() == stmt for l in module.lines):
        return None
    name = stmt.split()[1]
    for n in module.import_lines:
        text = module.lines[n - 1]
        if text.startswith("import ") and text.split()[1] > name:
            return insert_before(n, [stmt])
    plain = [n for n in module.import_lines if module.lines[n - 1].startswith("import ")]
    if plain:
        return insert_after(plain[-1], [stmt])
    if module.import_lines:
        first = module.import_lines[0]
        first_text = module.lines[first - 1]
        lines = [stmt]
        if first_text.startswith("from ") and not first_text.split()[1].split(".")[0] in ("__future__",):
            top = first_text.split()[1].split(".")[0]
            if top not in STDLIB_HINT:
                lines.append("")
        return insert_before(first, lines)
    return insert_before(1, [stmt, ""])


STDLIB_HINT = {"os", "re", "sys", "json", "time", "functools", "typing", "collections", "itertools", "asyncio", "pathlib"}


def apply_edits(src, ops):
    lines = src.split("\n")
    spans = [o for o in ops if o["type"] == "span"]
    for o in sorted(spans, key=lambda o: (o["line"], -o["col"])):
        raw = lines[o["line"] - 1].encode()  # ast columns are UTF-8 byte offsets
        lines[o["line"] - 1] = (raw[: o["col"]] + o["text"].encode() + raw[o["end_col"] :]).decode()
    structural = [o for o in ops if o["type"] != "span"]

    def anchor(o):
        if o["type"] == "replace_lines":
            return (o["start"], 1)
        if o["type"] == "insert_after":
            return (o["line"], 2)
        return (o["line"], 0)

    seen_inserts = set()
    for o in sorted(structural, key=anchor, reverse=True):
        if o["type"] in ("insert_after", "insert_before"):
            key = (o["type"], o["line"], tuple(o["lines"]))
            if key in seen_inserts:
                continue
            seen_inserts.add(key)
        if o["type"] == "insert_after":
            lines[o["line"] : o["line"]] = o["lines"]
        elif o["type"] == "insert_before":
            lines[o["line"] - 1 : o["line"] - 1] = o["lines"]
        elif o["type"] == "replace_lines":
            lines[o["start"] - 1 : o["end"]] = o["lines"]
    return "\n".join(lines)


def unified(path, old, new):
    return "\n".join(
        difflib.unified_diff(old.splitlines(), new.splitlines(), fromfile=f"a/{path}", tofile=f"b/{path}", n=2, lineterm="")
    )
