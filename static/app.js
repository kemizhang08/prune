"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd = (x) => "$" + (Math.abs(x) >= 100 ? Math.round(x).toLocaleString() : (Math.round(x * 100) / 100).toLocaleString());
const cents = (x) => "$" + Number(x).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const about = (x) => "$" + (x >= 100 ? Math.round(x / 10) * 10 : Math.round(x)).toLocaleString();
const int = (x) => Math.round(x).toLocaleString();
const rng = (r) => (r[1] > 0 && r[1] < 10 ? `${r[0].toFixed(1)}–${r[1].toFixed(1)}` : `${Math.round(r[0])}–${Math.round(r[1])}`);
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
const friendly = (fn) => NAMES[fn] || fn.replace(/^_+/, "").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

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

// The server decides each change's proof badge from what kind of change it is.
function tag(f) {
  const b = f.badge || { kind: "advice", label: "Advice only", detail: "" };
  return `<span class="tag ${b.kind}">${esc(b.label)}${b.detail ? ` · ${esc(b.detail)}` : ""}</span>`;
}

// ---------- state ----------

const TABS = ["find", "prove", "ship", "remember", "energy", "budgets"];
const state = { project: null, initialSites: {}, selected: null, busy: null, ledger: [], tab: "find", lastSample: "stepup",
  editing: null, scan: null, repos: {} };

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
    state.editing = null;
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
  // Nothing Prune can apply on its own (common for linked repos): show what the suggestions are worth.
  const adviceOnly = !done && !ready.length && p.groups.some((g) => g.advice_extra_usd > 0.5);
  const adv = (k) => [0, 1].map((i) => p.groups.reduce((a, g) => a + g.advice_summary[k][i], 0));
  return {
    done, ready, adviceOnly,
    heroUsd: done ? savedUsd : adviceOnly ? p.groups.reduce((a, g) => a + g.advice_extra_usd, 0) : ready.reduce((a, g) => a + g.summary.saved_usd, 0),
    kwh: done ? sub(p.initial.kwh, p.totals.kwh) : adviceOnly ? adv("saved_kwh") : sum("saved_kwh"),
    kg: done ? sub(p.initial.kg_co2e, p.totals.kg_co2e) : adviceOnly ? adv("saved_kg_co2e") : sum("saved_kg_co2e"),
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
      <span class="usd">${quiet ? (g.advice_extra_usd > 0.5 ? `<small>~</small>${about(g.advice_extra_usd)}` : "—") : about(g.summary.saved_usd)}</span>
      <span class="go">${quiet ? "Read" : "Fix it"}</span></button>`;
  };
  const shipped = p.accepted.map((a) => `<button class="row shipped" data-open="shipped:${esc(a.id)}"><span class="ix">${pad2(++i)}</span>
      <span class="nm">${esc(friendly(a.function))}</span><span class="ch"><span class="tag shipped">Shipped</span></span>
      <span class="usd">−${about(a.saved_usd)}</span><span class="go">Receipt</span></button>`);
  return `<div class="rows">${open.map((g) => row(g)).join("")}${tips.map((g) => row(g, true)).join("")}${shipped.join("")}</div>`;
}

const SCAN_STEPS = [["fetching", "Fetching"], ["scanning", "Reading the code"], ["done", "Done"]];

function scanBar() {
  const sc = state.scan;
  const busy = sc && (sc.state === "fetching" || sc.state === "scanning");
  const idx = sc ? SCAN_STEPS.findIndex(([k]) => k === sc.state) : -1;
  return `<form class="scanbar wrap" id="scanForm" autocomplete="off">
      <label for="repoUrl" class="eyebrow">Scan a GitHub repo</label>
      <div class="scanrow"><input id="repoUrl" type="url" inputmode="url" spellcheck="false" placeholder="https://github.com/owner/repo"
          value="${esc(sc?.input || "")}" ${busy ? "disabled" : ""}>
        <button class="outline" type="submit" ${busy ? "disabled" : ""}>${busy ? '<span class="spin"></span>Scanning' : "Scan"}</button></div>
      ${sc ? `<div class="scanstate ${sc.state}">
          ${sc.state === "error" ? `<span class="err">${esc(sc.error)}</span>` :
            SCAN_STEPS.map(([k, label], i) => `<span class="${i < idx || sc.state === "done" ? "did" : i === idx ? "now" : ""}">${label}</span>`).join('<i></i>')}
          ${sc.state !== "error" && sc.message ? `<em>${esc(sc.message)}</em>` : ""}</div>`
        : `<div class="scanhint">Public repos or single .py files. Prune only reads the code. It never runs it.</div>`}
    </form>`;
}

function estimateNote(p) {
  if (p.kind === "sample") return "";
  return `<form class="estimate" id="trafficForm">
      <span>No usage data, so every figure is an estimate. Prune assumed</span>
      <span class="money"><input id="defaultCalls" type="number" min="1" value="${p.default_calls}"></span>
      <span>runs a month for each AI call.</span>
      <button class="link" type="submit">Update</button></form>`;
}

function sourceLine(p) {
  if (p.kind !== "repo") return esc(p.name);
  const src = p.source;
  return `<a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.label)}</a> · ${int(src.files)} Python file${src.files === 1 ? "" : "s"} read`;
}

function renderFind() {
  const el = $("#view-find");
  const p = state.project;
  if (!p) { el.innerHTML = scanBar(); return; }
  if (p.empty_reason) {
    el.innerHTML = `${scanBar()}<div class="wrap"><div class="empty">${sproutArt()}<div>
        <div class="eyebrow">${sourceLine(p)}</div>
        <h2 class="serif" style="font-size:clamp(34px,4vw,52px);line-height:1;margin:10px 0 14px">Nothing to prune here</h2>
        <p>${esc(p.empty_reason)}</p>
        ${p.parse_error_count ? `<p class="muted">${int(p.parse_error_count)} file${p.parse_error_count === 1 ? "" : "s"} couldn't be read as Python 3.</p>` : ""}
        <button class="outline" data-sample-load="stepup">See the StepUp example</button></div></div></div>`;
    return;
  }
  const f = figures();
  const km = p.energy.equivalents.km_driving;
  const top = f.ready[0];
  el.innerHTML = `
    ${scanBar()}
    <div class="wrap hero">
      <div>
        <div class="eyebrow">${sourceLine(p)} · ${p.sites.length} AI call${p.sites.length === 1 ? "" : "s"} found</div>
        <div class="num">${usd(f.heroUsd)}</div>
        <div class="per">${f.done ? `saved every month, from ${usd(p.initial.cost)} down to ${usd(p.totals.cost)}` : f.adviceOnly ? `a month in suggestions to review, out of ${usd(p.totals.cost)}` : `a month Prune can cut, out of ${usd(p.totals.cost)}`}${p.kind === "sample" ? "" : " (estimated)"}</div>
        <div class="facts">
          <div class="fact"><div class="v">${rng(f.kwh)}<small>kWh</small></div><div class="k">${f.adviceOnly ? "less energy a month if applied" : "less energy a month"}</div></div>
          <div class="fact"><div class="v">${f.ready.length}</div><div class="k">fix${f.ready.length === 1 ? "" : "es"} ready</div></div>
          ${p.groups.length - f.ready.length > 0 ? `<div class="fact"><div class="v">${p.groups.length - f.ready.length}</div><div class="k">suggestion${p.groups.length - f.ready.length === 1 ? "" : "s"}</div></div>` : ""}
        </div>
        ${top ? `<button class="primary" data-open="${esc(top.id)}">Start with ${esc(friendly(top.function).toLowerCase())}<span class="arr">→</span></button>`
          : p.groups.length ? `<button class="outline" data-open="${esc(p.groups[0].id)}">Read the suggestions</button>` : `<span class="muted">Nothing left to fix here.</span>`}
        ${estimateNote(p)}
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
        ${p.groups.length || p.accepted.length ? rowsHtml() : `<div class="empty">${sproutArt()}<p>Prune found ${p.sites.length} AI call${p.sites.length === 1 ? "" : "s"} and nothing wasteful in ${p.sites.length === 1 ? "it" : "them"}.</p></div>`}</div></div>`;
}

// ---------- PROVE ----------

function diffHtml(diffs) {
  return Object.entries(diffs).map(([file, d]) => [`<span class="file">${esc(file)}</span>`, ...d.split("\n").filter((l) => !/^(\+\+\+|---|@@)/.test(l))
    .map((l) => `<span class="${l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}">${esc(l) || " "}</span>`)].join("\n")).join("\n\n");
}

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
      <div><div class="t">${esc(changeName(f))}</div><div class="d">${esc(WHY[f.rule] || "")}${f.included ? "" : ` ${esc(f.note || "Left out of this fix.")}`}</div></div>${tag(f)}</div>`).join("")}</div>`;
  const traffic = g.before.estimate ? `<form class="estimate" data-site="${esc(g.id)}" id="siteTrafficForm">
      <span>Runs a month (estimate)</span><span class="money"><input id="siteCalls" type="number" min="1" value="${Math.round(g.before.calls)}"></span>
      <button class="link" type="submit">Update</button><span class="muted">${esc(g.price_source)}</span></form>` : "";
  const suggested = Object.keys(g.advice_diffs || {}).length
    ? `<details class="code"><summary>Show the suggested change (not applied)</summary><pre>${diffHtml(g.advice_diffs)}</pre></details>` : "";

  if (!g.has_edits) {
    el.innerHTML = `<div class="wrap">${head}${traffic}${list}<div class="proof"><div class="side"><div class="eyebrow">Advice only</div></div>
      <div><p>Prune can't prove these are safe here, so it never applies them on its own.${p.linked ? " For linked repos Prune only reads the code, so anything that needs your tests or your past requests stays a suggestion." : ""}</p></div></div>
      ${suggested}</div>`;
    return;
  }

  const testsOk = st.tests?.passed;
  const safety = `<div class="proof"><div class="side"><div class="eyebrow">Proof 1</div><div class="serif">Nothing breaks</div></div><div>
    ${st.tests?.skipped ? `<div class="result"><span class="mark">–</span>Not run for linked repos</div>
        <p style="margin-top:14px">${esc(st.tests.reason)} These changes keep the same answer by design: caching, removing repeats and capping length.</p>`
    : st.tests ? `<div class="result ${st.tests.passed ? "ok" : "bad"}"><span class="mark">${st.tests.passed ? "✓" : "!"}</span>
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

  el.innerHTML = `<div class="wrap">${head}${traffic}${list}${safety}${answers}
    <details class="code"><summary>Show the exact code change</summary><pre>${diffHtml(st.diffs)}</pre></details>${suggested}
    <div class="next"><button class="primary" data-tab="ship" ${st.can_accept ? "" : "disabled"}>See the receipt<span class="arr">→</span></button></div></div>`;
}

// ---------- SHIP ----------

const whText = (r) => `${r[1] < 10 ? r[0].toFixed(1) : Math.round(r[0])}–${r[1] < 10 ? r[1].toFixed(1) : Math.round(r[1])} Wh`;

// r is the receipt the server worked out; changes are the findings it covers.
function receiptHtml(name, r, changes, shipped) {
  return `<div class="receipt">
    <h3>Prune</h3><div class="sub">${esc(name)} · ${esc(r.date || new Date().toISOString().slice(0, 10))}</div>
    ${changes.map((c) => `<div class="ln"><span>${esc(changeName(c))}</span><span>${esc(c.badge.label)}</span></div>`).join("")}
    <hr>
    <div class="ln"><span>Before</span><span>${cents(r.cost_before)}/mo</span></div>
    <div class="ln"><span>After</span><span>${cents(r.cost_after)}/mo</span></div>
    <div class="ln em"><span>Saved</span><span>${cents(r.saved_usd)}/mo</span></div>
    <hr>
    <div class="ln"><span>Energy saved</span><span>${rng(r.saved_kwh)} kWh/mo</span></div>
    <div class="ln"><span>Carbon avoided</span><span>${rng(r.saved_kg)} kg CO₂/mo</span></div>
    <hr>
    <div class="ln"><span>This review cost</span><span>−${cents(r.review_cost_usd)}${r.review_wh[1] ? ` · ${whText(r.review_wh)}` : ""}</span></div>
    <div class="ln net"><span>Net, first month</span><span>${cents(r.net_usd)}</span></div>
    <div class="ln"><span>Checks</span><span>${esc(r.tests)}</span></div>
    <div class="note">${r.estimate ? "Every figure is an estimate: there's no usage data for this code." : "Dollars come from your usage."} Energy and carbon are ranges.</div>
    ${shipped ? `<div class="stamp">${r.tests.startsWith("not run") ? "ACCEPTED" : "SHIPPED"}</div>` : ""}
  </div>`;
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
    main = `<div class="ship"><div class="lead"><div class="eyebrow">${p.linked ? "Accepted" : "Shipped"}</div><h1>${esc(friendly(a.function))}</h1>
        ${leavesArt()}
        <div class="rollout">${a.rollout.map((x) => `<div><b>${x.pct ? x.pct + "%" : "Next"}</b><span>${esc(x.note)}</span></div>`).join("")}</div>
        ${p.linked ? `<div class="btns" style="margin-top:22px"><button class="primary" data-act="copy-patch" data-id="${esc(a.id)}">Copy the change</button>
          <span class="muted">A patch you can apply with <code>git apply</code>.</span></div>
          <details class="code"><summary>Show the change</summary><pre>${diffHtml({ [a.file]: a.patch })}</pre></details>` : ""}</div>
      ${receiptHtml(friendly(a.function), a.receipt, a.changes, true)}</div>`;
  } else if (g) {
    const st = g.status;
    const lead = p.linked
      ? "Prune only read this code. Accepting gives you the exact change to copy into your repo. Run your tests on it before merging."
      : st.can_accept ? "Both proofs are in. Shipping opens the change for your team and rolls it out to a small share of people first."
      : esc(st.blocked_by || "Finish the proofs first.");
    main = `<div class="ship"><div class="lead"><div class="eyebrow">Ready to ${p.linked ? "accept" : "ship"}</div><h1>${esc(friendly(g.function))}</h1>
        <p>${lead}</p>
        <div class="btns" style="margin-top:26px">
          <button class="primary" data-act="accept" ${st.can_accept && !state.busy ? "" : "disabled"}>${busy}${p.linked ? "Accept the change" : "Ship it"} · save ${about(g.summary.saved_usd)}/mo</button>
          ${st.can_accept ? "" : `<button class="link" data-tab="prove">Back to the proofs</button>`}</div></div>
      ${receiptHtml(friendly(g.function), st.receipt, g.findings.filter((f) => f.included), false)}</div>`;
  } else {
    main = `<div class="empty">${sproutArt()}<div><p>Pick a fix and prove it first. Its receipt shows up here.</p><button class="outline" data-tab="find">See what Prune found</button></div></div>`;
  }
  const total = p.accepted.reduce((s, a) => s + a.saved_usd, 0);
  const history = p.accepted.length ? `<div class="history"><div class="section-head"><h2>${p.linked ? "Accepted" : "Shipped"} so far</h2><span class="serif green" style="font-size:34px">−${usd(total)}/mo</span></div>
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

function renderEnergy() {
  const el = $("#view-energy");
  const p = state.project;
  if (!p) { el.innerHTML = ""; return; }
  const e = p.energy;
  const kwh = e.kwh, kg = e.kg_co2e, eq = e.equivalents;
  const cols = e.steps.map((c, i) => ({ ...c, label: c.projected || i === 0 ? c.label : friendly(c.label),
    now: !c.projected && i === e.steps.filter((x) => !x.projected).length - 1 }));
  const top = Math.max(...cols.map((c) => c.kwh[1]), 0.001);
  const fmax = Math.max(...e.top.map((x) => x.kwh[1]), 0.001);
  const wh = e.review_wh;
  const whNum = (x) => (x >= 10 ? Math.round(x).toLocaleString() : x.toFixed(2));
  const whRange = (r) => `${whNum(r[0])}–${whNum(r[1])} Wh`;
  const per1k = (r) => whRange([r[0] * 1000, r[1] * 1000]);
  const share = e.review_share;
  const m = e.method;

  el.innerHTML = `
    <div class="energy-hero">
      ${energyBubbles(kwh)}
      <div class="hero-tree">${treeArt()}</div>
      <div class="wrap">
        <div class="eyebrow">${e.done ? "Energy saved" : e.advice_only ? "Energy the suggestions could save" : "Energy Prune can save"} · ${sourceLine(p)}</div>
        <div class="num">${rng(kwh)}<span class="unit">kWh</span></div>
        <div class="per">every month, and ${rng(kg)} kg of CO₂ that never reaches the air${p.kind === "sample" ? "" : " (estimated)"}</div>
      </div>
    </div>

    <div class="wrap">
      <div class="section"><div class="section-head"><h2>What that's like</h2><span class="legend">Estimates, using the middle of each range</span></div>
        <div class="equiv">
          <div><div class="v">${int(eq.phone_charges)}</div><div class="k">phone charges a month</div>${glyphRow("phone", Math.round(eq.phone_charges / 250))}<div class="g-note">each = 250 charges</div></div>
          <div><div class="v">${eq.home_days >= 10 ? int(eq.home_days) : eq.home_days}</div><div class="k">days of power for an average home</div>${glyphRow("home", Math.max(eq.home_days > 0 ? 1 : 0, Math.round(eq.home_days)))}<div class="g-note">each = one home for a day</div></div>
          <div><div class="v">${int(eq.km_driving)} km</div><div class="k">of driving avoided, in carbon terms</div>
            <div class="road"><i style="width:${Math.min(100, (eq.km_driving / 400) * 100)}%"></i></div><div class="g-note">${int(eq.km_driving * 0.621)} miles</div></div>
        </div></div>

      <div class="section"><div class="section-head"><h2>Energy used each month</h2>
          <span class="legend"><span><i class="k"></i>Likely range</span>${cols.some((c) => c.projected) ? `<span><i class="pg"></i>After the fixes still waiting</span>` : ""}</span></div>
        <div class="steps">${cols.map((c) => `<div class="stepcol ${c.projected ? "proj" : ""} ${c.now ? "now" : ""}">
            <div class="val">${rng(c.kwh)}<small> kWh</small></div>
            <div class="track"><div class="hi" style="height:${(c.kwh[1] / top) * 100}%"></div><div class="lo" style="height:${(c.kwh[0] / top) * 100}%"></div></div></div>`).join("")}</div>
        <div class="steplabs">${cols.map((c) => `<span class="${c.projected ? "proj" : ""}">${esc(c.label)}</span>`).join("")}</div>
        <p class="muted note">${p.accepted.length ? "Each column is one fix shipped." : "Ship a fix and a new column appears here."} The tall faint part is the high end of the estimate, the solid part the low end.</p></div>

      <div class="section"><div class="section-head"><h2>Biggest energy savers</h2><span class="legend">kWh a month</span></div>
        ${e.top.length ? `<div class="savers">${e.top.map((x, i) => `<div class="saver"><span class="ix">${pad2(i + 1)}</span><span class="n">${esc(friendly(x.name))}</span>
            <div class="rbar"><i style="left:${(x.kwh[0] / fmax) * 100}%;width:${((x.kwh[1] - x.kwh[0]) / fmax) * 100}%"></i><b style="width:${(x.kwh[0] / fmax) * 100}%"></b></div>
            <span class="v">${rng(x.kwh)}</span><span class="tag ${x.shipped ? "shipped" : x.advice ? "advice" : "same"}">${x.shipped ? (p.linked ? "Accepted" : "Shipped") : x.advice ? "Suggestion" : "Ready"}</span></div>`).join("")}</div>`
          : `<p class="muted">No energy fixes in this project yet.</p>`}</div>

      <div class="section net">
        <div><div class="eyebrow">Net impact</div>
          <div class="big-line">Saving ${rng(kwh)} kWh a month cost <em>${whRange(wh)}</em> of Prune's own energy.</div>
          <p class="muted">${wh[1] > 0 ? `That's what re-checking past answers on the smaller model used, about ${share < 0.001 ? "less than 0.1%" : (share * 100).toFixed(1) + "%"} of one month's savings. Reading code uses no AI.` : "Reading code uses no AI, so this review has used almost no energy so far. Answer checks add a little, and they show up here."}</p></div>
        <div class="netbox"><div class="ln"><span>Saved a month</span><span>${rng(kwh)} kWh</span></div>
          <div class="ln"><span>Prune's own use</span><span>−${whRange(wh)}</span></div>
          <div class="ln total"><span>Net, first month</span><span class="green">${rng(e.net_kwh)} kWh</span></div></div>
      </div>

      <div class="section method"><div class="section-head"><h2>How we estimate this</h2></div>
        <div class="formula"><span>Words processed<small>tokens, ${p.kind === "sample" ? "from your usage" : "estimated from the code"}</small></span><b>×</b><span>Energy per 1,000 tokens<small>a low–high range by model size</small></span><b>×</b><span>Grid carbon<small>${m.grid_kg_per_kwh[0]}–${m.grid_kg_per_kwh[1]} kg CO₂ per kWh</small></span></div>
        <div class="ranges">${["large", "medium", "small"].map((k) => `<div><span>${{ large: "Large models", medium: "Mid-size models", small: "Small models" }[k]}</span><span>${per1k(m.energy_per_1k[k])} per 1,000 tokens</span></div>`).join("")}</div>
        <p class="muted">AI companies don't publish energy use per model, so Prune always shows a range, never one exact number. Dollar figures ${p.kind === "sample" ? "come straight from your bill and are exact" : "use list prices and an estimated number of runs"}. Reused (cached) instructions count at ${m.cached_token_weight === 0.1 ? "a tenth" : m.cached_token_weight}, since they skip most of the work. Sources:</p>
        <ul class="sources">${m.sources.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
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
const featureName = (k) => FEATURE_NAMES[k] || (/[/.]/.test(k) ? k : k.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase()));

function reasonText(x) {
  if (x.kind === "threshold") return `That's more than the ${usd(x.limit)} a month you allow any single change to add.`;
  return `It would take ${featureName(x.feature)} to ${usd(x.after)} a month, over its ${usd(x.limit)} limit.`;
}

function limitRow(row, w) {
  const editing = state.editing === row.key;
  const pendingExtra = w && w.flagged && !w.decision && w.feature === row.key ? w.added_usd : 0;
  const has = row.limit !== null && row.limit !== undefined;
  const lim = has ? row.limit : 0;
  const max = Math.max(row.cost + pendingExtra, lim, 1) * 1.08;
  const within = has ? Math.min(row.cost, lim) : row.cost, over = has ? Math.max(0, row.cost - lim) : 0;
  const status = !has ? "No limit yet" : row.over ? `<b>Over by $${int(row.cost - lim)}</b>` : `$${int(lim - row.cost)} left`;
  return `<div class="limit ${row.over ? "over" : ""} ${has ? "" : "nolimit"}">
    <span class="n">${esc(featureName(row.key))}</span>
    <div class="bar" title="${usd(row.cost)} spent${has ? ` of ${usd(lim)}` : ""}">
      <i style="width:${(within / max) * 100}%"></i>
      ${over ? `<s style="left:${(lim / max) * 100}%;width:${(over / max) * 100}%"></s>` : ""}
      ${pendingExtra ? `<em style="left:${(row.cost / max) * 100}%;width:${(pendingExtra / max) * 100}%"></em>` : ""}
      ${has ? `<u style="left:${(lim / max) * 100}%"></u>` : ""}</div>
    ${editing
      ? `<span class="s edit">$<input id="limitInput" type="number" min="0" value="${has ? Math.round(lim) : Math.ceil(row.cost * 1.2 / 10) * 10 || 50}"> a month</span>
         <span class="acts"><button class="link" data-act="limit-save" data-key="${esc(row.key)}">Save</button></span>`
      : `<span class="s">${usd(row.cost)}${has ? ` of ${usd(lim)}` : " a month"}<br><small>${status}</small></span>
         <span class="acts"><button class="link" data-act="limit-edit" data-key="${esc(row.key)}">${has ? "Change" : "Set a limit"}</button></span>`}
  </div>`;
}

function renderBudgets() {
  const el = $("#view-budgets");
  const p = state.project;
  if (!p) { el.innerHTML = ""; return; }
  const b = p.budget, rows = b.rows, w = b.waiting;
  const name = w ? friendly(w.function || "this change") : "";

  let waiting;
  if (!w) {
    waiting = `<p class="muted">Nothing waiting. Prune checks every new code change against your limits before it goes live.</p>`;
  } else if (w.decision) {
    waiting = `<div class="result ${w.decision === "approved" ? "ok" : ""}"><span class="mark">${w.decision === "approved" ? "✓" : "↩"}</span>
      ${w.decision === "approved" ? `You approved ${esc(name.toLowerCase())}. It can go live.` : "Sent back to the developer with the cost estimate."}</div>
      <p><button class="link" data-act="decide-change" data-v="">Undo</button></p>`;
  } else if (!w.flagged) {
    waiting = `<div class="result ok"><span class="mark">✓</span>${esc(name)} adds about ${about(w.added_usd)} a month and fits your limits, so it can go live.</div>`;
  } else {
    waiting = `<div class="ask">
      <div class="big-line">${esc(name)} would add about <span class="green">${about(w.added_usd)}</span> a month.</div>
      <ul class="reasons">${w.reasons.map((x) => `<li>${esc(reasonText(x))}</li>`).join("")}</ul>
      <p class="muted small-note">Estimated from ${esc(w.traffic_source.replace(/^analytics:\s*/, "").replace(/\s*\(estimate\)/, ""))}.</p>
      <div class="btns"><button class="primary" data-act="decide-change" data-v="sent back">Send it back</button>
        <button class="outline" data-act="decide-change" data-v="approved">Approve anyway</button></div>
      <details class="code"><summary>See the new code</summary><pre>${esc(w.code)}</pre></details></div>`;
  }
  const pendingLegend = w && w.flagged && !w.decision;

  el.innerHTML = `<div class="wrap">
    <div class="fix-head"><div><div class="eyebrow">Budgets · ${sourceLine(p)}</div><h1>Monthly AI budgets</h1></div></div>
    <p class="lede">Give each part of your app a monthly limit for AI. Before a new code change goes live, Prune works out what it will cost and asks you first if it would go over.${b.estimate ? " Spending here is estimated." : ""}</p>

    <div class="section"><div class="section-head"><h2>Your limits</h2><span class="legend"><span><i class="k"></i>Spent this month</span>${rows.some((r) => r.over) ? `<span><i class="o"></i>Over the limit</span>` : ""}${pendingLegend ? `<span><i class="p"></i>Waiting change</span>` : ""}<span><i class="m"></i>Limit</span></span></div>
      ${rows.length ? `<div class="limits">${rows.map((r) => limitRow(r, w)).join("")}</div>` : `<p class="muted">No limits yet. Add one below.</p>`}
      ${!b.from_config && rows.length ? `<p class="muted note">One row per file that calls an AI model. Add a prune.toml to the repo to group them by feature.</p>` : ""}</div>

    <div class="section"><div class="section-head"><h2>Waiting for your OK</h2>${pendingLegend ? `<span class="badge">1</span>` : ""}</div>${waiting}</div>

    <div class="section"><div class="section-head"><h2>Add a limit</h2></div>
      <div class="add">
        <label>Part of your app<input id="newName" placeholder="e.g. Search suggestions"></label>
        <label>Limit per month<span class="money">$<input id="newAmount" type="number" min="0" placeholder="100"></span></label>
        <button class="outline" data-act="limit-add">Add limit</button>
      </div>
      <div class="add rule">
        <label>Ask me first when one change adds more than<span class="money">$<input id="thresholdInput" type="number" min="0" value="${Math.round(b.threshold)}"></span></label>
        <span class="muted">a month</span>
      </div></div>
  </div>`;
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

// ---------- scanning a GitHub link ----------

async function startScan(url) {
  url = url.trim();
  if (!url) { toast("Paste a GitHub link first"); return; }
  state.scan = { state: "fetching", message: "Starting", input: url };
  if (state.tab !== "find") go("find"); else renderFind();
  let job;
  try {
    job = await api("/api/scan", { url, calls_per_month: state.project?.kind === "repo" ? state.project.default_calls : undefined });
  } catch (e) {
    state.scan = { state: "error", error: e.message, input: url };
    renderFind();
    return;
  }
  state.scan = { ...job, input: url };
  renderFind();
  while (state.scan && (state.scan.state === "fetching" || state.scan.state === "scanning")) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const st = await api(`/api/scan/${job.id}`);
      state.scan = { ...st, input: url };
    } catch (e) {
      state.scan = { state: "error", error: e.message, input: url };
    }
    if (state.tab === "find") renderFind();
  }
  if (state.scan.state === "done" && state.scan.project) {
    const proj = state.scan.project;
    setProject(proj, true);
    rememberProject(proj);
    state.scan = { state: "done", message: state.scan.message, input: url };
    render();
    refreshLedger();
  }
}

