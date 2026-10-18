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

const TABS = ["find", "prove", "ship", "remember", "guard"];
const state = { project: null, initialSites: {}, selected: null, busy: null, ledger: [], tab: "find", review: null, receipts: {}, lastSample: "stepup" };

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
    state.review = null;
    state.receipts = {};
    state.selected = p.groups.find((g) => g.has_edits)?.id || p.groups[0]?.id || null;
  }
}

async function loadSample(sample) {
  state.lastSample = sample;
  $("#projectPick").value = sample;
  await run("load", async () => setProject(await api("/api/load", { sample }), true));
  refreshLedger();
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
      out += `<rect x="${(kx - 4).toFixed(1)}" y="${(ky - 4).toFixed(1)}" width="8" height="8" fill="#ff6b2c" transform="rotate(45 ${kx.toFixed(1)} ${ky.toFixed(1)})"/>`;
      for (let k = 0; k < 3; k++) {
        out += `<ellipse class="fall" style="--dx:${((r() - .5) * 80).toFixed(0)}px;animation-delay:${(k * 1.1 + r()).toFixed(2)}s" cx="${kx.toFixed(1)}" cy="${(ky + 6).toFixed(1)}" rx="7" ry="2.8" fill="${k === 1 ? "#ff6b2c" : "#c4b5fd"}"/>`;
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
    bubbles += `<circle class="bubble" style="animation-delay:${(r() * 6).toFixed(2)}s;animation-duration:${(5 + r() * 4).toFixed(1)}s" cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${s.toFixed(1)}" fill="none" stroke="${i % 5 === 0 ? "#ff6b2c" : "#c4b5fd"}" stroke-width="1.3"/>`;
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
    s += `<ellipse class="fall" style="--dx:${((r() - .5) * 70).toFixed(0)}px;animation-delay:${(r() * 3).toFixed(2)}s" cx="${(30 + r() * 360).toFixed(0)}" cy="${(8 + r() * 26).toFixed(0)}" rx="9" ry="3.6" fill="${i % 3 === 0 ? "#ff6b2c" : "url(#gPurple)"}"/>`;
  }
  return `<svg class="leaves" viewBox="0 0 420 140" aria-hidden="true">${s}</svg>`;
}

function sproutArt() {
  return `<svg viewBox="0 0 260 180" aria-hidden="true">
    <line x1="10" y1="160" x2="250" y2="160" stroke="#26252b"/>
    <ellipse cx="130" cy="160" rx="90" ry="12" fill="url(#gGlowO)"/>
    <path d="M130 158 C 128 128, 132 104, 130 80" stroke="#f4f2ee" stroke-width="3" fill="none" stroke-linecap="round"/>
    <path class="breathe" d="M130 96 C 106 94, 94 74, 96 58 C 116 60, 128 76, 130 96z" fill="url(#gPurple)"/>
    <path class="breathe" d="M130 84 C 152 80, 166 60, 164 44 C 144 48, 132 64, 130 84z" fill="url(#gOrange)"/>
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
  const km = Math.round(mid(f.kg) / 0.17);
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
  const history = p.accepted.length ? `<div class="history"><div class="section-head"><h2>Shipped so far</h2><span class="serif orange" style="font-size:34px">−${usd(total)}/mo</span></div>
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
        return `<rect x="${i * 10}" y="${same ? 6 : 26}" width="5" height="${same ? 52 : 32}" fill="${same ? "url(#gPurple)" : "#ff6b2c"}"/>`; }).join("");
      return `<div class="lesson"><div><div class="eyebrow">${x.decision === "accepted" ? "Approved" : "Turned down"} · ${esc(x.recorded_at.split(" ")[0])}</div>
          <div class="serif" style="margin-top:10px">${esc(short(x))}</div></div>
        <div><svg viewBox="0 0 600 64" preserveAspectRatio="none">${bars}</svg>
          <div class="m">${int(x.matched)}/${int(x.total)} matched · ${esc(x.from_model)} → ${esc(x.to_model)}</div></div></div>`;
    }).join("")}</div>`
      : `<div class="empty">${sproutArt()}<p>Nothing yet. Approve an answer check in Prove and the pattern lands here.</p></div>`}</div>`;
}

// ---------- GUARD ----------

