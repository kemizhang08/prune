"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd = (x) => "$" + (Math.abs(x) >= 100 ? Math.round(x).toLocaleString() : (Math.round(x * 100) / 100).toLocaleString());
const cents = (x) => "$" + Number(x).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const about = (x) => "$" + (x >= 100 ? Math.round(x / 10) * 10 : Math.round(x)).toLocaleString();
const int = (x) => Math.round(x).toLocaleString();
const rng = (r) => `${Math.round(r[0])}–${Math.round(r[1])}`;
const mid = (r) => (r[0] + r[1]) / 2;
const pad2 = (n) => String(n).padStart(2, "0");

// ---------- plain language ----------

const NAMES = {
  classify_ticket: "Sorting support emails",
  extract_order_id: "Finding order numbers",
  answer_question: "Website chat helper",
  summarize_review: "Product review summaries",
  summarize: "Ticket summaries",
  run_returns_agent: "Returns assistant",
  categorize_transaction: "Sorting card payments",
  is_urgent: "Spotting urgent tickets",
  chat: "Chat replies",
  product_blurb: "Product page blurbs",
};
const friendly = (fn) => NAMES[fn] || fn.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

// What the change is, in a few words.
function changeName(f) {
  if (f.rule === "uncached_prompt") return /STORE_POLICY/.test(f.detail) ? "Cache the store policy" : "Cache the repeated instructions";
  if (f.rule === "max_tokens_high") { const m = f.bullet.match(/at (\d+) tokens/); return m ? `Cap answer length at ${m[1]} tokens` : "Cap answer length"; }
  if (f.rule === "model_too_big") return f.target_model ? `Smaller model (${f.target_model})` : "Smaller model";
  return {
    plain_code: "A simple rule instead of AI",
    full_history: "Trim the chat history",
    timer: "Stop redoing the same work",
    batchable: "Send in bulk at half price",
    retry_storm: "Calmer retries",
    duplicate_call: "Ask once, not twice",
    agent_unbounded: "A step limit for the assistant",
  }[f.rule] || f.title;
}
// Why, in one plain sentence.
const WHY = {
  model_too_big: "The code only needs a one-word answer, so a big AI model is more than the job needs.",
  plain_code: "A simple text rule finds this for free, every time.",
  uncached_prompt: "The same long instructions are sent on every request. Reusing them costs less and gives the same answers.",
  max_tokens_high: "The AI is allowed to write far more than anyone reads.",
  full_history: "The whole conversation is resent on every message.",
  timer: "A timer keeps asking about things it already answered.",
  batchable: "Nothing is waiting on these answers, so they can go in one bulk request.",
  retry_storm: "When something fails, it retries instantly and without end.",
  duplicate_call: "The same question is asked twice in a row.",
  agent_unbounded: "The assistant can keep going with no limit on steps.",
};

function proofOf(f, g) {
  if (!f.included) return { cls: "advice", text: "Advice only" };
  if (f.fix_kind === "model_change" || f.fix_kind === "less_context") {
    if (f.proof === "replay" && g?.status?.replay?.decision !== "accepted") return { cls: "pending", text: "Check pending" };
    return { cls: "checked", text: "Checked" };
  }
  return { cls: "same", text: "Same answer" };
}
function tag(f, g) {
  const p = proofOf(f, g);
  let extra = "";
  if (p.cls === "checked") {
    const rp = g?.status?.replay;
    if (f.proof === "ledger" && f.ledger) extra = ` · ${int(f.ledger.matched)}/${int(f.ledger.total)}`;
    else if (rp) extra = ` · ${int(rp.matched)}/${int(rp.total)}`;
  }
  return `<span class="tag ${p.cls}">${p.text}${extra}</span>`;
}

// ---------- state ----------

const TABS = ["find", "prove", "ship", "remember", "energy", "budgets"];
const state = { project: null, initialSites: {}, selected: null, busy: null, ledger: [], tab: "find", receipts: {}, lastSample: "stepup",
  incomingCheck: null, limits: {}, addedLimits: {}, threshold: null, editing: null, decision: null,
  catalog: null, energySteps: [], replayRuns: {} };

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
  toast._t = setTimeout(() => t.classList.remove("show"), 3400);
}

async function run(label, fn) {
  state.busy = label;
  render();
  try { await fn(); } catch (e) { toast(e.message); }
  state.busy = null;
  render();
}

function setProject(p, fresh) {
  state.project = p;
  if (fresh) {
    state.initialSites = Object.fromEntries(p.sites.map((s) => [s.id, s]));
    state.receipts = {};
    Object.assign(state, { incomingCheck: null, limits: {}, addedLimits: {}, threshold: null, editing: null, decision: null, replayRuns: {} });
    state.energySteps = [{ label: "Before Prune", kwh: p.initial.kwh }];
    state.selected = p.groups.find((g) => g.has_edits)?.id || p.groups[0]?.id || null;
  }
}

async function loadSample(sample) {
  state.lastSample = sample;
  $("#projectPick").value = sample;
  await run("load", async () => setProject(await api("/api/load", { sample }), true));
  refreshLedger();
  checkIncoming();
}

async function refreshLedger() {
  try { state.ledger = (await api("/api/ledger")).entries; } catch (e) { /* ignore */ }
  if (state.tab === "remember") renderRemember();
}

function hash(str) {
  let h = 2166136261;
  for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
function rand(seed) {
  let s = seed || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909)) >>> 0) / 4294967296;
}

function figures() {
  const p = state.project;
  const savedUsd = Math.max(0, p.initial.cost - p.totals.cost);
  const sub = (a, b) => [Math.max(0, a[0] - b[0]), Math.max(0, a[1] - b[1])];
  const ready = p.groups.filter((g) => g.has_edits);
  const sum = (k) => [0, 1].map((i) => ready.reduce((a, g) => a + g.summary[k][i], 0));
  const done = savedUsd > 0.5;
  return {
    done, ready,
    heroUsd: done ? savedUsd : ready.reduce((a, g) => a + g.summary.saved_usd, 0),
    kwh: done ? sub(p.initial.kwh, p.totals.kwh) : sum("saved_kwh"),
    kg: done ? sub(p.initial.kg_co2e, p.totals.kg_co2e) : sum("saved_kg_co2e"),
  };
}

// ---------- art ----------