function rememberProject(p) {
  if (p.kind === "sample") return;
  state.repos[p.id] = p;
  const pick = $("#projectPick");
  let opt = pick.querySelector(`option[value="project:${p.id}"]`);
  if (!opt) {
    opt = document.createElement("option");
    opt.value = `project:${p.id}`;
    opt.textContent = p.kind === "repo" ? p.source.label : "Pasted code";
    pick.insertBefore(opt, pick.querySelector('option[value="paste"]'));
  }
  pick.value = opt.value;
}

async function projectCall(path, body, label = "save") {
  await run(label, async () => {
    const r = await api(path, { project: state.project.id, ...body });
    setProject(r.project);
    rememberProject(r.project);
  });
}

document.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (e.target.id === "scanForm") return startScan($("#repoUrl").value);
  if (e.target.id === "trafficForm") return projectCall("/api/traffic", { calls_per_month: Number($("#defaultCalls").value) });
  if (e.target.id === "siteTrafficForm") return projectCall("/api/traffic", { site: e.target.dataset.site, calls_per_month: Number($("#siteCalls").value) });
});

document.addEventListener("click", async (e) => {
  const sampleBtn = e.target.closest("[data-sample-load]");
  if (sampleBtn) { loadSample(sampleBtn.dataset.sampleLoad); go("find"); return; }
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
    const r = await api("/api/accept", { project: p.id, group: gid });
    setProject(r.project);
    rememberProject(r.project);
    state.selected = "shipped:" + r.accepted.id;
    toast(`${p.linked ? "Accepted" : "Shipped"}. Saving ${about(r.accepted.saved_usd)} a month`);
  });
  if (act === "copy-patch") {
    const a = p.accepted.find((x) => x.id === btn.dataset.id);
    try { await navigator.clipboard.writeText(a.patch + "\n"); toast("Copied. Apply it with git apply"); }
    catch (err) { toast("Couldn't copy here. Open “Show the change” and copy it by hand"); }
  }
  if (act === "limit-edit") { state.editing = btn.dataset.key; renderBudgets(); $("#limitInput")?.focus(); }
  if (act === "limit-save") {
    const v = Number($("#limitInput").value);
    if (!(v >= 0)) { toast("Enter an amount of $0 or more"); return; }
    state.editing = null;
    await projectCall("/api/budget/limit", { feature: btn.dataset.key, usd: v });
  }
  if (act === "limit-add") {
    const name = $("#newName").value.trim(), v = Number($("#newAmount").value);
    if (!name || !(v > 0)) { toast("Add a name and a monthly amount"); return; }
    await projectCall("/api/budget/add", { name, usd: v });
    toast(`Limit added: ${name}, ${usd(v)} a month`);
  }
  if (act === "decide-change") {
    const v = btn.dataset.v || null;
    await projectCall("/api/budget/decision", { decision: v });
    if (v) toast(v === "approved" ? "Approved" : "Sent back to the developer");
  }
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
    if (v >= 0) await projectCall("/api/budget/threshold", { usd: v });
    return;
  }
  if (e.target.id === "projectPick") {
    const v = e.target.value;
    if (v === "paste") { $("#pasteDialog").showModal(); return; }
    if (v.startsWith("project:")) {
      const cached = state.repos[v.slice(8)];
      if (cached) { setProject(cached, true); render(); }
      return;
    }
    loadSample(v);
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
    $("#projectPick").value = state.project?.sample || (state.project ? `project:${state.project.id}` : state.lastSample);
    return;
  }
  await run("load", async () => {
    const proj = await api("/api/load", { paste: { filename: $("#pasteName").value, code: $("#pasteCode").value, calls_per_month: $("#pasteCalls").value } });
    setProject(proj, true);
    rememberProject(proj);
  });
  go("find");
});

window.addEventListener("hashchange", () => {
  const t = location.hash.slice(1);
  if (TABS.includes(t) && t !== state.tab) { state.tab = t; if (state.project) render(); }
});
state.tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "find";
loadSample("stepup");