function renderGuard() {
  const el = $("#view-guard");
  const p = state.project;
  if (!p) { el.innerHTML = ""; return; }
  if (el.dataset.project !== p.id) {
    el.dataset.project = p.id;
    const inc = p.incoming;
    el.innerHTML = `<div class="wrap"><div class="guard">
      <div><div class="eyebrow">Guard</div>
        <h1 class="serif" style="font-size:clamp(40px,5vw,64px);line-height:1;margin:10px 0 12px">Catch new costs before they ship</h1>
        <p class="muted" style="margin:0">${inc ? esc(inc.title.replace(/^PR #\d+:\s*/, "A new change: ")) : "Paste a new change to see what it would add."}</p>
        <label class="field">Times it will run per month<input id="incCalls" type="number" value="${inc?.calls_per_month || 10000}"></label>
        <input id="incFile" type="hidden" value="${esc(inc?.file || "new_feature.py")}">
        <textarea id="incCode" spellcheck="false" placeholder="Paste the new code here">${esc(inc?.code || "")}</textarea>
        <div class="btns" style="margin-top:18px"><button class="primary" data-act="review">Check this change<span class="arr">→</span></button></div></div>
      <div class="verdict" id="verdict"></div></div>
      <div class="limits" id="limits"></div></div>`;
  }
  const v = $("#verdict"), r = state.review;
  if (!r) {
    v.innerHTML = `<div class="eyebrow">Your limit</div><div class="num" style="color:var(--ink)">${usd(p.approval_threshold)}</div>
      <p class="muted">A change that adds more than this a month needs a manager's OK.</p>`;
  } else {
    const c = r.check, stop = c.needs_approval || c.over_budget;
    const max = Math.max(r.added_usd, c.threshold) * 1.08;
    const kwh = r.items.reduce((a, i) => [a[0] + i.kwh[0], a[1] + i.kwh[1]], [0, 0]);
    v.innerHTML = `<div class="eyebrow">This change would add</div>
      <div class="num">${about(r.added_usd)}</div><div>a month, and ${rng(kwh)} kWh of energy</div>
      <div class="scale"><div class="line"></div><div class="fill" style="width:${(r.added_usd / max) * 100}%"></div>
        <div class="lim" style="left:${(c.threshold / max) * 100}%"><span>limit ${usd(c.threshold)}</span></div></div>
      <div class="flag ${stop ? "stop" : "go"}">${stop ? "Flagged: needs a manager's OK" : "Within your limit"}</div>
      ${c.feature && c.over_budget ? `<p class="muted" style="margin-top:14px">It would also push “${esc(c.feature.replace(/-/g, " "))}” past its ${usd(c.budget)} monthly budget.</p>` : ""}`;
  }
  $("#limits").innerHTML = p.budgets.length ? `<div class="section-head" style="margin-top:28px"><h2>Monthly budgets</h2></div>
    ${p.budgets.map((b) => { const max = Math.max(b.cost, b.budget) * 1.1 || 1;
      return `<div class="limit ${b.over ? "over" : ""}"><span class="n">${esc(b.feature.replace(/-/g, " "))}</span>
        <div class="bar"><i style="width:${(b.cost / max) * 100}%"></i><u style="left:${(b.budget / max) * 100}%"></u></div>
        <span class="s">${usd(b.cost)} of ${usd(b.budget)}</span></div>`; }).join("")}` : "";
}

// ---------- shell ----------

function render() {
  const p = state.project;
  $("#fixCount").textContent = p ? p.groups.filter((g) => g.has_edits).length || "" : "";
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + state.tab));
  ({ find: renderFind, prove: renderProve, ship: renderShip, remember: renderRemember, guard: renderGuard })[state.tab]();
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
    setProject((await api("/api/replay", { project: p.id, group: gid })).project);
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
    state.selected = "shipped:" + r.accepted.id;
    toast(`Shipped. Saving ${about(r.accepted.saved_usd)} a month`);
  });
  if (act === "review") {
    const body = { project: p.id, file: $("#incFile").value, code: $("#incCode").value, calls_per_month: $("#incCalls").value };
    try { state.review = await api("/api/review-change", body); } catch (err) { toast(err.message); }
    renderGuard();
  }
  if (act === "ledger-reset") {
    if (!confirm("Forget every pattern Prune has learned?")) return;
    await api("/api/ledger/reset", {});
    await refreshLedger();
    if (p?.sample) loadSample(p.sample);
  }
});

document.addEventListener("change", async (e) => {
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
loadSample("stepup");