function treeArt() {
  const p = state.project;
  const now = Object.fromEntries(p.sites.map((s) => [s.id, s.cost]));
  const ids = Object.keys(state.initialSites);
  const max = Math.max(1, ...ids.map((id) => state.initialSites[id].cost));
  const W = 600, H = 330, cx = W / 2;
  let out = `<svg class="tree" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <ellipse cx="${cx}" cy="${H - 6}" rx="280" ry="22" fill="url(#gGlow)"/>
    <line x1="0" y1="${H - 1}" x2="${W}" y2="${H - 1}" stroke="#26252b"/>`;
  const order = ids.slice().sort((a, b) => hash(a) - hash(b));
  const n = order.length || 1;
  out += `<path d="M${cx} ${H} C ${cx - 6} ${H - 60}, ${cx + 6} ${H - 120}, ${cx} ${H - 175}" stroke="#f4f2ee" stroke-width="7" fill="none" stroke-linecap="round"/>`;
  order.forEach((id, i) => {
    const r = rand(hash(id));
    const c0 = state.initialSites[id].cost, c1 = now[id] ?? 0;
    const frac = c0 > 0 ? Math.min(1, c1 / c0) : 1;
    const angle = (-78 + (156 * (i + 0.5)) / n) * Math.PI / 180;
    const len = 90 + 175 * Math.sqrt(c0 / max);
    const by = H - 90 - (i % 3) * 30 - r() * 12, bx = cx;
    const ex = bx + Math.sin(angle) * len * 1.1, ey = by - Math.cos(angle) * len * 0.75;
    const qx = bx + Math.sin(angle) * len * 0.35 + (r() - .5) * 30, qy = by - len * 0.55;
    const at = (t) => [(1 - t) ** 2 * bx + 2 * (1 - t) * t * qx + t * t * ex, (1 - t) ** 2 * by + 2 * (1 - t) * t * qy + t * t * ey];
    const sw = 1.5 + 4 * Math.sqrt(c0 / max);
    out += `<g><title>${esc(friendly(state.initialSites[id].function))}: ${usd(c1)} a month${c1 < c0 ? `, was ${usd(c0)}` : ""}</title>`;
    out += `<path d="M${bx} ${by} Q ${qx} ${qy} ${ex} ${ey}" stroke="#34323a" stroke-width="${sw}" fill="none" stroke-dasharray="2 6" stroke-linecap="round"/>`;
    if (frac > 0.02) {
      const pts = [];
      for (let k = 0; k <= 24; k++) pts.push(at((k / 24) * frac));
      out += `<path d="M${pts.map((q) => q.map((v) => v.toFixed(1)).join(" ")).join(" L")}" stroke="#f4f2ee" stroke-width="${sw}" fill="none" stroke-linecap="round"/>`;
      const leaves = 2 + Math.round(10 * frac * Math.sqrt(c0 / max) + r() * 3);
      for (let k = 0; k < leaves; k++) {
        const [lx, ly] = at((0.35 + 0.65 * r()) * frac);
        const rot = (angle * 180 / Math.PI) + (r() - .5) * 120;
        const s = 8 + r() * 7 * Math.sqrt(c0 / max);
        out += `<ellipse cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" rx="${s.toFixed(1)}" ry="${(s * 0.42).toFixed(1)}" transform="rotate(${rot.toFixed(0)} ${lx.toFixed(1)} ${ly.toFixed(1)})" fill="url(#gPurple)" opacity="${(.65 + r() * .35).toFixed(2)}"/>`;
      }
    }
    if (frac < 0.98) {
      const [kx, ky] = at(Math.max(frac, 0.04));
      out += `<rect x="${(kx - 4).toFixed(1)}" y="${(ky - 4).toFixed(1)}" width="8" height="8" fill="#4fae8a" transform="rotate(45 ${kx.toFixed(1)} ${ky.toFixed(1)})"/>`;
      for (let k = 0; k < 3; k++) {
        out += `<ellipse class="fall" style="--dx:${((r() - .5) * 80).toFixed(0)}px;animation-delay:${(k * 1.1 + r()).toFixed(2)}s" cx="${kx.toFixed(1)}" cy="${(ky + 6).toFixed(1)}" rx="7" ry="2.8" fill="${k === 1 ? "#ffffff" : "#c4b5fd"}"/>`;
      }
    }
    out += `</g>`;
  });
  return out + `</svg>`;
}

function skyArt(kg) {
  const count = Math.max(6, Math.min(30, Math.round(mid(kg) / 2)));
  const r = rand(7);
  let bubbles = "";
  for (let i = 0; i < count; i++) {
    const x = 30 + r() * 1140, y = 120 + r() * 30, s = 2.5 + r() * 6;
    bubbles += `<circle class="bubble" style="animation-delay:${(r() * 6).toFixed(2)}s;animation-duration:${(5 + r() * 4).toFixed(1)}s" cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${s.toFixed(1)}" fill="none" stroke="#c4b5fd" stroke-width="1.3"/>`;
  }
  return `<svg viewBox="0 0 1200 160" preserveAspectRatio="none" aria-hidden="true">
    ${bubbles}
    <path d="M0 110 C 180 70, 340 130, 520 98 S 860 60, 1200 102 V160 H0z" fill="#241a40"/>
    <path d="M0 128 C 240 104, 400 146, 640 124 S 1000 108, 1200 130 V160 H0z" fill="#4c1d95" opacity=".9"/>
    <path d="M0 144 C 280 132, 520 156, 760 140 S 1080 134, 1200 146 V160 H0z" fill="#8b5cf6" opacity=".75"/>
  </svg>`;
}

function leavesArt() {
  const r = rand(11);
  let s = "";
  for (let i = 0; i < 11; i++) {
    s += `<ellipse class="fall" style="--dx:${((r() - .5) * 70).toFixed(0)}px;animation-delay:${(r() * 3).toFixed(2)}s" cx="${(30 + r() * 360).toFixed(0)}" cy="${(8 + r() * 26).toFixed(0)}" rx="9" ry="3.6" fill="${i % 4 === 0 ? "#ffffff" : "url(#gPurple)"}"/>`;
  }
  return `<svg class="leaves" viewBox="0 0 420 140" aria-hidden="true">${s}</svg>`;
}

function sproutArt() {
  return `<svg viewBox="0 0 260 180" aria-hidden="true">
    <line x1="10" y1="160" x2="250" y2="160" stroke="#26252b"/>
    <ellipse cx="130" cy="160" rx="90" ry="12" fill="url(#gGlow)"/>
    <path d="M130 158 C 128 128, 132 104, 130 80" stroke="#f4f2ee" stroke-width="3" fill="none" stroke-linecap="round"/>
    <path class="breathe" d="M130 96 C 106 94, 94 74, 96 58 C 116 60, 128 76, 130 96z" fill="url(#gPurple)"/>
    <path class="breathe" d="M130 84 C 152 80, 166 60, 164 44 C 144 48, 132 64, 130 84z" fill="url(#gGreen)"/>
  </svg>`;
}

// ---------- FIND ----------

