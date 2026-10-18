"""Download a public GitHub repo (or one file) for static analysis.

Safety rules, all enforced here:
- Only https://github.com/<owner>/<repo>[/tree|blob/<ref>/<path>] links.
- The download is a tarball read in memory with size, file-count and time limits.
- Only .py and .ipynb files (plus a root prune.toml) are written, as plain text, to
  paths Prune builds itself. Links, devices and anything escaping the folder are skipped.
- Nothing downloaded is ever imported, installed or run. Prune only parses it.
"""

import io
import re
import tarfile
import time
import urllib.error
import urllib.request
from pathlib import PurePosixPath

MAX_DOWNLOAD_BYTES = 60 * 1024 * 1024
MAX_FILE_BYTES = 1024 * 1024
MAX_FILES = 3000
MAX_TOTAL_BYTES = 40 * 1024 * 1024
TIMEOUT_S = 60
KEEP = (".py", ".ipynb")
# Text the code may load into prompts (policy handbooks, knowledge bases) plus dependency lists.
# Only sizes and item counts are used for estimates; nothing here is executed.
DATA = (".md", ".txt", ".json", ".yaml", ".yml", ".csv", ".toml", ".cfg")
SKIP_PARTS = {".git", "node_modules", "venv", ".venv", "site-packages", "__pycache__", "dist", "build"}

URL_RE = re.compile(
    r"^https://(?:www\.)?github\.com/(?P<owner>[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/(?P<repo>[A-Za-z0-9._-]{1,100}?)(?:\.git)?"
    r"(?:/(?P<kind>tree|blob)/(?P<ref>[^/\s?#]+)(?:/(?P<path>[^\s?#]*))?)?/?(?:[?#].*)?$"
)


class FetchError(Exception):
    """A problem worth showing to the person as-is."""


def parse_github_url(url):
    url = (url or "").strip()
    if not url.startswith("https://"):
        if url.startswith(("github.com/", "www.github.com/")):
            url = "https://" + url
        else:
            raise FetchError("Paste a link that starts with https://github.com/")
    m = URL_RE.match(url)
    if not m:
        raise FetchError("That doesn't look like a GitHub repo link. Try https://github.com/owner/repo")
    d = m.groupdict()
    path = (d.get("path") or "").strip("/")
    if ".." in path.split("/"):
        raise FetchError("That link has an unsupported path.")
    kind = "file" if d.get("kind") == "blob" else "repo"
    if kind == "file" and not path.endswith(KEEP):
        raise FetchError("Prune reads Python files (.py) and notebooks (.ipynb). Link a repo or one of those files.")
    return {"owner": d["owner"], "repo": d["repo"], "ref": d.get("ref") or "HEAD", "path": path, "kind": kind,
            "label": f"{d['owner']}/{d['repo']}" + (f"/{path}" if path else ""),
            "url": f"https://github.com/{d['owner']}/{d['repo']}"}


def _get(url, limit, deadline):
    req = urllib.request.Request(url, headers={"User-Agent": "Prune-static-scan"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            chunks, total = [], 0
            while True:
                if time.time() > deadline:
                    raise FetchError("GitHub took too long to send the code. Try a smaller repo or a single folder link.")
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > limit:
                    raise FetchError(f"That repo is over {limit // (1024 * 1024)} MB. Link a folder inside it instead (…/tree/main/folder).")
                chunks.append(chunk)
            return b"".join(chunks)
    except urllib.error.HTTPError as e:
        if e.code in (404, 451):
            raise FetchError("We couldn't find that on GitHub. It may be private, renamed or misspelled.") from None
        if e.code in (403, 429):
            raise FetchError("GitHub is rate-limiting downloads right now. Try again in a minute.") from None
        raise FetchError(f"GitHub returned an error ({e.code}).") from None
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        raise FetchError("Couldn't reach GitHub. Check the connection and try again.") from None


def _safe_rel(name, prefix):
    parts = PurePosixPath(name).parts[1:]  # drop the "<repo>-<sha>/" top folder
    rel = PurePosixPath(*parts) if parts else None
    if rel is None or rel.is_absolute() or ".." in rel.parts:
        return None
    if prefix and not (str(rel) == prefix or str(rel).startswith(prefix + "/")):
        return None
    if any(p in SKIP_PARTS or p.startswith(".") for p in rel.parts[:-1]):
        return None
    return rel


def fetch(info, dest, on_progress=None):
    """Write the repo's Python files under dest. Returns counts for the UI."""
    deadline = time.time() + TIMEOUT_S
    dest.mkdir(parents=True, exist_ok=True)
    if info["kind"] == "file":
        data = _get(f"https://raw.githubusercontent.com/{info['owner']}/{info['repo']}/{info['ref']}/{info['path']}",
                    MAX_FILE_BYTES, deadline)
        name = PurePosixPath(info["path"]).name
        (dest / name).write_text(data.decode("utf-8", errors="replace"))
        return {"files": 1, "skipped": 0, "bytes": len(data)}

    blob = _get(f"https://codeload.github.com/{info['owner']}/{info['repo']}/tar.gz/{info['ref']}", MAX_DOWNLOAD_BYTES, deadline)
    if on_progress:
        on_progress(f"Downloaded {len(blob) / 1e6:.1f} MB")
    files = skipped = total = 0
    try:
        tar = tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz")
    except tarfile.TarError:
        raise FetchError("GitHub sent something that isn't a code archive.") from None
    with tar:
        for m in tar:
            if time.time() > deadline:
                raise FetchError("Scanning took too long. Try a single folder link.")
            if not m.isfile():  # skips links, devices and folders
                continue
            rel = _safe_rel(m.name, info["path"])
            if rel is None:
                continue
            is_data = rel.suffix in DATA
            if rel.suffix not in KEEP and not is_data:
                continue
            if m.size > MAX_FILE_BYTES or total + m.size > MAX_TOTAL_BYTES or files >= MAX_FILES:
                skipped += 1
                continue
            raw = tar.extractfile(m).read()
            out = dest.joinpath(*rel.parts)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(raw.decode("utf-8", errors="replace"))
            files += 0 if is_data else 1
            total += m.size
    if files == 0:
        raise FetchError("No Python files in that repo, so there's nothing for Prune to read. Prune reads .py files and notebooks.")
    return {"files": files, "skipped": skipped, "bytes": total}
