"""Prune demo server. Run: python3 server.py  (then open http://localhost:8765)"""

import json
import os
import sys
import traceback
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from prune import catalog, engine, fetch

STATIC = Path(__file__).resolve().parent / "static"
PORT = int(os.environ.get("PORT", 8765))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(STATIC), **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("%s\n" % (fmt % args))

    def _json(self, obj, status=200):
        body = json.dumps(obj, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path == "/api/samples":
            return self._json({k: {"name": v["name"], "blurb": v["blurb"]} for k, v in engine.SAMPLES.items()})
        if self.path == "/api/ledger":
            return self._json({"entries": engine.LEDGER.entries()})
        if self.path == "/api/catalog":
            return self._json(catalog.as_json())
        if self.path.startswith("/api/scan/"):
            try:
                return self._json(engine.job_status(self.path.rsplit("/", 1)[-1]))
            except KeyError as e:
                return self._json({"error": str(e).strip("'\"")}, 404)
        if self.path.startswith("/api/"):
            return self._json({"error": "not found"}, 404)
        return super().do_GET()

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 2_000_000:
                return self._json({"error": "That's too much code to paste. Link the repo instead."}, 413)
            body = json.loads(self.rfile.read(n) or b"{}")
            route = self.path
            if route == "/api/load":
                state = engine.new_project(sample=body.get("sample"), paste=body.get("paste"))
                return self._json(state.payload())
            if route == "/api/ledger/reset":
                engine.LEDGER.reset()
                return self._json({"entries": []})
            if route == "/api/scan":
                job = engine.start_scan(body.get("url"), body.get("calls_per_month"))
                return self._json({k: v for k, v in job.items() if k != "project"})
            state = engine.get(body.get("project"))
            gid = body.get("group")
            with state.lock:
                if route == "/api/tests":
                    result = state.run_tests(gid)
                    return self._json({"result": result, "project": state.payload()})
                if route == "/api/replay":
                    result = state.run_replay(gid)
                    return self._json({"result": result, "project": state.payload()})
                if route == "/api/guard":
                    state.set_guard(gid, body.get("enabled"))
                    return self._json({"project": state.payload()})
                if route == "/api/replay/decision":
                    entry = state.decide_replay(gid, body["decision"])
                    return self._json({"ledger_entry": entry, "project": state.payload()})
                if route == "/api/accept":
                    record = state.accept(gid)
                    return self._json({"accepted": record, "project": state.payload()})
                if route == "/api/traffic":
                    state.set_traffic(body.get("site"), body.get("calls_per_month"), body.get("entry"))
                    return self._json({"project": state.payload()})
                if route == "/api/budget/limit":
                    state.set_limit(body["feature"], body.get("usd"))
                    return self._json({"project": state.payload()})
                if route == "/api/budget/add":
                    state.add_limit(body.get("name"), body.get("usd") or 0)
                    return self._json({"project": state.payload()})
                if route == "/api/budget/threshold":
                    state.set_threshold(body.get("usd"))
                    return self._json({"project": state.payload()})
                if route == "/api/budget/decision":
                    state.decide_change(body.get("decision"))
                    return self._json({"project": state.payload()})
                if route == "/api/review-change":
                    result = state.review_change(body["file"], body["code"], int(body.get("calls_per_month") or 10000))
                    return self._json(result)
            return self._json({"error": "not found"}, 404)
        except fetch.FetchError as e:
            return self._json({"error": str(e)}, 400)
        except (KeyError, PermissionError, ValueError, TypeError) as e:
            return self._json({"error": str(e).strip("'\"")}, 400)
        except Exception as e:  # surface the problem to the UI instead of a blank failure
            traceback.print_exc()
            return self._json({"error": f"{type(e).__name__}: {e}"}, 500)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Prune is running at http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