function ribbon() {
  const p = state.project;
  const cutBy = Object.fromEntries(p.groups.filter((g) => g.has_edits).map((g) => [g.id, g.summary.saved_usd]));
  const items = p.sites.filter((s) => s.cost > 0.005).map((s) => ({ ...s, cut: Math.min(s.cost, cutBy[s.id] || 0) })).sort((a, b) => b.cost - a.cost);
  const total = items.reduce((a, b) => a + b.cost, 0) || 1;
  const cutTotal = items.reduce((a, b) => a + b.cut, 0);
  let x = 0;
  const placed = items.map((s) => { const w = (s.cost / total) * 100; const o = { ...s, x, w }; x += w; return o; });
  const labelled = placed.filter((s) => s.w >= 12);
  const rest = placed.filter((s) => s.w < 12);
  const line = (s) => `${esc(friendly(s.function))} ${usd(s.cost)}${s.cut > 0.5 ? ` <em>−${usd(s.cut)}</em>` : ""}`;
  return `
    <div class="section-head"><h2>Where the money goes</h2>
      <div class="legend"><span><i class="k"></i>Kept</span><span><i class="c"></i>Prune cuts ${usd(cutTotal)}</span><span>${usd(total)} a month in total</span></div></div>
    <div class="ribbon">${placed.map((s) => `<div class="seg" data-open="${esc(s.id)}" style="width:${s.w}%" title="${esc(friendly(s.function))}: ${usd(s.cost)} a month">
      <div class="keep" style="width:${((s.cost - s.cut) / s.cost) * 100}%"></div><div class="cut" style="width:${(s.cut / s.cost) * 100}%"></div></div>`).join("")}</div>
    <div class="ticks desk">${labelled.map((s) => `<div class="tick" style="left:${s.x}%;max-width:${s.w}%"><b>${esc(friendly(s.function))}</b><span>${usd(s.cost)}${s.cut > 0.5 ? ` · <em>−${usd(s.cut)}</em>` : ""}</span></div>`).join("")}</div>
    ${rest.length ? `<div class="small-list desk">Also: ${rest.map(line).join(" · ")}</div>` : ""}
    <div class="small-list mob">${placed.map(line).join("<br>")}</div>`;
}

function rowsHtml() {
  const p = state.project;
  const open = p.groups.filter((g) => g.has_edits), tips = p.groups.filter((g) => !g.has_edits);
  let i = 0;
  const row = (g, quiet) => {
    const changes = g.findings.filter((f) => quiet || f.included);
    return `<button class="row ${quiet ? "quiet" : ""}" data-open="${esc(g.id)}">
      <span class="ix">${pad2(++i)}</span>
      <span class="nm">${esc(friendly(g.function))}</span>
      <span class="ch">${changes.slice(0, 3).map((f) => `<div>${esc(changeName(f))} ${tag(f, g)}</div>`).join("")}${changes.length > 3 ? `<div>+${changes.length - 3} more</div>` : ""}</span>
      <span class="usd">${quiet ? "—" : about(g.summary.saved_usd)}</span>
      <span class="go">${quiet ? "Read" : "Fix it"}</span></button>`;
  };
  const shipped = p.accepted.map((a) => `<button class="row shipped" data-open="shipped:${esc(a.id)}"><span class="ix">${pad2(++i)}</span>
      <span class="nm">${esc(friendly(a.function))}</span><span class="ch"><span class="tag shipped">Shipped</span></span>
      <span class="usd">−${about(a.saved_usd)}</span><span class="go">Receipt</span></button>`);
  return `<div class="rows">${open.map((g) => row(g)).join("")}${tips.map((g) => row(g, true)).join("")}${shipped.join("")}</div>`;
}

function renderFind() {
  const el = $("#view-find");
  const p = state.project;
  if (!p) { el.innerHTML = ""; return; }
  const f = figures();
  const km = Math.round(mid(f.kg) / EQUIV.kgPerKm);
  const top = f.ready[0];
  el.innerHTML = `
    <div class="wrap hero">
      <div>
        <div class="eyebrow">${esc(p.name)} · ${p.sites.length} AI call${p.sites.length === 1 ? "" : "s"} read</div>
        <div class="num">${usd(f.heroUsd)}</div>
        <div class="per">${f.done ? `saved every month, from ${usd(p.initial.cost)} down to ${usd(p.totals.cost)}` : `a month Prune can cut, out of ${usd(p.totals.cost)}`}</div>
        <div class="facts">
          <div class="fact"><div class="v">${rng(f.kwh)}<small>kWh</small></div><div class="k">less energy a month</div></div>
          <div class="fact"><div class="v">${f.ready.length}</div><div class="k">fix${f.ready.length === 1 ? "" : "es"} ready</div></div>
        </div>
        ${top ? `<button class="primary" data-open="${esc(top.id)}">Start with ${esc(friendly(top.function).toLowerCase())}<span class="arr">→</span></button>` : `<span class="muted">Nothing left to fix here.</span>`}
      </div>
      <div>${treeArt()}</div>
    </div>
    <div class="sky">
      <div class="caption"><div class="eyebrow">${f.done ? "Carbon avoided" : "Carbon you could avoid"}</div>
        <div class="v">${rng(f.kg)} <small>kg CO₂ a month · like skipping ${int(km)} km of driving</small></div></div>
      ${skyArt(f.kg)}
    </div>
    <div class="wrap"><div class="section">${ribbon()}</div>
      <div class="section"><div class="section-head"><h2>What Prune found</h2>
        <div class="legend"><span class="tag same">Same answer</span><span class="tag checked">Checked</span><span class="tag advice">Advice only</span></div></div>
        ${p.groups.length || p.accepted.length ? rowsHtml() : `<div class="empty">${sproutArt()}<p>No AI waste found here.</p></div>`}</div></div>`;
}

// ---------- PROVE ----------

