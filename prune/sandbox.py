"""Apply a fix to a copy of the code and run the team's own tests.

`LocalSandbox` copies the project into a temp folder and runs its tests with API keys
stripped from the environment. A Chalk sandbox would plug in behind the same
interface; it isn't configured in this build.
"""

import os
import py_compile
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


class Sandbox:
    name = "sandbox"

    def run(self, root, new_sources):
        raise NotImplementedError


class ChalkSandbox(Sandbox):
    name = "Chalk sandbox"

    def run(self, root, new_sources):
        raise RuntimeError("Chalk sandbox credentials not configured.")


class LocalSandbox(Sandbox):
    name = "local sealed copy"

    def run(self, root, new_sources):
        start = time.time()
        tmp = Path(tempfile.mkdtemp(prefix="prune-sandbox-"))
        try:
            repo = tmp / "repo"
            shutil.copytree(root, repo, ignore=shutil.ignore_patterns("__pycache__", "recordings", ".git"))
            for path, src in new_sources.items():
                (repo / path).write_text(src)
            env = {"PATH": os.environ.get("PATH", ""), "PYTHONDONTWRITEBYTECODE": "1", "HOME": str(tmp)}
            if (repo / "tests").is_dir():
                cmd = [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", ".", "-v"]
                proc = subprocess.run(cmd, cwd=repo, env=env, capture_output=True, text=True, timeout=120)
                output = (proc.stdout + proc.stderr).strip()
                passed = proc.returncode == 0
                kind = "tests"
                ran = sum(1 for line in output.splitlines() if line.rstrip().endswith(("... ok", "... FAIL", "... ERROR")))
            else:
                cmd = ["py_compile"] + list(new_sources)
                errors = []
                for path in new_sources:
                    try:
                        py_compile.compile(str(repo / path), doraise=True)
                    except py_compile.PyCompileError as e:
                        errors.append(str(e))
                passed = not errors
                output = "\n".join(errors) or f"compiled {len(new_sources)} changed file(s): OK\n(no test suite found)"
                kind = "compile"
                ran = 0
            return {
                "passed": passed,
                "kind": kind,
                "tests_run": ran,
                "command": " ".join(Path(c).name if i == 0 else c for i, c in enumerate(cmd)),
                "output": output[-6000:],
                "seconds": round(time.time() - start, 2),
                "sandbox": self.name,
            }
        except subprocess.TimeoutExpired:
            return {"passed": False, "kind": "tests", "tests_run": 0, "command": "unittest", "output": "Timed out after 120s",
                    "seconds": 120, "sandbox": self.name}
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
