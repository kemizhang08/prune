# Prune

A spell-checker for AI spending. Prune reads Python code, finds AI calls that waste money and electricity, proves each fix is safe (the project's own tests, plus replay for model changes), and opens a one-click fix showing dollar, kWh and carbon savings.

Built for Chalk's Best Data-Driven Agent track. The Chalk pieces (sandboxes, AI Gateway, Federated Queries) are stubbed behind small interfaces because no credentials are configured.

## Run it

Python 3.11+ and the standard library only. No installs.

```bash
python3 server.py
```

Open http://localhost:8765. Set `PORT` to use another port. Run Prune's own tests with `python3 -m unittest discover -s tests -t .`.

## The app

The tabs follow the loop **Find → Prove → Ship → Remember**, plus **Energy** and **Budgets**.

- **Find** — paste a GitHub link or pick a sample. Shows the savings, the tree, the carbon band, where the money goes and every finding with its proof badge.
- **Prove** — Proof 1 runs the project's tests in a sealed copy. Proof 2 replays past requests on the smaller model (497/500 for StepUp).
- **Ship** — a receipt: saved $, kWh and CO₂ ranges, minus Prune's own review cost and energy, giving the net.
- **Remember** — the equivalence ledger. Accepted replays become patterns that let similar tasks skip the replay.
- **Energy** — saved energy and carbon as ranges, everyday comparisons, energy per month as fixes ship, the biggest savers, the net after Prune's own footprint, and the method with sources.
- **Budgets** — monthly limits per feature (saved in `data/budgets.json`), the waiting change with Send back / Approve, adding limits and the per-change threshold.

### Proof badges

The analyzer assigns these from the kind of change:

- **Same answer** — caching, removing duplicates, capping length. Passing tests are enough.
- **Checked** — a smaller model or trimmed history, proven by replay or by the ledger.
- **Check pending** — waiting on a replay.
- **Advice only** — anything Prune won't apply on its own.

## Scanning a GitHub link

Paste `https://github.com/owner/repo`, a folder (`…/tree/<ref>/<path>`) or a single file (`…/blob/<ref>/<file>.py`). The UI shows Fetching → Reading the code → Done.

**Prune never runs code from a link.** It doesn't import, install, test or replay it; it only parses it with Python's `ast`. Concretely:

- **Links:** only `https://github.com` links are accepted.
- **Download:** the repo arrives as a tarball held in memory.
- **Limits:**
  - 60 MB download
  - 3,000 files
  - 1 MB per file
  - 40 MB extracted
  - 60 s time limit
- **What's written:** only `.py`, `.ipynb` and a root `prune.toml`, as plain text, to paths Prune builds itself. Links, devices and `..` paths are skipped.
- **Cleanup:** the download folder is deleted after the scan.

Because nothing is run:

- The tests and replay steps show as "not run for linked repos".
- Changes that need tests (agent step limits, retries, plain-code swaps) stay as advice, with the suggested diff shown.
- Accepting a fix gives a patch to copy and `git apply`.
- A model switch on a linked repo can still be **Checked** when the ledger has seen a similar task.

Linked repos have no usage data, so every figure is labelled an estimate:

- **Traffic:** a default of 10,000 runs a month per AI call, editable for the whole repo on Find or per call on Prove.
- **Unpriced models:** these are priced by size class and labelled as estimates.
- **Budgets:** without a `prune.toml`, there is one row per file that calls an AI model.

## Demo path (about 4 minutes)

1. **StepUp Shoes** loads first: ~$1,376/mo of AI spend across 6 calls, and $1,035/mo Prune can cut.
2. **Sorting support emails:** run the checks (11 pass), then check 500 past answers. 497 match and the 3 differences are shown. Click "These look right", see the receipt ($700 → $59/mo, 40–110 kWh, net of the $0.26 review), then ship it.
3. **Energy:** 40–110 kWh and 10–50 kg CO₂ a month. The review used 44–132 Wh.
4. **Budgets:** the product-page change adds ~$1,230/mo, over the $50 per-change limit. Send it back.
5. **Northwind Bank:** its 4-label sorter gets "Checked · 497/500 from memory" with no replay.
6. **Paste a real repo:** e.g. `https://github.com/anthropics/anthropic-quickstarts`. A repo with no AI calls (e.g. `psf/requests`) says so.

## How it works

| Module | Job |
|---|---|
| `prune/analyzer.py` | AST scan (no AI) of `.py` files and notebook code cells. Detects OpenAI-style (incl. OpenRouter/Groq/Together/local `base_url`), Anthropic, Gemini, LiteLLM and LangChain calls. Resolves the model, limits and prompts (across imports), and traces the answer: label set, yes/no, number, JSON, display truncation or free text. Also finds timers, loops, retries, agents and duplicate calls. |
| `prune/rules.py` | Launch rules. Each yields exact line edits, a cost transform and a proof badge. |
| `prune/costing.py`, `catalog.py` | Dollars from list prices (unknown models priced by size, labelled). Energy is a low–high kWh range per 1k tokens by model size. Carbon is energy × grid intensity. Also holds the everyday comparisons. |
| `prune/engine.py` | Project state: findings, receipts, the energy summary, budgets, accepted fixes and link-scan jobs. |
| `prune/fetch.py` | Safe GitHub download for static scans. |
| `prune/sandbox.py` | Applies a fix to a temp copy and runs the sample's `unittest` suite with API keys stripped. Never used for linked repos. |
| `prune/replay.py` | Replays seeded recordings (`samples/stepup/recordings`), most different first, with a match rate and a keyword guard. |
| `prune/ledger.py` | The equivalence ledger (`data/ledger.json`): task pattern, label count, models, match rate and decision. Never prompts or answers. |
| `prune/store.py`, `budget.py` | Saved budget settings, and per-feature budgets from a repo's `prune.toml`. |

Usage data comes from `usage.json` in each sample, standing in for an AI Gateway export. The StepUp guard keeps ~12% of traffic on gpt-4o. That is why the "after" cost lands near the walkthrough's ~$60 rather than ~$20.

Regenerate the replay recordings with `python3 scripts/make_recordings.py`.