function renderProve() {
  const el = $("#view-prove");
  const p = state.project;
  if (!p) { el.innerHTML = ""; return; }
  const g = p.groups.find((x) => x.id === state.selected);
  if (!g) {
    el.innerHTML = `<div class="wrap"><div class="empty">${sproutArt()}<div><p>Pick something to fix and Prune will prove it's safe here.</p>
      <button class="outline" data-tab="find">See what Prune found</button></div></div></div>`;
    return;
  }
  const st = g.status, sm = g.summary;
  const busy = (k) => (state.busy === k ? '<span class="spin"></span>' : "");
  const dis = state.busy ? "disabled" : "";
  const changes = g.findings;
  const mf = changes.find((f) => f.rule === "model_too_big" && f.included);

  const head = `<div class="fix-head"><div><button class="link" data-tab="find">← Everything Prune found</button>
      <h1>${esc(friendly(g.function))}</h1></div>
      ${g.has_edits ? `<div class="save">${about(sm.saved_usd)} a month<small>${usd(sm.cost_before)} → ${usd(sm.cost_after)} · ${rng(sm.saved_kwh)} kWh less</small></div>` : `<div class="save muted">Advice</div>`}</div>`;
  const list = `<div class="changes">${changes.map((f, i) => `<div class="change ${f.included ? "" : "off"}"><span class="ix">${pad2(i + 1)}</span>
      <div><div class="t">${esc(changeName(f))}</div><div class="d">${esc(WHY[f.rule] || "")}${f.included ? "" : " Left out of this fix."}</div></div>${tag(f, g)}</div>`).join("")}</div>`;

  if (!g.has_edits) {
    el.innerHTML = `<div class="wrap">${head}${list}<div class="proof"><div class="side"><div class="eyebrow">Advice only</div></div>
      <div><p>Prune can't prove these are safe yet, so it never applies them on its own. They stay here as suggestions.</p></div></div></div>`;
    return;
  }

  const testsOk = st.tests?.passed;
  const safety = `<div class="proof"><div class="side"><div class="eyebrow">Proof 1</div><div class="serif">Nothing breaks</div></div><div>
    ${st.tests ? `<div class="result ${st.tests.passed ? "ok" : "bad"}"><span class="mark">${st.tests.passed ? "✓" : "!"}</span>
        ${st.tests.passed ? (st.tests.kind === "tests" ? `All ${st.tests.tests_run} of your checks pass with the fix` : "The code still runs with the fix") : "One of your checks failed, so this fix is off"}</div>`
      : `<p>Prune makes the change in a sealed copy of your project and runs your own checks. If any fail, the fix is dropped.</p>
        <button class="primary" data-act="tests" ${dis}>${busy("tests")}Run the checks</button>`}</div></div>`;

  let answers = "";
  if (mf) {
    let body;
    const rp = st.replay;
    if (mf.proof === "ledger") {
      body = `<div class="big-line">Seen before: <em>${int(mf.ledger.matched)} of ${int(mf.ledger.total)}</em> answers matched on a similar task.</div>
        <p style="margin-top:14px">Prune remembered this from an earlier fix, so no new answer check is needed.</p>`;
    } else if (!rp) {
      body = `<p>Prune asks the current AI and the smaller one the same ${int(g.recorded_requests)} past questions, with names and addresses removed, then shows you every answer that changes.</p>
        <button class="primary" data-act="replay" ${!testsOk || state.busy ? "disabled" : ""}>${busy("replay")}Check ${int(g.recorded_requests)} past answers</button>
        ${testsOk ? "" : `<p style="margin-top:12px;font-size:13px">Run the checks first.</p>`}`;
    } else {
      const diffs = rp.rows.filter((r) => !r.same);
      const dots = Array.from({ length: rp.total }, (_, i) => `<i class="${i < diffs.length ? "diff" : ""}" style="animation-delay:${(i % 50) * 8 + Math.floor(i / 50) * 20}ms"></i>`);
      const r = rand(42); for (let i = dots.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [dots[i], dots[j]] = [dots[j], dots[i]]; }
      body = `<div class="big-line"><em>${int(rp.matched)} of ${int(rp.total)}</em> answers stayed the same.</div>
        <div class="dots">${dots.join("")}</div>
        <div class="eyebrow">The ${diffs.length} that changed</div>
        <div class="quotes">${diffs.map((d) => `<div><span class="q">“${esc(d.input)}”</span><span class="a">${esc(d.before)} → <b>${esc(d.after)}</b></span></div>`).join("")}</div>
        ${st.guard ? `<label class="switch"><input type="checkbox" data-act="guard" ${st.guard.enabled ? "checked" : ""} ${rp.decision ? "disabled" : ""}>
          <span>Keep the bigger AI for messages that mention ${st.guard.keywords.map((k) => `“${esc(k)}”`).join(" or ")}</span></label>` : ""}
        ${rp.decision ? `<div class="result ${rp.decision === "accepted" ? "ok" : "bad"}"><span class="mark">${rp.decision === "accepted" ? "✓" : "✕"}</span>${rp.decision === "accepted" ? "You approved these answers" : "You kept the current AI"}</div>`
          : `<div class="btns"><button class="primary" data-act="decide" data-decision="accepted" ${dis}>${busy("decide")}These look right</button>
             <button class="link" data-act="decide" data-decision="rejected" ${dis}>Keep the current AI</button></div>`}`;
    }
    answers = `<div class="proof"><div class="side"><div class="eyebrow">Proof 2</div><div class="serif">Same answers</div></div><div>${body}</div></div>`;
  }

  const diffText = Object.values(st.diffs).join("\n").split("\n").filter((l) => !/^(\+\+\+|---|@@)/.test(l))
    .map((l) => `<span class="${l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}">${esc(l) || " "}</span>`).join("\n");

  el.innerHTML = `<div class="wrap">${head}${list}${safety}${answers}
    <details class="code"><summary>Show the exact code change</summary><pre>${diffText}</pre></details>
    <div class="next"><button class="primary" data-tab="ship" ${st.can_accept ? "" : "disabled"}>See the receipt<span class="arr">→</span></button></div></div>`;
}

// ---------- SHIP ----------

function receiptHtml(r, shipped) {
  const net = r.saved_usd - r.review_cost;
  return `<div class="receipt">
    <h3>Prune</h3><div class="sub">${esc(r.name)} · ${esc(r.date)}</div>
    ${r.changes.map((c) => `<div class="ln"><span>${esc(c.name)}</span><span>${esc(c.proof)}</span></div>`).join("")}
    <hr>
    <div class="ln"><span>Before</span><span>${cents(r.cost_before)}/mo</span></div>
    <div class="ln"><span>After</span><span>${cents(r.cost_after)}/mo</span></div>
    <div class="ln em"><span>Saved</span><span>${cents(r.saved_usd)}/mo</span></div>
    <hr>
    <div class="ln"><span>Energy saved</span><span>${rng(r.saved_kwh)} kWh/mo</span></div>
    <div class="ln"><span>Carbon avoided</span><span>${rng(r.saved_kg)} kg CO₂/mo</span></div>
    <hr>
    <div class="ln"><span>This review cost</span><span>−${cents(r.review_cost)}</span></div>
    <div class="ln net"><span>Net, first month</span><span>${cents(net)}</span></div>
    <div class="note">Dollars come from your usage. Energy and carbon are ranges.</div>
    ${shipped ? `<div class="stamp">SHIPPED</div>` : ""}
  </div>`;
}

function receiptFor(g) {
  return {
    name: friendly(g.function),
    date: new Date().toISOString().slice(0, 10),
    changes: g.findings.filter((f) => f.included).map((f) => ({ name: changeName(f), proof: proofOf(f, g).text })),
    cost_before: g.summary.cost_before, cost_after: g.summary.cost_after, saved_usd: g.summary.saved_usd,
    saved_kwh: g.summary.saved_kwh, saved_kg: g.summary.saved_kg_co2e,
    review_cost: g.status.replay?.replay_cost_usd || 0,
  };
}

