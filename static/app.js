"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd = (x) => (Math.abs(x) >= 100 ? "$" + Math.round(x).toLocaleString() : "$" + Number(x).toFixed(2));
const about = (x) => "$" + (x >= 100 ? Math.round(x / 10) * 10 : Math.round(x)).toLocaleString();
const rng = (r, d = 0) => `${Number(r[0]).toFixed(d)}–${Number(r[1]).toFixed(d)}`;
const int = (x) => Math.round(x).toLocaleString();

const RULE_LABEL = {
  model_too_big: "model too big",
  plain_code: "plain code could do it",
  uncached_prompt: "uncached prompt",
  max_tokens_high: "answer limit too high",
  full_history: "full history resent",
  timer: "timer-triggered",
  batchable: "batchable",
  retry_storm: "retry storm",
  duplicate_call: "duplicate calls",
  agent_unbounded: "agent without limits",
};

const state = { project: null, selected: null, busy: null, ledger: [], meterShown: null, review: null };

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 3200);
}

async function run(label, fn) {
  state.busy = label;
  render();
  try { await fn(); } catch (e) { toast(e.message); }
  state.busy = null;
  render();
}

// ---------- loading ----------

async function loadSample(sample) {
  await run("load", async () => {
    setProject(await api("/api/load", { sample }));
    state.review = null;
    state.selected = state.project.groups[0]?.id || null;
    document.querySelectorAll("#projectTabs button").forEach((b) => b.classList.toggle("active", b.dataset.sample === sample));
  });
  refreshLedger();
}

function setProject(p) {
  const prev = state.project;
  state.project = p;
  if (prev && prev.id === p.id) animateMeters(prev.totals, p.totals);
  else state.meterShown = { ...p.totals };
}

async function refreshLedger() {
  try { state.ledger = (await api("/api/ledger")).entries; } catch (e) { /* ignore */ }
  renderLedger();
}

// ---------- meters ----------

