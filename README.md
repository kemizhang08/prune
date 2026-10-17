# Prune

A spell-checker for AI spending. Prune reads Python code, finds AI calls that waste money and electricity, proves each fix is safe (the project's own tests, plus replay for model changes), and opens a one-click fix showing dollar, kWh and carbon savings.

Built for Chalk's Best Data-Driven Agent track. The Chalk pieces (sandboxes, AI Gateway, Federated Queries) are stubbed behind small interfaces because no credentials are configured.

## Run it

Python 3.11+ and the standard library only. No installs.

```bash
python3 server.py
```

Open http://localhost:8765. Set `PORT` to use another port. Run Prune's own tests with `python3 -m unittest discover -s tests -t .`.

## Demo path (about 4 minutes)

1. **StepUp Shoes** loads first. The meters show ~$1,376/mo of AI spend across 6 calls.
2. Open `classify_ticket()`:
   - **Step 1:** the code is only compared against 3 labels.
   - **Step 2:** 40,000 calls/mo, $700/mo.
   - **Step 3:** the diff.
   - **Step 4:** run the real tests in a sealed copy.
   - **Step 5:** replay 500 recorded emails. 497/500 match and the 3 differences are shown first. Prune suggests keeping gpt-4o for "broken"/"damaged" emails. Click **Accept differences**, which records the lesson in the ledger.
   - **Step 6:** the PR comment reads "Prune found $640/month… 40–110 kWh". Click **Accept fix** and the meters tick down.
   - **Step 7:** a 10% → 100% rollout.
3. **Review a new change:** PR #42 adds about $1,230/mo, so it needs a manager's approval and goes over the storefront budget.
4. **Northwind Bank:** its 4-label transaction categorizer gets a high-confidence model switch from the ledger with no replay. Use **Reset** on the ledger to show the before state ("advice only").
5. **Paste code:** use **Insert example** for Anthropic + LiteLLM code, with traffic entered by hand and labelled as an estimate.

## How it works

| Module | Job |
|---|---|
| `prune/analyzer.py` | AST scan (no AI). Detects OpenAI-style (incl. OpenRouter/Groq/Together/local `base_url`), Anthropic, Gemini, LiteLLM and LangChain calls. Resolves the model, limits and prompts (across imports), and traces the answer: label set, yes/no, number, JSON, display truncation or free text. Also finds timers, loops, retries, agents and duplicate calls. |
| `prune/rules.py` | Launch rules: model too big, plain code could do it, uncached repeated prompt, answer limit far above what's read, full history resent, timer-triggered, batchable, retry storm, duplicate calls, and agent with no step limit. Each rule yields exact line edits and a cost transform. |
| `prune/costing.py`, `catalog.py` | Dollars from list prices. Energy is a low–high kWh range per 1k tokens by model size. Carbon is energy × grid intensity. All values are editable. |
| `prune/sandbox.py` | Applies the fix to a temp copy and runs the project's `unittest` suite with API keys stripped (`ChalkSandbox` is a stub). |
| `prune/replay.py` | Replays seeded recordings (`samples/stepup/recordings`). Lists the most different results first, gives a match rate, and suggests a keyword guard. `GatewayReplay` is the stub for live replay. |
| `prune/ledger.py` | The equivalence ledger (`data/ledger.json`). It stores task pattern, label count, models, match rate and decision. Never prompts or answers. |
| `prune/budget.py` | Per-feature monthly budgets and an approval threshold from the repo's `prune.toml`. |

Usage data comes from `usage.json` in each sample, standing in for an AI Gateway export. The StepUp guard keeps ~12% of traffic on gpt-4o. That is why the "after" cost lands near the walkthrough's ~$60 rather than ~$20.

Regenerate the replay recordings with `python3 scripts/make_recordings.py`.