function renderShip() {
  const el = $("#view-ship");
  const p = state.project;
  if (!p) { el.innerHTML = ""; return; }
  const sel = state.selected || "";
  const shippedId = sel.startsWith("shipped:") ? sel.slice(8) : null;
  const g = !shippedId && p.groups.find((x) => x.id === sel && x.has_edits);
  const busy = state.busy === "accept" ? '<span class="spin"></span>' : "";
  let main;
  if (shippedId) {
    const a = p.accepted.find((x) => x.id === shippedId);
    const r = state.receipts[shippedId];
    main = `<div class="ship"><div class="lead"><div class="eyebrow">Shipped</div><h1>${esc(friendly(a.function))}</h1>
        ${leavesArt()}
        <div class="rollout">${a.rollout.map((x) => `<div><b>${x.pct}%</b><span>${esc(x.note)}</span></div>`).join("")}</div></div>
      ${r ? receiptHtml(r, true) : `<div class="receipt"><h3>Prune</h3><div class="ln em"><span>Saved</span><span>${cents(a.saved_usd)}/mo</span></div><div class="stamp">SHIPPED</div></div>`}</div>`;
  } else if (g) {
    const st = g.status;
    main = `<div class="ship"><div class="lead"><div class="eyebrow">Ready to ship</div><h1>${esc(friendly(g.function))}</h1>
        <p>${st.can_accept ? "Both proofs are in. Shipping opens the change for your team and rolls it out to a small share of people first." : esc(st.blocked_by || "Finish the proofs first.")}</p>
        <div class="btns" style="margin-top:26px">
          <button class="primary" data-act="accept" ${st.can_accept && !state.busy ? "" : "disabled"}>${busy}Ship it · save ${about(g.summary.saved_usd)}/mo</button>
          ${st.can_accept ? "" : `<button class="link" data-tab="prove">Back to the proofs</button>`}</div></div>
      ${receiptHtml(receiptFor(g), false)}</div>`;
  } else {
    main = `<div class="empty">${sproutArt()}<div><p>Pick a fix and prove it first. Its receipt shows up here.</p><button class="outline" data-tab="find">See what Prune found</button></div></div>`;
  }
  const total = p.accepted.reduce((s, a) => s + a.saved_usd, 0);
  const history = p.accepted.length ? `<div class="history"><div class="section-head"><h2>Shipped so far</h2><span class="serif green" style="font-size:34px">−${usd(total)}/mo</span></div>
    <div class="rows">${p.accepted.map((a, i) => `<button class="row shipped" data-open="shipped:${esc(a.id)}"><span class="ix">${pad2(i + 1)}</span>
      <span class="nm">${esc(friendly(a.function))}</span><span class="ch">${rng(a.saved_kwh)} kWh less</span><span class="usd">−${about(a.saved_usd)}</span></button>`).join("")}</div></div>` : "";
  el.innerHTML = `<div class="wrap">${main}${history}</div>`;
}

// ---------- REMEMBER ----------

function renderRemember() {
  const el = $("#view-remember");
  const e = state.ledger;
  const short = (x) => `${x.label_count ? `${x.label_count}-label sorting` : "Short answers"}: small model matched ${(x.match_rate * 100).toFixed(1)}%`;
  el.innerHTML = `<div class="wrap"><div class="fix-head"><div><div class="eyebrow">Remember</div><h1>What Prune knows now</h1></div>
      ${e.length ? `<button class="link" data-act="ledger-reset">Forget everything</button>` : ""}</div>
    <p class="muted" style="max-width:640px;margin:-12px 0 36px">Each approved answer check becomes a pattern. The next time Prune sees a similar task, anywhere, it can suggest the cheaper choice with confidence and skip the check. Only the pattern is kept. No messages or answers are stored.</p>
    ${e.length ? `<div class="lessons">${e.slice().reverse().map((x) => {
      const miss = x.matched < x.total ? Math.max(1, Math.round((1 - x.match_rate) * 60)) : 0;
      const bars = Array.from({ length: 60 }, (_, i) => { const same = i < 60 - miss;
        return `<rect x="${i * 10}" y="${same ? 6 : 26}" width="5" height="${same ? 52 : 32}" fill="${same ? "url(#gPurple)" : "#ffffff"}"/>`; }).join("");
      return `<div class="lesson"><div><div class="eyebrow">${x.decision === "accepted" ? "Approved" : "Turned down"} · ${esc(x.recorded_at.split(" ")[0])}</div>
          <div class="serif" style="margin-top:10px">${esc(short(x))}</div></div>
        <div><svg viewBox="0 0 600 64" preserveAspectRatio="none">${bars}</svg>
          <div class="m">${int(x.matched)}/${int(x.total)} matched · ${esc(x.from_model)} → ${esc(x.to_model)}</div></div></div>`;
    }).join("")}</div>`
      : `<div class="empty">${sproutArt()}<p>Nothing yet. Approve an answer check in Prove and the pattern lands here.</p></div>`}</div>`;
}

// ---------- ENERGY ----------

// Everyday comparisons, all estimates on the middle of each range.
const EQUIV = {
  kwhPerPhoneCharge: 0.015, // a full smartphone charge, ~12–19 Wh
  kwhPerHomeDay: 29, // average US home, EIA: ~10,800 kWh a year
  kgPerKm: 0.25, // average passenger car, EPA: ~400 g CO₂ a mile
};

function energyBubbles(kwh) {
  const count = Math.max(10, Math.min(70, Math.round(mid(kwh) / 1.6)));
  const r = rand(23);
  let s = "";
  for (let i = 0; i < count; i++) {
    const x = 20 + r() * 1160, y = 300 + r() * 80, rad = 3 + r() * 9;
    s += `<circle class="bubble slow" style="animation-delay:${(r() * 9).toFixed(2)}s;animation-duration:${(8 + r() * 6).toFixed(1)}s" cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${rad.toFixed(1)}" fill="${i % 9 === 0 ? "rgba(79,174,138,.12)" : "none"}" stroke="${i % 9 === 0 ? "#4fae8a" : "#c4b5fd"}" stroke-width="1.3"/>`;
  }
  return `<svg class="field" viewBox="0 0 1200 420" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
    <ellipse cx="600" cy="430" rx="700" ry="120" fill="url(#gGlow)"/>
    ${s}
    <path d="M0 340 C 200 300, 380 360, 600 326 S 960 290, 1200 330 V420 H0z" fill="#241a40"/>
    <path d="M0 370 C 260 344, 440 392, 700 366 S 1040 350, 1200 372 V420 H0z" fill="#4c1d95" opacity=".9"/>
    <path d="M0 396 C 300 384, 560 410, 820 394 S 1100 388, 1200 398 V420 H0z" fill="#8b5cf6" opacity=".75"/>
  </svg>`;
}

function glyphRow(kind, n) {
  const shown = Math.min(n, 40);
  const g = {
    phone: `<svg viewBox="0 0 12 20"><rect x="1" y="1" width="10" height="18" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="3" y="9" width="6" height="8" fill="currentColor"/></svg>`,
    home: `<svg viewBox="0 0 20 20"><path d="M2 10 L10 3 L18 10 V18 H2z" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="8" y="12" width="4" height="6" fill="currentColor"/></svg>`,
  }[kind];
  return `<div class="glyphs ${kind}">${Array.from({ length: shown }, (_, i) => `<i style="animation-delay:${i * 25}ms">${g}</i>`).join("")}${n > shown ? `<span>+${int(n - shown)}</span>` : ""}</div>`;
}