function animateMeters(from, to) {
  if (from.cost === to.cost) { state.meterShown = { ...to }; return; }
  const t0 = performance.now(), dur = 1400;
  document.querySelectorAll(".meter").forEach((m) => m.classList.add("flash"));
  setTimeout(() => document.querySelectorAll(".meter").forEach((m) => m.classList.remove("flash")), 1500);
  const lerp = (a, b, k) => a + (b - a) * k;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    state.meterShown = {
      cost: lerp(from.cost, to.cost, e),
      kwh: [lerp(from.kwh[0], to.kwh[0], e), lerp(from.kwh[1], to.kwh[1], e)],
      kg_co2e: [lerp(from.kg_co2e[0], to.kg_co2e[0], e), lerp(from.kg_co2e[1], to.kg_co2e[1], e)],
    };
    renderMeters();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderMeters() {
  const p = state.project;
  const el = $("#meters");
  if (!p) { el.innerHTML = ""; return; }
  const m = state.meterShown || p.totals, init = p.initial;
  const savedUsd = init.cost - m.cost;
  const savedKwh = [init.kwh[0] - m.kwh[0], init.kwh[1] - m.kwh[1]];
  const r = p.receipt;
  el.innerHTML = `
    <div class="meter"><div class="label"><span>AI spend · ${esc(p.name)}</span><span>per month</span></div>
      <div class="value">${usd(m.cost)}</div>
      <div class="sub">${savedUsd > 0.5 ? `<span class="down">▼ ${usd(savedUsd)}</span> from ${usd(init.cost)}` : `${p.sites.length} AI calls found`}</div></div>
    <div class="meter"><div class="label"><span>Energy</span><span>kWh / month</span></div>
      <div class="value">${rng(m.kwh)}<span class="unit">kWh</span></div>
      <div class="sub">${savedKwh[1] > 0.05 ? `<span class="down">▼ ${rng(savedKwh)} kWh</span>` : "estimated range"}</div></div>
    <div class="meter"><div class="label"><span>Carbon</span><span>kg CO₂e / month</span></div>
      <div class="value">${rng(m.kg_co2e)}<span class="unit">kg</span></div>
      <div class="sub">energy × grid intensity</div></div>
    <div class="meter saved"><div class="label"><span>Waste found</span><span>this review</span></div>
      <div class="value">${usd(r.waste_found_usd)}<span class="unit">/mo</span></div>
      <div class="sub">Prune's own cost: ${usd(r.analysis_usd)} analysis + ${usd(r.replay_usd)} replay</div></div>`;
}

// ---------- side lists ----------

function renderFindings() {
  const p = state.project;
  const el = $("#findings");
  if (!p) { el.innerHTML = ""; return; }
  const open = p.groups.filter((g) => g.has_edits);
  const adviceOnly = p.groups.filter((g) => !g.has_edits);
  $("#findingsMeta").textContent = `${open.length} fix${open.length === 1 ? "" : "es"} · ${usd(p.open_savings)}/mo`;
  const card = (g) => {
    const rules = g.findings.map((f) => `<span class="chip ${f.included ? "amber" : ""}">${esc(RULE_LABEL[f.rule])}</span>`).join("");
    return `<button class="finding ${state.selected === g.id ? "active" : ""}" data-select="${esc(g.id)}">
      <span class="fn">${esc(g.function)}()</span>
      <span class="usd">${g.has_edits ? usd(g.summary.saved_usd) : `<span class="muted small">advice</span>`}</span>
      <span class="loc">${esc(g.file)}:${g.line} · ${esc(g.model || "")}</span>
      <span class="chips">${rules}</span></button>`;
  };
  const done = p.accepted.map((a) => `<button class="finding done ${state.selected === "accepted:" + a.id ? "active" : ""}" data-select="accepted:${esc(a.id)}">
      <span class="fn">${esc(a.function)}()</span><span class="usd">−${usd(a.saved_usd)}</span>
      <span class="loc">Accepted</span><span class="chips"><span class="chip green">✓ shipped</span></span></button>`);
  el.innerHTML = [...open.map(card), ...adviceOnly.map(card), ...done].join("") ||
    `<div class="muted">No AI calls found${p.parse_errors.length ? ": " + esc(p.parse_errors.join("; ")) : "."}</div>`;
}

function renderSites() {
  const p = state.project;
  const el = $("#sites");
  if (!p) { el.innerHTML = ""; return; }
  el.innerHTML = `<table><thead><tr><th>Call</th><th class="num">Calls/mo</th><th class="num">$/mo</th></tr></thead><tbody>
    ${p.sites.map((s) => `<tr><td><code>${esc(s.function)}</code><div class="muted small">${esc(s.model)}${s.estimate ? ' · <span class="chip amber">estimate</span>' : ""}</div></td>
      <td class="num">${int(s.calls)}</td><td class="num">${usd(s.cost)}</td></tr>`).join("")}
  </tbody></table>`;
}

// ---------- detail ----------

function codeBlock(code, start, hits = new Set(), trace = new Set()) {
  return `<div class="code"><pre>${code.split("\n").map((t, i) => {
    const n = start + i;
    const cls = hits.has(n) ? "hit" : trace.has(n) ? "traced" : "";
    return `<div class="ln ${cls}"><span class="n">${n}</span><span class="t">${esc(t) || " "}</span></div>`;
  }).join("")}</pre></div>`;
}

function diffBlock(diffs) {
  const lines = Object.values(diffs).join("\n").split("\n");
  return `<div class="code"><pre>${lines.map((t) => {
    const cls = t.startsWith("+++") || t.startsWith("---") ? "file" : t.startsWith("@@") ? "hunk" : t.startsWith("+") ? "add" : t.startsWith("-") ? "del" : "";
    return `<div class="ln ${cls}"><span class="t">${esc(t) || " "}</span></div>`;
  }).join("")}</pre></div>`;
}

function step(n, title, sub, body, cls = "") {
  return `<section class="step ${cls}"><div class="step-h"><span class="num">${cls === "ok" ? "✓" : n}</span>
    <span class="step-title">${title}</span><span class="step-sub">${sub || ""}</span></div><div class="step-b">${body}</div></section>`;
}

function spinner(label) { return state.busy === label ? '<span class="spin"></span> ' : ""; }

function modelFinding(g) { return g.findings.find((f) => f.rule === "model_too_big"); }

function bulletFor(g, f) {
  const st = g.status;
  if (f.rule === "model_too_big") {
    if (f.proof === "replay" && st.replay) {
      const d = st.replay.total - st.replay.matched;
      let s = `Smaller model: same ${g.site.answer.kind === "label" ? "label" : "answer"} on ${int(st.replay.matched)} of ${int(st.replay.total)} real requests (see the ${d} difference${d === 1 ? "" : "s"})`;
      if (f.guard) s += `; requests mentioning ${f.guard.keywords.map((k) => `“${k}”`).join(" or ")} stay on ${esc(g.model)}`;
      return s;
    }
    if (f.proof === "ledger") return `Smaller model (${esc(f.target_model)}): the ledger shows ${(f.ledger.match_rate * 100).toFixed(1)}% matches on similar tasks, so no replay needed`;
    return `Smaller model (${esc(f.target_model)}): waiting on replay proof`;
  }
  return esc(f.bullet);
}

function renderDetail() {
  const p = state.project;
  const el = $("#detail");
  if (!p) { el.innerHTML = `<div class="empty">Load a project to start a review.</div>`; return; }
  if (state.selected?.startsWith("accepted:")) return renderAccepted(state.selected.slice(9));
  const g = p.groups.find((x) => x.id === state.selected);
  if (!g) { el.innerHTML = `<div class="empty">${p.groups.length ? "Pick a finding on the left." : "Nothing left to fix here. Check the meters above."}</div>`; return; }
  const st = g.status, sm = g.summary, a = g.site.answer;
  const hits = new Set(g.findings.flatMap((f) => f.lines));
  const trace = new Set(a.path.map((x) => x.line));
  const mf = modelFinding(g);

  // 1. find
  const issues = g.findings.map((f) => `<div class="issue ${f.included ? "" : "excluded"}">
      <span class="t">${esc(f.title)} <span class="chip ${f.fix_kind === "same_answer" ? "green" : f.fix_kind === "advice" ? "" : "blue"}">${esc(f.fix_kind_label)}</span>
      ${f.estimate ? '<span class="chip amber">estimate</span>' : ""}</span>
      <span class="usd">${f.saved_usd > 0 ? "−" + usd(f.saved_usd) + "/mo" : ""}${f.included ? "" : '<div class="muted small">not in this fix</div>'}</span>
      <span class="d">${esc(f.detail)}</span>${f.note ? `<span class="note">${esc(f.note)}</span>` : ""}</div>`).join("");
  const s1 = step(1, "Find the waste by reading the code", "static analysis · no AI used",
    `${codeBlock(g.code, g.code_start, hits, trace)}
     <ul class="trace">${a.path.map((x) => `<li><span class="l">L${x.line}</span><span><code>${esc(x.code)}</code> — ${esc(x.note)}</span></li>`).join("")}</ul>
     <div class="callout" style="margin-top:10px"><b>How the answer is used:</b> ${esc(a.summary)}</div>
     <div class="issues">${issues}</div>`, "ok");

  // 2. traffic
  const b = g.before;
  const s2 = step(2, "Check how often it actually runs", b.estimate ? '<span class="chip amber">estimate</span>' : "usage data",
    `<div class="kv">
      <div><div class="k">Calls / month</div><div class="v">${int(b.calls)}</div></div>
      <div><div class="k">Avg tokens in → out</div><div class="v">${int(b.input_tokens)} → ${int(b.output_tokens)}</div></div>
      <div><div class="k">Model (as billed)</div><div class="v">${esc(b.model)}</div></div>
      <div><div class="k">Cost / month</div><div class="v">${usd(sm.cost_before)}</div></div>
      <div><div class="k">Energy / month</div><div class="v">${rng(sm.kwh_before, 1)} kWh</div></div>
     </div><p class="muted small" style="margin:8px 0 0">Source: ${esc(b.source)}${g.feature ? ` · feature <b>${esc(g.feature)}</b>` : ""}</p>`, "ok");

  // 3. fix
  const s3 = step(3, "Write the fix", g.has_edits ? `${Object.keys(st.diffs).length} file(s) · exact lines` : "advice only",
    g.has_edits ? diffBlock(st.diffs) : `<div class="callout amber">No safe automatic edit for these findings yet. See the notes in step 1.</div>`,
    g.has_edits ? "ok" : "warn");

  // 4. tests
  let s4body, s4cls = "";
  if (!g.has_edits) s4body = `<span class="muted">Nothing to test.</span>`;
  else if (!st.tests) s4body = `<p style="margin:0">Prune copies the code into a sealed sandbox (API keys stripped), applies the fix and runs the project's own tests. If any test fails, the fix is dropped and stays advice only.</p>
      <div class="actions"><button class="primary" data-act="tests" ${state.busy ? "disabled" : ""}>${spinner("tests")}Run tests in sandbox</button></div>`;
  else {
    const t = st.tests;
    s4cls = t.passed ? "ok" : "bad";
    s4body = `<div class="callout ${t.passed ? "green" : "red"}">${t.passed
      ? `<b>${t.kind === "tests" ? `All ${t.tests_run} tests pass` : "Compiles"}</b> with the fix applied (${t.seconds}s, ${esc(t.sandbox)}).`
      : `<b>Tests failed</b>, so Prune drops this fix and keeps it as advice.`}</div>
      <details class="out"><summary><code>${esc(t.command)}</code></summary><pre>${esc(t.output)}</pre></details>
      <div class="actions"><button data-act="tests" ${state.busy ? "disabled" : ""}>${spinner("tests")}Run again</button></div>`;
  }
  const s4 = step(4, "Test the fix", st.tests ? (st.tests.passed ? "passing" : "failing") : "", s4body, s4cls);

  // 5. replay
  let s5body, s5cls = "", s5sub = "";
  if (!mf) { s5body = `<span class="muted">Same-answer fixes need no replay: passing tests are the proof.</span>`; s5cls = g.has_edits ? "ok" : ""; s5sub = "not needed"; }
  else if (mf.proof === "ledger") {
    s5cls = "ok"; s5sub = "ledger · high confidence";
    s5body = `<div class="callout green"><b>No replay needed.</b> ${esc(mf.note)}</div>
      <ul class="trace">${mf.ledger.lessons.map((l) => `<li><span class="l">📒</span><span><i>“${esc(l)}”</i></span></li>`).join("")}</ul>`;
  } else if (mf.proof === "advice") {
    s5cls = "warn"; s5sub = "advice only";
    s5body = `<div class="callout amber">${esc(mf.note)}</div>`;
  } else {
    const rp = st.replay;
    if (!rp) {
      s5body = `<p style="margin:0">Prune re-sends ${int(g.recorded_requests)} recorded requests from last week (names and addresses removed) to both setups and compares the answers. It runs in your environment with your key; it never runs the app itself.</p>
        <div class="actions"><button class="primary" data-act="replay" ${state.busy ? "disabled" : ""}>${spinner("replay")}Replay ${int(g.recorded_requests)} requests on ${esc(mf.target_model)}</button></div>`;
    } else {
      const d = rp.total - rp.matched;
      s5cls = rp.decision === "accepted" ? "ok" : rp.decision === "rejected" ? "bad" : "warn";
      s5sub = rp.decision ? `replay ${rp.decision}` : "your call";
      const guard = st.guard;
      s5body = `<div class="match"><span class="big">${int(rp.matched)} / ${int(rp.total)}</span><span>get the same ${a.kind === "label" ? "label" : "answer"} on ${esc(rp.new_model)} (${(rp.match_rate * 100).toFixed(1)}%)</span></div>
        <div class="bar"><i style="width:${rp.match_rate * 100}%"></i></div>
        <div class="replay-table"><table><thead><tr><th>#</th><th>Request (redacted)</th><th>${esc(rp.old_model)}</th><th>${esc(rp.new_model)}</th></tr></thead><tbody>
        ${rp.rows.map((r) => `<tr class="${r.same ? "" : "diff"}"><td class="muted">${r.id}</td><td class="in">${esc(r.input)}</td><td><b>${esc(r.before)}</b></td><td><b>${esc(r.after)}</b>${r.same ? "" : " ⚠"}</td></tr>`).join("")}
        <tr><td colspan="4" class="muted small">…${int(rp.total - rp.rows.length)} more identical answers. The ${d} that differ are shown first.</td></tr></tbody></table></div>
        ${guard ? `<label class="guard"><input type="checkbox" data-act="guard" ${guard.enabled ? "checked" : ""} ${rp.decision ? "disabled" : ""}>
          <span><b>Keep ${esc(rp.old_model)} for requests mentioning ${guard.keywords.map((k) => `“${esc(k)}”`).join(" or ")}</b><br>
          <span class="muted small">Covers ${guard.covers} of ${guard.of} differences · ${(guard.share * 100).toFixed(0)}% of traffic (${guard.requests} of ${rp.total} recorded requests) stays on the big model.</span></span></label>` : ""}
        <p class="muted small" style="margin:8px 0 0">${esc(rp.source)} · replay cost ${usd(rp.replay_cost_usd)}</p>
        ${rp.decision ? `<div class="callout ${rp.decision === "accepted" ? "green" : "red"}" style="margin-top:8px">You ${rp.decision} the replay. Prune recorded the pattern in the equivalence ledger (no prompts or answers stored).</div>`
          : `<div class="actions"><button class="primary" data-act="decide" data-decision="accepted" ${state.busy ? "disabled" : ""}>Accept differences</button>
             <button class="danger" data-act="decide" data-decision="rejected" ${state.busy ? "disabled" : ""}>Reject model switch</button></div>`}`;
    }
  }
  const s5 = step(5, "Prove the answers stay the same", s5sub, s5body, s5cls);

  // 6. PR comment
  const included = g.findings.filter((f) => f.included);
  const advice = g.findings.filter((f) => !f.included);
  const testsLine = !g.has_edits ? "" : st.tests ? (st.tests.passed ? `all passing` : `failing`) : "not run yet";
  const s6 = step(6, "Open a pull request", g.has_edits ? (st.can_accept ? "ready" : esc(st.blocked_by || "")) : "advice only",
    `<div class="pr"><div class="who"><b>prune-bot</b> commented on <code>${esc(g.file)}</code> line ${g.line}</div>
      <h3>Prune found ${about(sm.saved_usd)}/month of waste in <code>${esc(g.function)}</code></h3>
      <ul>${included.map((f) => `<li>${bulletFor(g, f)}</li>`).join("") || "<li>No automatic fix yet.</li>"}</ul>
      ${g.has_edits ? `<div><b>Savings:</b> about ${about(sm.saved_usd)}/month (${usd(sm.cost_before)} → ${usd(sm.cost_after)}), plus an estimated ${rng(sm.saved_kwh)} kWh/month of energy and ${rng(sm.saved_kg_co2e)} kg CO₂e.
        <b>Tests:</b> ${testsLine}</div>` : ""}
      ${advice.length ? `<p class="advice">Not in this fix: ${advice.map((f) => `${esc(f.title.toLowerCase())}${f.saved_usd ? ` (could save ~${usd(f.saved_usd)}/mo)` : ""}`).join("; ")}.</p>` : ""}
      ${g.has_edits ? `<div class="actions"><button class="primary" data-act="accept" ${st.can_accept && !state.busy ? "" : "disabled"}>${spinner("accept")}Accept fix</button>
        ${st.can_accept ? "" : `<span class="muted small">${esc(st.blocked_by || "")}</span>`}</div>` : ""}</div>`,
    st.can_accept ? "ok" : "");

  const s7 = step(7, "Watch after it ships", "", `<span class="muted">After you accept, model changes go to 10% of traffic first and roll back automatically if users start correcting answers.</span>`, "dim");

  el.innerHTML = `<div class="detail-head"><div><h1>${esc(g.function)}()</h1>
      <div class="where">${esc(g.file)}:${g.line} · ${esc(g.provider)} <code>${esc(g.site.api)}</code> · ${esc(g.model)}</div></div>
      <div style="text-align:right"><div style="font-size:22px;font-weight:700;color:var(--green)">${usd(sm.cost_before)} → ${usd(sm.cost_after)}<span class="muted small"> /mo</span></div>
      <div class="muted small">${rng(sm.kwh_before, 1)} → ${rng(sm.kwh_after, 1)} kWh/mo</div></div></div>
    ${s1}${s2}${s3}${s4}${s5}${s6}${s7}`;
}

function renderAccepted(id) {
  const a = state.project.accepted.find((x) => x.id === id);
  const el = $("#detail");
  if (!a) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="detail-head"><div><h1>${esc(a.function)}()</h1><div class="where">${esc(a.id.split("::")[0])} · accepted</div></div>
      <div style="text-align:right"><div style="font-size:22px;font-weight:700;color:var(--green)">−${usd(a.saved_usd)}<span class="muted small"> /mo</span></div>
      <div class="muted small">−${rng(a.saved_kwh, 1)} kWh/mo</div></div></div>
    ${step(6, "Pull request merged", "accepted", `<div class="pr"><div class="who"><b>prune-bot</b> · fix accepted</div><ul>${a.titles.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>`, "ok")}
    ${step(7, "Watch after it ships", "rollout", `<div class="rollout">${a.rollout.map((r) => `<div class="stage"><span class="pct">${r.pct}%</span><span>${esc(r.note)}</span></div>`).join("")}</div>`, "ok")}`;
}

// ---------- lower panels ----------

function renderBudgets() {
  const p = state.project;
  const el = $("#budgetPanel");
  if (!p) { el.innerHTML = ""; return; }
  const rows = p.budgets;
  el.innerHTML = `<div class="panel-head"><h2>Monthly budgets</h2><span class="muted small">from prune.toml</span></div>
    ${rows.length ? rows.map((r) => {
      const pct = r.budget ? Math.min(100, (r.cost / r.budget) * 100) : 0;
      return `<div class="budget-row"><span><b>${esc(r.feature)}</b> ${r.over ? '<span class="chip red">over budget</span>' : '<span class="chip green">within</span>'}</span>
        <span class="nums">${usd(r.cost)} / ${usd(r.budget)}</span><div class="bar"><i class="${r.over ? "over" : ""}" style="width:${pct}%"></i></div></div>`;
    }).join("") : `<p class="muted">No prune.toml in this project. Add one to set a monthly AI budget per feature.</p>`}
    <p class="muted small" style="margin:6px 0 0">Any change adding more than <b>${usd(p.approval_threshold)}/month</b> needs a manager's approval.</p>`;
}

function renderIncoming() {
  const p = state.project;
  const el = $("#incomingPanel");
  if (!p) { el.innerHTML = ""; return; }
  if (el.dataset.project !== p.id) {
    const inc = p.incoming;
    el.dataset.project = p.id;
    el.innerHTML = `<div class="panel-head"><h2>Review a new change</h2><span class="muted small">budget check before it ships</span></div>
      ${inc ? `<p style="margin:0 0 6px"><b>${esc(inc.title)}</b><br><span class="muted small">${esc(inc.traffic_source)}</span></p>` : `<p class="muted" style="margin:0 0 6px">Paste new code to see what it adds per month.</p>`}
      <div style="display:flex;gap:8px;margin-bottom:6px;flex-wrap:wrap"><input id="incFile" value="${esc(inc?.file || "new_feature.py")}" style="flex:1;min-width:140px">
        <input id="incCalls" type="number" value="${inc?.calls_per_month || 10000}" style="width:120px" title="Calls per month (estimate)"></div>
      <details ${inc ? "" : "open"}><summary class="small muted" style="cursor:pointer">Code</summary><textarea id="incCode" class="code-input" spellcheck="false">${esc(inc?.code || "")}</textarea></details>
      <div class="actions"><button class="primary" data-act="review">Check this change</button></div><div id="incResult"></div>`;
  }
  const r = state.review, out = $("#incResult");
  if (!r) { out.innerHTML = ""; return; }
  const c = r.check;
  out.innerHTML = `<div class="check ${c.needs_approval || c.over_budget ? "block" : "okay"}">
      <div class="big">This adds about ${about(r.added_usd)} a month</div>
      ${r.items.map((i) => `<div class="small"><code>${esc(i.function)}()</code> L${i.line}: ${int(i.calls)} calls × ${int(i.input_tokens)}→${int(i.output_tokens)} tokens on ${esc(i.model)} · ${rng(i.kwh, 1)} kWh/mo</div>`).join("")}
      <div style="margin-top:6px">${c.needs_approval ? `⛔ Over the ${usd(c.threshold)}/month limit: <b>needs a manager's approval</b> before merge.` : `✓ Under the ${usd(c.threshold)}/month approval limit.`}</div>
      ${c.feature ? `<div>${c.over_budget ? "⛔" : "✓"} Feature <b>${esc(c.feature)}</b>: ${usd(c.feature_cost_now)} → ${usd(c.feature_cost_after)} of a ${usd(c.budget)} budget.</div>` : ""}
      ${r.items.some((i) => i.suggestions.length) ? `<div class="small" style="margin-top:4px">Prune also suggests: ${[...new Set(r.items.flatMap((i) => i.suggestions))].map(esc).join(", ")}.</div>` : ""}
      <div class="muted small" style="margin-top:4px">Estimate: new code has no usage data yet.</div></div>`;
}

function renderLedger() {
  const el = $("#ledgerPanel");
  const entries = state.ledger;
  el.innerHTML = `<div class="panel-head"><h2>Equivalence ledger</h2><button class="ghost small" data-act="ledger-reset">Reset</button></div>
    <p class="muted small" style="margin:0 0 8px">What accepted and rejected replays taught Prune. Stores the task pattern, label count, models and match rate. Never prompts or answers.</p>
    ${entries.length ? entries.slice().reverse().map((e) => `<div class="ledger-entry">
      <div class="lesson">“${esc(e.lesson)}”</div>
      <div class="muted small">${esc(e.from_model)} → ${esc(e.to_model)} · ${int(e.matched)}/${int(e.total)} · ${e.label_count ?? "–"} labels ·
        <span class="chip ${e.decision === "accepted" ? "green" : "red"}">${esc(e.decision)}</span> · ${esc(e.recorded_at)}</div></div>`).join("")
      : `<p class="muted">Empty. Accept a replay on StepUp, then open Northwind Bank: its similar 4-label task gets a high-confidence suggestion with no replay.</p>`}`;
}

function render() {
  renderMeters();
  renderFindings();
  renderSites();
  renderDetail();
  renderBudgets();
  renderIncoming();
  renderLedger();
  $("#sourceNote").textContent = state.project ? `Traffic source: ${state.project.usage_source}` : "";
}

// ---------- actions ----------

document.addEventListener("click", async (e) => {
  const sel = e.target.closest("[data-select]");
  if (sel) { state.selected = sel.dataset.select; render(); $("#detail").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
  const tab = e.target.closest("#projectTabs button");
  if (tab) {
    if (tab.dataset.paste !== undefined) { $("#pasteDialog").showModal(); return; }
    loadSample(tab.dataset.sample);
    return;
  }
  const btn = e.target.closest("[data-act]");
  if (!btn || btn.type === "checkbox") return;
  const p = state.project, gid = state.selected;
  const act = btn.dataset.act;
  if (act === "tests") await run("tests", async () => { const r = await api("/api/tests", { project: p.id, group: gid }); setProject(r.project); });
  if (act === "replay") await run("replay", async () => { const r = await api("/api/replay", { project: p.id, group: gid }); setProject(r.project); });
  if (act === "decide") await run("decide", async () => {
    const r = await api("/api/replay/decision", { project: p.id, group: gid, decision: btn.dataset.decision });
    setProject(r.project);
    if (r.ledger_entry) toast("Recorded in the equivalence ledger: " + r.ledger_entry.lesson);
    await refreshLedger();
    const g = state.project.groups.find((x) => x.id === gid);
    if (g && g.has_edits && !g.status.tests) {  // the fix changed (guard) or was never tested: test it now
      const t = await api("/api/tests", { project: p.id, group: gid });
      setProject(t.project);
    }
  });
  if (act === "accept") await run("accept", async () => {
    const r = await api("/api/accept", { project: p.id, group: gid });
    setProject(r.project);
    state.selected = "accepted:" + r.accepted.id;
    toast(`Fix accepted: −${usd(r.accepted.saved_usd)}/month, −${rng(r.accepted.saved_kwh)} kWh/month`);
  });
  if (act === "review") {
    const body = { project: p.id, file: $("#incFile").value, code: $("#incCode").value, calls_per_month: $("#incCalls").value };
    try { state.review = await api("/api/review-change", body); } catch (err) { toast(err.message); }
    renderIncoming();
  }
  if (act === "ledger-reset") {
    if (!confirm("Clear every lesson in the equivalence ledger?")) return;
    await api("/api/ledger/reset", {});
    await refreshLedger();
    if (p?.sample) loadSample(p.sample);
  }
});

document.addEventListener("change", async (e) => {
  if (e.target.dataset.act !== "guard") return;
  const p = state.project;
  await run("guard", async () => setProject((await api("/api/guard", { project: p.id, group: state.selected, enabled: e.target.checked })).project));
});

const EXAMPLE = `import anthropic
import litellm

client = anthropic.Anthropic()


def is_urgent(ticket):
    msg = client.messages.create(
        model="claude-opus-4-1",
        max_tokens=1024,
        system="You triage support tickets. Answer yes if the ticket is urgent, otherwise no.",
        messages=[{"role": "user", "content": ticket}],
    )
    answer = msg.content[0].text.strip().lower()
    return answer == "yes"


def chat(history, question):
    history.append({"role": "user", "content": question})
    r = litellm.completion(model="gpt-4o", messages=history)
    text = r.choices[0].message.content
    history.append({"role": "assistant", "content": text})
    return text[:280]
`;

$("#pasteExample").addEventListener("click", () => { $("#pasteCode").value = EXAMPLE; });
$("#pasteDialog").addEventListener("close", async () => {
  if ($("#pasteDialog").returnValue !== "go") return;
  const code = $("#pasteCode").value;
  if (!code.trim()) { toast("Paste some code first"); return; }
  await run("load", async () => {
    setProject(await api("/api/load", { paste: { filename: $("#pasteName").value, code, calls_per_month: $("#pasteCalls").value } }));
    state.review = null;
    state.selected = state.project.groups[0]?.id || null;
    document.querySelectorAll("#projectTabs button").forEach((b) => b.classList.toggle("active", b.dataset.paste !== undefined));
  });
});

loadSample("stepup");