function reviewWh() {
  // Prune's own footprint: the answer re-checks it ran. Analysis reads code without AI.
  const per = state.catalog?.energy_per_1k;
  let lo = 0, hi = 0;
  for (const r of Object.values(state.replayRuns)) {
    const size = state.catalog?.models?.[r.model]?.size || "small";
    const e = per ? per[size] : [0.00002, 0.00006];
    const k = (r.calls * r.tokens) / 1000;
    lo += k * e[0] * 1000;
    hi += k * e[1] * 1000;
  }
  return [lo, hi];
}

function renderEnergy() {
  const el = $("#view-energy");
  const p = state.project;
  if (!p) { el.innerHTML = ""; return; }
  const f = figures();
  const kwh = f.kwh, kg = f.kg;
  const m = mid(kwh);
  const phones = Math.round(m / EQUIV.kwhPerPhoneCharge);
  const homeDays = m / EQUIV.kwhPerHomeDay;
  const km = Math.round(mid(kg) / EQUIV.kgPerKm);

  // Over time: one step per shipped fix, then what's left if every ready fix ships.
  const steps = state.energySteps.slice();
  const readyKwh = [0, 1].map((i) => f.ready.reduce((a, g) => a + g.summary.saved_kwh[i], 0));
  const projected = [Math.max(0, p.totals.kwh[0] - readyKwh[0]), Math.max(0, p.totals.kwh[1] - readyKwh[1])];
  const cols = [...steps.map((s, i) => ({ ...s, now: i === steps.length - 1 })), ...(f.ready.length ? [{ label: "If every fix ships", kwh: projected, projected: true }] : [])];
  const top = Math.max(...cols.map((c) => c.kwh[1]), 1);

  // Which fixes save the most energy.
  const fixes = [
    ...p.accepted.map((a) => ({ name: friendly(a.function), kwh: a.saved_kwh, shipped: true })),
    ...f.ready.map((g) => ({ name: friendly(g.function), kwh: g.summary.saved_kwh, shipped: false })),
  ].sort((a, b) => mid(b.kwh) - mid(a.kwh));
  const fmax = Math.max(...fixes.map((x) => x.kwh[1]), 1);

  const wh = reviewWh();
  const net = [Math.max(0, kwh[0] - wh[1] / 1000), Math.max(0, kwh[1] - wh[0] / 1000)];
  const share = kwh[0] > 0 ? (mid(wh) / 1000) / mid(kwh) : 0;
  const per = state.catalog?.energy_per_1k || { large: [0.00022, 0.00061], medium: [0.00008, 0.00022], small: [0.00002, 0.00006] };
  const grid = state.catalog?.grid_kg_per_kwh || [0.25, 0.45];
  const whNum = (x) => (x >= 10 ? Math.round(x).toLocaleString() : x.toFixed(2));
  const whRange = (r) => `${whNum(r[0] * 1000)}–${whNum(r[1] * 1000)} Wh`;

  el.innerHTML = `
    <div class="energy-hero">
      ${energyBubbles(kwh)}
      <div class="hero-tree">${treeArt()}</div>
      <div class="wrap">
        <div class="eyebrow">${f.done ? "Energy saved" : "Energy Prune can save"} · ${esc(p.name)}</div>
        <div class="num">${rng(kwh)}<span class="unit">kWh</span></div>
        <div class="per">every month, and ${rng(kg)} kg of CO₂ that never reaches the air</div>
      </div>
    </div>

    <div class="wrap">
      <div class="section"><div class="section-head"><h2>What that's like</h2><span class="legend">Estimates, using the middle of each range</span></div>
        <div class="equiv">
          <div><div class="v">${int(phones)}</div><div class="k">phone charges a month</div>${glyphRow("phone", Math.round(phones / 250))}<div class="g-note">each = 250 charges</div></div>
          <div><div class="v">${homeDays >= 10 ? int(homeDays) : homeDays.toFixed(1)}</div><div class="k">days of power for an average home</div>${glyphRow("home", Math.max(1, Math.round(homeDays)))}<div class="g-note">each = one home for a day</div></div>
          <div><div class="v">${int(km)} km</div><div class="k">of driving avoided, in carbon terms</div>
            <div class="road"><i style="width:${Math.min(100, (km / 400) * 100)}%"></i></div><div class="g-note">${int(km * 0.621)} miles</div></div>
        </div></div>

      <div class="section"><div class="section-head"><h2>Energy used each month</h2>
          <span class="legend"><span><i class="k"></i>Likely range</span>${f.ready.length ? `<span><i class="pg"></i>After the fixes still waiting</span>` : ""}</span></div>
        <div class="steps">${cols.map((c) => `<div class="stepcol ${c.projected ? "proj" : ""} ${c.now ? "now" : ""}">
            <div class="val">${rng(c.kwh)}<small> kWh</small></div>
            <div class="track"><div class="hi" style="height:${(c.kwh[1] / top) * 100}%"></div><div class="lo" style="height:${(c.kwh[0] / top) * 100}%"></div></div></div>`).join("")}</div>
        <div class="steplabs">${cols.map((c) => `<span class="${c.projected ? "proj" : ""}">${esc(c.label)}</span>`).join("")}</div>
        <p class="muted note">${p.accepted.length ? `Each column is one fix shipped.` : `Ship a fix and a new column appears here.`} The tall faint part is the high end of the estimate, the solid part the low end.</p></div>

      <div class="section"><div class="section-head"><h2>Biggest energy savers</h2><span class="legend">kWh a month</span></div>
        ${fixes.length ? `<div class="savers">${fixes.map((x, i) => `<div class="saver"><span class="ix">${pad2(i + 1)}</span><span class="n">${esc(x.name)}</span>
            <div class="rbar"><i style="left:${(x.kwh[0] / fmax) * 100}%;width:${((x.kwh[1] - x.kwh[0]) / fmax) * 100}%"></i><b style="width:${(x.kwh[0] / fmax) * 100}%"></b></div>
            <span class="v">${rng(x.kwh)}</span><span class="tag ${x.shipped ? "shipped" : "same"}">${x.shipped ? "Shipped" : "Ready"}</span></div>`).join("")}</div>`
          : `<p class="muted">No energy fixes in this project yet.</p>`}</div>

      <div class="section net">
        <div><div class="eyebrow">Net impact</div>
          <div class="big-line">Saving ${rng(kwh)} kWh a month cost <em>${whRange([wh[0] / 1000, wh[1] / 1000])}</em> of Prune's own energy.</div>
          <p class="muted">${mid(wh) > 0 ? `That's what re-checking past answers on the smaller model used, about ${share < 0.001 ? "less than 0.1%" : (share * 100).toFixed(1) + "%"} of one month's savings. Reading your code uses no AI.` : `Reading your code uses no AI, so this review has used almost no energy so far. Answer checks add a little, and they show up here.`}</p></div>
        <div class="netbox"><div class="ln"><span>Saved a month</span><span>${rng(kwh)} kWh</span></div>
          <div class="ln"><span>Prune's own use</span><span>−${whRange([wh[0] / 1000, wh[1] / 1000])}</span></div>
          <div class="ln total"><span>Net, first month</span><span class="green">${rng(net)} kWh</span></div></div>
      </div>

      <div class="section method"><div class="section-head"><h2>How we estimate this</h2></div>
        <div class="formula"><span>Words processed<small>tokens, from your usage</small></span><b>×</b><span>Energy per 1,000 tokens<small>a low–high range by model size</small></span><b>×</b><span>Grid carbon<small>${grid[0]}–${grid[1]} kg CO₂ per kWh</small></span></div>
        <div class="ranges">${Object.entries(per).map(([k, v]) => `<div><span>${k === "large" ? "Large models" : k === "medium" ? "Mid-size models" : "Small models"}</span><span>${whRange(v)} per 1,000 tokens</span></div>`).join("")}</div>
        <p class="muted">AI companies don't publish energy use per model, so Prune always shows a range, never one exact number. Dollar figures come straight from your bill and are exact. Reused (cached) instructions count at a tenth, since they skip most of the work. Sources:</p>
        <ul class="sources">${(state.catalog?.sources || []).map((s) => `<li>${esc(s)}</li>`).join("")}<li>Comparisons: EIA average US home use; EPA average car emissions per mile.</li></ul></div>
    </div>`;
}

// ---------- BUDGETS ----------

const FEATURE_NAMES = {
  "support-triage": "Support email sorting",
  "ask-ai-widget": "Website chat helper",
  "merch-digest": "Review summaries",
  "returns-agent": "Returns assistant",
  storefront: "Product pages",
  "spending-insights": "Spending insights",
};
const featureName = (k) => FEATURE_NAMES[k] || k.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());

function budgetRows() {
  const p = state.project;
  const rows = p.budgets.map((b) => ({ key: b.feature, cost: b.cost, limit: state.limits[b.feature] ?? b.budget }));
  for (const [k, v] of Object.entries(state.addedLimits)) rows.push({ key: k, cost: 0, limit: v });
  return rows;
}

// The waiting change, judged against the limits as they are right now (edits included).
function waitingChange(rows) {
  const r = state.incomingCheck, inc = state.project.incoming;
  if (!r || !inc) return null;
  const threshold = state.threshold ?? state.project.approval_threshold;
  const row = rows.find((x) => x.key === r.check.feature);
  const after = (row ? row.cost : 0) + r.added_usd;
  const reasons = [];
  if (r.added_usd > threshold) reasons.push(`That's more than the ${usd(threshold)} a month you allow any single change to add.`);
  if (row && after > row.limit) reasons.push(`It would take ${featureName(row.key)} to ${usd(after)} a month, over its ${usd(row.limit)} limit.`);
  const fn = r.items[0]?.function;
  return { r, inc, row, added: r.added_usd, reasons, name: fn ? friendly(fn) : "This change", feature: row?.key };
}

function limitRow(row, pending) {
  const editing = state.editing === row.key;
  const extra = pending && pending.feature === row.key && !state.decision ? pending.added : 0;
  const max = Math.max(row.cost + extra, row.limit, 1) * 1.08;
  const within = Math.min(row.cost, row.limit), over = Math.max(0, row.cost - row.limit);
  const status = row.cost > row.limit ? `<b>Over by $${int(row.cost - row.limit)}</b>` : `$${int(row.limit - row.cost)} left`;
  return `<div class="limit ${row.cost > row.limit ? "over" : ""}">
    <span class="n">${esc(featureName(row.key))}</span>
    <div class="bar" title="${usd(row.cost)} spent of ${usd(row.limit)}">
      <i style="width:${(within / max) * 100}%"></i>
      ${over ? `<s style="left:${(row.limit / max) * 100}%;width:${(over / max) * 100}%"></s>` : ""}
      ${extra ? `<em style="left:${(row.cost / max) * 100}%;width:${(extra / max) * 100}%"></em>` : ""}
      <u style="left:${(row.limit / max) * 100}%"></u></div>
    ${editing
      ? `<span class="s edit">$<input id="limitInput" type="number" min="0" value="${Math.round(row.limit)}"> a month</span>
         <span class="acts"><button class="link" data-act="limit-save" data-key="${esc(row.key)}">Save</button></span>`
      : `<span class="s">${usd(row.cost)} of ${usd(row.limit)}<br><small>${status}</small></span>
         <span class="acts"><button class="link" data-act="limit-edit" data-key="${esc(row.key)}">Change</button></span>`}
  </div>`;
}

function renderBudgets() {
  const el = $("#view-budgets");
  const p = state.project;
  if (!p) { el.innerHTML = ""; return; }
  const rows = budgetRows();
  const w = waitingChange(rows);
  const flagged = w && w.reasons.length;
  const threshold = state.threshold ?? p.approval_threshold;

  let waiting;
  if (!w) {
    waiting = `<p class="muted">Nothing waiting. Prune checks every new code change against your limits before it goes live.</p>`;
  } else if (state.decision) {
    waiting = `<div class="result ${state.decision === "approved" ? "ok" : ""}"><span class="mark">${state.decision === "approved" ? "✓" : "↩"}</span>
      ${state.decision === "approved" ? `You approved ${esc(w.name.toLowerCase())}. It can go live.` : `Sent back to the developer with the cost estimate.`}</div>
      <p><button class="link" data-act="undo-decision">Undo</button></p>`;
  } else if (!flagged) {
    waiting = `<div class="result ok"><span class="mark">✓</span>${esc(w.name)} adds about ${about(w.added)} a month and fits your limits, so it can go live.</div>`;
  } else {
    waiting = `<div class="ask">
      <div class="big-line">${esc(w.name)} would add about <span class="green">${about(w.added)}</span> a month.</div>
      <ul class="reasons">${w.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      <p class="muted small-note">Estimated from ${esc(w.inc.traffic_source.replace(/^analytics:\s*/, "").replace(/\s*\(estimate\)/, ""))}.</p>
      <div class="btns"><button class="primary" data-act="decide-change" data-v="sent back">Send it back</button>
        <button class="outline" data-act="decide-change" data-v="approved">Approve anyway</button></div>
      <details class="code"><summary>See the new code</summary><pre>${esc(w.inc.code)}</pre></details></div>`;
  }

  el.innerHTML = `<div class="wrap">
    <div class="fix-head"><div><div class="eyebrow">Budgets</div><h1>Monthly AI budgets</h1></div></div>
    <p class="lede">Give each part of your app a monthly limit for AI. Before a new code change goes live, Prune works out what it will cost and asks you first if it would go over.</p>

    <div class="section"><div class="section-head"><h2>Your limits</h2><span class="legend"><span><i class="k"></i>Spent this month</span>${rows.some((r) => r.cost > r.limit) ? `<span><i class="o"></i>Over the limit</span>` : ""}${w && flagged && !state.decision ? `<span><i class="p"></i>Waiting change</span>` : ""}<span><i class="m"></i>Limit</span></span></div>
      ${rows.length ? `<div class="limits">${rows.map((r) => limitRow(r, w)).join("")}</div>` : `<p class="muted">No limits yet. Add one below.</p>`}</div>

    <div class="section"><div class="section-head"><h2>Waiting for your OK</h2>${w && flagged && !state.decision ? `<span class="badge">1</span>` : ""}</div>${waiting}</div>

    <div class="section"><div class="section-head"><h2>Add a limit</h2></div>
      <div class="add">
        <label>Part of your app<input id="newName" placeholder="e.g. Search suggestions"></label>
        <label>Limit per month<span class="money">$<input id="newAmount" type="number" min="0" placeholder="100"></span></label>
        <button class="outline" data-act="limit-add">Add limit</button>
      </div>
      <div class="add rule">
        <label>Ask me first when one change adds more than<span class="money">$<input id="thresholdInput" type="number" min="0" value="${Math.round(threshold)}"></span></label>
        <span class="muted">a month</span>
      </div></div>
  </div>`;
}

async function checkIncoming() {
  const p = state.project;
  state.incomingCheck = null;
  if (!p?.incoming) return;
  try {
    state.incomingCheck = await api("/api/review-change", { project: p.id, file: p.incoming.file, code: p.incoming.code, calls_per_month: p.incoming.calls_per_month });
  } catch (e) { /* the page still works without it */ }
  if (state.tab === "budgets") renderBudgets();
}

// ---------- shell ----------

function render() {
  const p = state.project;
  $("#fixCount").textContent = p ? p.groups.filter((g) => g.has_edits).length || "" : "";
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + state.tab));
  ({ find: renderFind, prove: renderProve, ship: renderShip, remember: renderRemember, energy: renderEnergy, budgets: renderBudgets })[state.tab]();
}

function go(tab) {
  state.tab = tab;
  history.replaceState(null, "", "#" + tab);
  render();
  window.scrollTo({ top: 0 });
}

async function retestIfChanged(gid) {
  const grp = state.project.groups.find((x) => x.id === gid);
  if (grp && grp.has_edits && !grp.status.tests) {
    setProject((await api("/api/tests", { project: state.project.id, group: gid })).project);
  }
}

document.addEventListener("click", async (e) => {
  const open = e.target.closest("[data-open]");
  if (open) {
    const id = open.dataset.open;
    state.selected = id;
    if (id.startsWith("shipped:")) return go("ship");
    if (!state.project.groups.some((g) => g.id === id)) { const a = state.project.accepted.find((x) => x.id === id); if (a) { state.selected = "shipped:" + id; return go("ship"); } }
    return go("prove");
  }
  const t = e.target.closest("[data-tab]");
  if (t && !t.disabled) { e.preventDefault(); go(t.dataset.tab); return; }
  const btn = e.target.closest("[data-act]");
  if (!btn || btn.type === "checkbox") return;
  const p = state.project, gid = state.selected, act = btn.dataset.act;
  if (act === "tests") await run("tests", async () => setProject((await api("/api/tests", { project: p.id, group: gid })).project));
  if (act === "replay") await run("replay", async () => {
    const res = await api("/api/replay", { project: p.id, group: gid });
    const g0 = p.groups.find((x) => x.id === gid);
    state.replayRuns[gid] = { calls: res.result.total, model: res.result.new_model, tokens: g0.before.input_tokens + 5 };
    setProject(res.project);
    await retestIfChanged(gid);
  });
  if (act === "decide") await run("decide", async () => {
    const r = await api("/api/replay/decision", { project: p.id, group: gid, decision: btn.dataset.decision });
    setProject(r.project);
    if (r.ledger_entry) toast("Remembered for next time");
    await refreshLedger();
    await retestIfChanged(gid);
  });
  if (act === "accept") await run("accept", async () => {
    const g = p.groups.find((x) => x.id === gid);
    const receipt = receiptFor(g);
    const r = await api("/api/accept", { project: p.id, group: gid });
    setProject(r.project);
    state.receipts[r.accepted.id] = receipt;
    state.energySteps.push({ label: friendly(r.accepted.function), kwh: state.project.totals.kwh });
    state.selected = "shipped:" + r.accepted.id;
    toast(`Shipped. Saving ${about(r.accepted.saved_usd)} a month`);
  });
  if (act === "limit-edit") { state.editing = btn.dataset.key; renderBudgets(); $("#limitInput")?.focus(); }
  if (act === "limit-save") {
    const v = Number($("#limitInput").value);
    if (v >= 0) { if (btn.dataset.key in state.addedLimits) state.addedLimits[btn.dataset.key] = v; else state.limits[btn.dataset.key] = v; }
    state.editing = null;
    renderBudgets();
  }
  if (act === "limit-add") {
    const name = $("#newName").value.trim(), v = Number($("#newAmount").value);
    if (!name || !(v > 0)) { toast("Add a name and a monthly amount"); return; }
    state.addedLimits[name] = v;
    renderBudgets();
    toast(`Limit added: ${name}, ${usd(v)} a month`);
  }
  if (act === "decide-change") { state.decision = btn.dataset.v; renderBudgets(); toast(btn.dataset.v === "approved" ? "Approved" : "Sent back to the developer"); }
  if (act === "undo-decision") { state.decision = null; renderBudgets(); }
  if (act === "ledger-reset") {
    if (!confirm("Forget every pattern Prune has learned?")) return;
    await api("/api/ledger/reset", {});
    await refreshLedger();
    if (p?.sample) loadSample(p.sample);
  }
});

document.addEventListener("change", async (e) => {
  if (e.target.id === "thresholdInput") {
    const v = Number(e.target.value);
    if (v >= 0) { state.threshold = v; renderBudgets(); }
    return;
  }
  if (e.target.id === "projectPick") {
    if (e.target.value === "paste") { $("#pasteDialog").showModal(); return; }
    loadSample(e.target.value);
    return;
  }
  if (e.target.dataset.act !== "guard") return;
  const p = state.project;
  await run("guard", async () => {
    setProject((await api("/api/guard", { project: p.id, group: state.selected, enabled: e.target.checked })).project);
    await retestIfChanged(state.selected);
  });
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
  if ($("#pasteDialog").returnValue !== "go" || !$("#pasteCode").value.trim()) {
    $("#projectPick").value = state.project?.sample || state.lastSample;
    return;
  }
  await run("load", async () => {
    setProject(await api("/api/load", { paste: { filename: $("#pasteName").value, code: $("#pasteCode").value, calls_per_month: $("#pasteCalls").value } }), true);
  });
  go("find");
});

window.addEventListener("hashchange", () => {
  const t = location.hash.slice(1);
  if (TABS.includes(t) && t !== state.tab) { state.tab = t; if (state.project) render(); }
});
state.tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "find";
api("/api/catalog").then((c) => { state.catalog = c; if (state.tab === "energy" && state.project) renderEnergy(); }).catch(() => {});
loadSample("stepup");
