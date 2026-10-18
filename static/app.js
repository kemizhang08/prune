"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd = (x) => "$" + (Math.abs(x) >= 100 ? Math.round(x).toLocaleString() : (Math.round(x * 100) / 100).toLocaleString());
const about = (x) => "$" + (x >= 100 ? Math.round(x / 10) * 10 : Math.round(x)).toLocaleString();
const int = (x) => Math.round(x).toLocaleString();
const rng = (r) => `${Math.round(r[0])}–${Math.round(r[1])}`;
const mid = (r) => (r[0] + r[1]) / 2;

// ---------- plain-language names ----------

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

const PLAIN = {
  model_too_big: "Uses a big, pricey AI model for a simple choice",
  plain_code: "Uses AI for something a simple rule can do for free",
  uncached_prompt: "Sends the same long instructions every time instead of reusing them",
  max_tokens_high: "Lets the AI write far more than anyone reads",
  full_history: "Resends the whole conversation on every message",
  timer: "Repeats the same work over and over on a timer",
  batchable: "Could run in bulk during cleaner, off-peak hours",
  retry_storm: "Retries instantly and endlessly when something fails",
  duplicate_call: "Asks the AI the same question twice",
  agent_unbounded: "Lets an AI assistant keep going with no step limit",
};

// ---------- state ----------

const state = { project: null, initialSites: {}, selected: null, busy: null, ledger: [], tab: "home", review: null, applied: null, lastSample: "stepup" };

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
    state.applied = null;
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
  if (state.tab === "learned") renderLearned();
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

// ---------- numbers derived for the dashboard ----------

function figures() {
  const p = state.project;
  const savedUsd = Math.max(0, p.initial.cost - p.totals.cost);
  const savedKwh = [Math.max(0, p.initial.kwh[0] - p.totals.kwh[0]), Math.max(0, p.initial.kwh[1] - p.totals.kwh[1])];
  const savedKg = [Math.max(0, p.initial.kg_co2e[0] - p.totals.kg_co2e[0]), Math.max(0, p.initial.kg_co2e[1] - p.totals.kg_co2e[1])];
  const ready = p.groups.filter((g) => g.has_edits);
  const readyUsd = ready.reduce((a, g) => a + g.summary.saved_usd, 0);
  const readyKwh = [0, 1].map((i) => ready.reduce((a, g) => a + g.summary.saved_kwh[i], 0));
  const readyKg = [0, 1].map((i) => ready.reduce((a, g) => a + g.summary.saved_kg_co2e[i], 0));
  const done = savedUsd > 0.5;
  return {
    done, savedUsd, ready, readyUsd,
    heroUsd: done ? savedUsd : readyUsd,
    kwh: done ? savedKwh : readyKwh,
    kg: done ? savedKg : readyKg,
    initialKwh: p.initial.kwh,
  };
}

// ---------- art ----------

function treeArt() {
  const p = state.project;
  const now = Object.fromEntries(p.sites.map((s) => [s.id, s.cost]));
  const ids = Object.keys(state.initialSites);
  const max = Math.max(1, ...ids.map((id) => state.initialSites[id].cost));
  const W = 600, H = 300, cx = W / 2;
  let out = `<svg class="tree" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
    <ellipse cx="${cx}" cy="${H - 6}" rx="260" ry="26" fill="url(#gGlow)"/>`;
  const order = ids.slice().sort((a, b) => hash(a) - hash(b));
  const n = order.length;
  out += `<path d="M${cx} ${H} C ${cx - 6} ${H - 60}, ${cx + 6} ${H - 110}, ${cx} ${H - 160}" stroke="#d8ccff" stroke-width="7" fill="none" stroke-linecap="round"/>`;
  order.forEach((id, i) => {
    const r = rand(hash(id));
    const c0 = state.initialSites[id].cost, c1 = now[id] ?? 0;
    const frac = c0 > 0 ? Math.min(1, c1 / c0) : 1;
    const angle = (-78 + (156 * (i + 0.5)) / n) * Math.PI / 180;
    const len = 90 + 170 * Math.sqrt(c0 / max);
    const by = H - 80 - (i % 3) * 28 - r() * 12;
    const bx = cx;
    const ex = bx + Math.sin(angle) * len * 1.1, ey = by - Math.cos(angle) * len * 0.75;
    const qx = bx + Math.sin(angle) * len * 0.35 + (r() - .5) * 30, qy = by - len * 0.55;
    const at = (t) => [(1 - t) ** 2 * bx + 2 * (1 - t) * t * qx + t * t * ex, (1 - t) ** 2 * by + 2 * (1 - t) * t * qy + t * t * ey];
    const sw = 1.5 + 4 * Math.sqrt(c0 / max);
    const name = friendly(state.initialSites[id].function);
    out += `<g><title>${esc(name)}: ${usd(c1)} a month now${c1 < c0 ? `, was ${usd(c0)}` : ""}</title>`;
    out += `<path d="M${bx} ${by} Q ${qx} ${qy} ${ex} ${ey}" stroke="#3a3150" stroke-width="${sw}" fill="none" stroke-dasharray="2 6" stroke-linecap="round"/>`;
    if (frac > 0.02) {
      const steps = 24, pts = [];
      for (let k = 0; k <= steps; k++) pts.push(at((k / steps) * frac));
      out += `<path d="M${pts.map((q) => q.map((v) => v.toFixed(1)).join(" ")).join(" L")}" stroke="#d8ccff" stroke-width="${sw}" fill="none" stroke-linecap="round"/>`;
      const leaves = 2 + Math.round(10 * frac * Math.sqrt(c0 / max) + r() * 3);
      for (let k = 0; k < leaves; k++) {
        const t = (0.35 + 0.65 * r()) * frac;
        const [lx, ly] = at(t);
        const rot = (angle * 180 / Math.PI) + (r() - .5) * 120;
        const s = 5 + r() * 7 * Math.sqrt(c0 / max) + 3;
        out += `<ellipse cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" rx="${s.toFixed(1)}" ry="${(s * 0.45).toFixed(1)}" transform="rotate(${rot.toFixed(0)} ${lx.toFixed(1)} ${ly.toFixed(1)})" fill="url(#gPurple)" opacity="${(.65 + r() * .35).toFixed(2)}"/>`;
      }
    }
    if (frac < 0.98) {
      const [kx, ky] = at(Math.max(frac, 0.04));
      out += `<circle cx="${kx.toFixed(1)}" cy="${ky.toFixed(1)}" r="3.5" fill="#fff"/>`;
      for (let k = 0; k < 3; k++) {
        out += `<ellipse class="fall" style="--dx:${((r() - .5) * 80).toFixed(0)}px;animation-delay:${(k * 1.1 + r()).toFixed(2)}s" cx="${kx.toFixed(1)}" cy="${(ky + 6).toFixed(1)}" rx="6" ry="2.6" fill="#f5f3ff"/>`;
      }
    }
    out += `</g>`;
  });
  return out + `</svg>`;
}

function orbArt(share) {
  const R = 54, C = 2 * Math.PI * 64;
  const dash = Math.max(0.001, Math.min(1, share)) * C;
  return `<svg class="orb breathe" viewBox="0 0 150 150" aria-hidden="true">
    <circle cx="75" cy="75" r="72" fill="url(#gGlow)"/>
    <circle cx="75" cy="75" r="64" fill="none" stroke="#2a2438" stroke-width="3"/>
    <circle cx="75" cy="75" r="64" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round"
      stroke-dasharray="${dash.toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 75 75)"/>
    <circle cx="75" cy="75" r="${R - 12}" fill="url(#gOrb)"/>
    <path d="M60 64 q8 -14 20 -6" stroke="#fff" stroke-opacity=".6" stroke-width="3" fill="none" stroke-linecap="round"/>
    <circle cx="${(75 + 64 * Math.sin(share * 2 * Math.PI)).toFixed(1)}" cy="${(75 - 64 * Math.cos(share * 2 * Math.PI)).toFixed(1)}" r="5" fill="#fff"/>
  </svg>`;
}

function skyArt(kg) {
  const count = Math.max(4, Math.min(26, Math.round(mid(kg) / 2)));
  const r = rand(7);
  let bubbles = "";
  for (let i = 0; i < count; i++) {
    const x = 20 + r() * 560, y = 70 + r() * 40, s = 2 + r() * 5;
    bubbles += `<circle class="bubble" style="animation-delay:${(r() * 6).toFixed(2)}s;animation-duration:${(5 + r() * 4).toFixed(1)}s" cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${s.toFixed(1)}" fill="none" stroke="#c4b5fd" stroke-width="1.2"/>`;
  }
  return `<svg viewBox="0 0 600 120" preserveAspectRatio="none" aria-hidden="true">
    ${bubbles}
    <path d="M0 80 C 90 50, 170 95, 260 70 S 430 40, 600 72 V120 H0z" fill="#2a1d4a"/>
    <path d="M0 95 C 120 75, 200 110, 320 92 S 500 78, 600 98 V120 H0z" fill="#4c1d95" opacity=".85"/>
    <path d="M0 108 C 140 98, 260 118, 380 106 S 540 100, 600 110 V120 H0z" fill="#8b5cf6" opacity=".7"/>
  </svg>`;
}

function mosaic(items) {
  const total = items.reduce((a, b) => a + b.cost, 0) || 1;
  const tiles = [];
  const shades = ["#7c3aed", "#9b6dff", "#5b21b6", "#b9a2ff", "#4c1d95", "#d8ccff", "#3b1a78"];
  const lay = (list, x, y, w, h, vertical) => {
    if (!list.length) return;
    if (list.length === 1) { tiles.push({ ...list[0], x, y, w, h }); return; }
    const sum = list.reduce((a, b) => a + b.cost, 0);
    const share = list[0].cost / sum;
    if (vertical) { tiles.push({ ...list[0], x, y, w: w * share, h }); lay(list.slice(1), x + w * share, y, w * (1 - share), h, !vertical); }
    else { tiles.push({ ...list[0], x, y, w, h: h * share }); lay(list.slice(1), x, y + h * share, w, h * (1 - share), !vertical); }
  };
  lay(items.filter((i) => i.cost > 0).sort((a, b) => b.cost - a.cost), 0, 0, 100, 100, true);
  return `<div class="mosaic" style="position:relative;display:block">${tiles.map((t, i) => {
    const bg = shades[i % shades.length];
    const light = ["#b9a2ff", "#d8ccff"].includes(bg);
    const small = t.w < 14 || t.h < 26;
    return `<button class="tile" data-open="${esc(t.groupId || "")}" title="${esc(friendly(t.function))}: ${usd(t.cost)} a month"
      style="position:absolute;left:calc(${t.x}% + 3px);top:calc(${t.y}% + 3px);width:calc(${t.w}% - 6px);height:calc(${t.h}% - 6px);background:${bg};color:${light ? "#120d1c" : "#fff"}">
      ${small ? "" : `<span class="n">${esc(friendly(t.function))}</span><span class="v">${usd(t.cost)}</span>`}</button>`;
  }).join("")}</div><div class="muted" style="font-size:13px;margin-top:10px">${usd(total)} a month in total</div>`;
}

function leafGlyph(seed, dim) {
  const r = rand(hash(seed));
  const a = 20 + r() * 40, b = 8 + r() * 6;
  return `<svg class="glyph" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="21" fill="${dim ? "#1b1726" : "rgba(139,92,246,.14)"}"/>
    <path d="M14 32 C ${14 + b} ${32 - a / 2}, ${24 + b} 14, 32 12 C 31 ${18 + b}, 26 30, 14 32z" fill="${dim ? "#5f586f" : "url(#gPurple)"}"/>
    <path d="M14 32 L 28 17" stroke="#120d1c" stroke-width="1.2" opacity=".5"/></svg>`;
}

function fallingLeavesArt() {
  const r = rand(11);
  let s = "";
  for (let i = 0; i < 9; i++) {
    const x = 30 + r() * 160;
    s += `<ellipse class="fall" style="--dx:${((r() - .5) * 60).toFixed(0)}px;animation-delay:${(r() * 3).toFixed(2)}s" cx="${x.toFixed(0)}" cy="${(10 + r() * 30).toFixed(0)}" rx="8" ry="3.5" fill="${i % 3 ? "url(#gPurple)" : "#fff"}"/>`;
  }
  return `<svg viewBox="0 0 220 160" aria-hidden="true">${s}<ellipse cx="110" cy="150" rx="90" ry="10" fill="url(#gGlow)"/></svg>`;
}

function gaugeArt(value, limit) {
  const max = Math.max(limit * 4, value * 1.15, 1);
  const ang = (v) => Math.PI * (1 - Math.min(v, max) / max);
  const pt = (a, rr) => [110 + rr * Math.cos(a), 120 - rr * Math.sin(a)];
  const [lx, ly] = pt(ang(limit), 90);
  const [nx, ny] = pt(ang(value), 74);
  return `<svg viewBox="0 0 220 140" aria-hidden="true">
    <path d="M20 120 A90 90 0 0 1 200 120" fill="none" stroke="#2a2438" stroke-width="14" stroke-linecap="round"/>
    <path d="M20 120 A90 90 0 0 1 ${pt(ang(value), 90).map((v) => v.toFixed(1)).join(" ")}" fill="none" stroke="url(#gPurple)" stroke-width="14" stroke-linecap="round"/>
    <line x1="${lx.toFixed(1)}" y1="${(ly - 12).toFixed(1)}" x2="${lx.toFixed(1)}" y2="${(ly + 12).toFixed(1)}" stroke="#fff" stroke-width="3" transform="rotate(${(90 - ang(limit) * 180 / Math.PI).toFixed(1)} ${lx.toFixed(1)} ${ly.toFixed(1)})"/>
    <line x1="110" y1="120" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
    <circle cx="110" cy="120" r="7" fill="#fff"/>
  </svg>`;
}

function ringArt(cost, budget) {
  const C = 2 * Math.PI * 54, share = budget ? cost / budget : 0;
  const first = Math.min(1, share), over = Math.max(0, Math.min(1, share - 1));
  return `<svg viewBox="0 0 140 140" aria-hidden="true">
    <circle cx="70" cy="70" r="54" fill="none" stroke="#2a2438" stroke-width="12"/>
    <circle cx="70" cy="70" r="54" fill="none" stroke="url(#gPurple)" stroke-width="12" stroke-linecap="round" stroke-dasharray="${(first * C).toFixed(1)} ${C}" transform="rotate(-90 70 70)"/>
    ${over ? `<circle cx="70" cy="70" r="40" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-dasharray="${(over * 2 * Math.PI * 40).toFixed(1)} 999" transform="rotate(-90 70 70)"/>` : ""}
    <text x="70" y="68" text-anchor="middle" fill="#f6f4fb" font-family="Instrument Serif, serif" font-size="26">${usd(cost)}</text>
    <text x="70" y="88" text-anchor="middle" fill="#9a93ac" font-family="Manrope, sans-serif" font-size="11">of ${usd(budget)}</text>
  </svg>`;
}

function sproutArt() {
  return `<svg viewBox="0 0 260 160" aria-hidden="true">
    <ellipse cx="130" cy="140" rx="100" ry="14" fill="url(#gGlow)"/>
    <path d="M60 140 Q130 120 200 140" stroke="#4c1d95" stroke-width="6" fill="none" stroke-linecap="round"/>
    <path d="M130 136 C 128 110, 132 90, 130 70" stroke="#d8ccff" stroke-width="3" fill="none" stroke-linecap="round"/>
    <path class="breathe" d="M130 84 C 108 82, 96 64, 98 50 C 116 52, 128 66, 130 84z" fill="url(#gPurple)"/>
    <path class="breathe" d="M130 74 C 150 70, 164 52, 162 38 C 144 42, 132 56, 130 74z" fill="url(#gPurple)"/>
  </svg>`;
}

// ---------- views ----------

function renderHome() {
  const el = $("#view-home");
  const p = state.project;
  if (!p) { el.innerHTML = ""; return; }
  const f = figures();
  const share = f.initialKwh[1] ? Math.min(1, mid(f.kwh) / mid(f.initialKwh)) : 0;
  const phones = Math.round(mid(f.kwh) / 0.015);
  const km = Math.round(mid(f.kg) / 0.17);
  const groupBySite = Object.fromEntries(p.groups.map((g) => [g.id, g.id]));
  const allApplied = p.totals.cost - f.readyUsd;
  el.innerHTML = `
    <div class="hero">
      <div class="card money">
        <div class="label">${f.done ? "Saved every month" : "You could save every month"}</div>
        <div class="big-num">${usd(f.heroUsd)}<small>/ month</small></div>
        <div class="sub">${f.done ? `From <b>${usd(p.initial.cost)}</b> down to <b>${usd(p.totals.cost)}</b> a month` : `Out of <b>${usd(p.totals.cost)}</b> spent on AI each month`}</div>
        ${treeArt()}
      </div>
      <div class="earth">
        <div class="card orb-card">
          ${orbArt(share)}
          <div><div class="label">${f.done ? "Energy saved" : "Energy you could save"}</div>
            <div class="mid-num">${rng(f.kwh)}<small>kWh / month</small></div>
            <div class="eq">About <b>${int(phones)}</b> phone charges every month</div></div>
        </div>
        <div class="card sky">
          <div class="label">${f.done ? "Carbon avoided" : "Carbon you could avoid"}</div>
          <div class="mid-num">${rng(f.kg)}<small>kg CO₂ / month</small></div>
          <div class="eq">Like skipping <b>${int(km)} km</b> of driving</div>
          ${skyArt(f.kg)}
        </div>
      </div>
    </div>
    <div class="row2">
      <div class="card"><div class="label">Where the money goes now</div>
        ${mosaic(p.sites.map((s) => ({ ...s, groupId: groupBySite[s.id] })))}</div>
      <div class="card"><div class="label">Monthly AI bill</div>
        ${duo([["Before", p.initial.cost, "before"], ["Now", p.totals.cost, "after"], ["With every fix", allApplied, "after"]])}</div>
    </div>
    ${f.ready.length ? `<div class="card cta"><div><div class="serif">${f.ready.length} fix${f.ready.length === 1 ? "" : "es"} ready</div>
      <div class="muted">Each one is checked before anything changes.</div></div>
      <button class="primary big" data-go="fixes">See fixes</button></div>` : ""}`;
}

function duo(cols) {
  const max = Math.max(...cols.map((c) => c[1]), 1);
  return `<div class="duo">${cols.map(([k, v, cls]) => `<div class="col"><div class="v">${usd(v)}</div>
    <div class="bar ${cls}" style="height:${Math.max(4, (v / max) * 150)}px"></div><div class="k">${k}</div></div>`).join("")}</div>`;
}

function renderFixes() {
  const el = $("#view-fixes");
  const p = state.project;
  if (!p) { el.innerHTML = ""; return; }
  const open = p.groups.filter((g) => g.has_edits), tips = p.groups.filter((g) => !g.has_edits);
  const item = (g, done) => `<button class="fix-item ${state.selected === g.id ? "active" : ""} ${done ? "done" : ""}" data-select="${esc(g.id)}">
      ${leafGlyph(g.id, done || !g.has_edits)}
      <span><div class="name">${esc(friendly(g.function))}</div><div class="meta">${done ? "Applied" : g.has_edits ? `${rng(g.summary.saved_kwh)} kWh less a month` : "Tip"}</div></span>
      <span class="save">${done ? "✓" : g.has_edits ? about(g.summary.saved_usd) : ""}</span></button>`;
  const doneItems = p.accepted.map((a) => item({ id: "accepted:" + a.id, function: a.function, summary: { saved_usd: a.saved_usd, saved_kwh: a.saved_kwh }, has_edits: true }, true));
  el.innerHTML = `<div class="fixes">
    <div class="fix-list">${open.map((g) => item(g)).join("")}${tips.map((g) => item(g)).join("")}${doneItems.join("")}
      ${!p.groups.length && !p.accepted.length ? `<div class="card empty-art">${sproutArt()}<p class="muted">No AI waste found here.</p></div>` : ""}</div>
    <div class="wizard" id="wizard">${wizard()}</div></div>`;
}

function wizard() {
  const p = state.project;
  if (state.selected?.startsWith("accepted:")) {
    const a = p.accepted.find((x) => "accepted:" + x.id === state.selected);
    if (!a) return "";
    return `<div class="card applied">${fallingLeavesArt()}<div class="label">${esc(friendly(a.function))}</div>
      <div class="serif">−${about(a.saved_usd)} a month</div><div class="muted">${rng(a.saved_kwh)} kWh less energy every month</div>
      <p class="muted" style="max-width:440px;margin:18px auto 0">${a.rollout.length > 1 ? "Rolling out to a small share of people first. Prune undoes it on its own if answers get worse." : "Live for everyone. Nothing about the answers changed."}</p></div>`;
  }
  const g = p.groups.find((x) => x.id === state.selected);
  if (!g) return `<div class="card empty-art">${sproutArt()}<p class="muted">Pick a fix on the left.</p></div>`;
  const st = g.status, sm = g.summary;
  const inc = g.findings.filter((f) => f.included), later = g.findings.filter((f) => !f.included);
  const mf = g.findings.find((f) => f.rule === "model_too_big" && f.included);
  const busy = (k) => (state.busy === k ? '<span class="spin"></span>' : "");
  const dis = state.busy ? "disabled" : "";

  if (!g.has_edits) {
    return `<div class="card"><div class="wiz-head"><div><div class="label">${esc(friendly(g.function))}</div><div class="serif">A tip for later</div></div></div>
      <ul class="found" style="margin-top:18px">${later.map((f) => `<li>${esc(PLAIN[f.rule])}${f.saved_usd ? ` <span class="muted">· could save ${about(f.saved_usd)}/month</span>` : ""}</li>`).join("")}</ul>
      <p class="muted">Prune can't prove this one is safe yet, so nothing changes automatically.</p></div>`;
  }

  const testsDone = st.tests?.passed;
  const needsCompare = !!mf && mf.proof === "replay";
  const rp = st.replay;
  const compareDone = !needsCompare || rp?.decision === "accepted";
  let stage = 1;
  if (testsDone) stage = 2;
  if (testsDone && compareDone) stage = 3;

  const s1 = `<div class="stage done"><div class="dot">✓</div><div><h3>What Prune found</h3>
    <ul class="found">${inc.map((f) => `<li>${esc(PLAIN[f.rule])}</li>`).join("")}${later.map((f) => `<li class="later">${esc(PLAIN[f.rule])} · not part of this fix</li>`).join("")}</ul></div></div>`;

  const s2 = `<div class="stage ${testsDone ? "done" : "now"}"><div class="dot">${testsDone ? "✓" : "2"}</div><div><h3>Make sure nothing breaks</h3>
    ${st.tests ? `<div class="ok-line ${st.tests.passed ? "" : "bad"}"><span class="tick">${st.tests.passed ? "✓" : "!"}</span>
      ${st.tests.passed ? (st.tests.kind === "tests" ? `All ${st.tests.tests_run} checks passed` : "The code still runs") : "A check failed, so this fix is off"}</div>`
      : `<p>Prune tries the change on a copy of your project and runs your own checks.</p><button class="primary" data-act="tests" ${dis}>${busy("tests")}Run safety check</button>`}</div></div>`;

  let s3 = "";
  if (mf) {
    let body;
    if (mf.proof === "ledger") {
      body = `<div class="ok-line"><span class="tick">✓</span>Prune has seen this work before</div>
        <p style="margin-top:8px">On a similar task, ${int(mf.ledger.matched)} of ${int(mf.ledger.total)} answers stayed the same with the smaller model.</p>`;
    } else if (!rp) {
      body = `<p>Prune asks both the current and the cheaper AI the same ${int(g.recorded_requests)} past questions, with personal details removed, and shows you any answers that change.</p>
        <button class="primary" data-act="replay" ${!testsDone || state.busy ? "disabled" : ""}>${busy("replay")}Compare ${int(g.recorded_requests)} past answers</button>`;
    } else {
      const diffs = rp.rows.filter((r) => !r.same);
      const dots = Array.from({ length: rp.total }, (_, i) => `<i class="${i < diffs.length ? "diff" : ""}" style="animation-delay:${(i % 50) * 8 + Math.floor(i / 50) * 20}ms"></i>`);
      const r = rand(42); for (let i = dots.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [dots[i], dots[j]] = [dots[j], dots[i]]; }
      body = `<div class="serif" style="font-size:34px">${int(rp.matched)} of ${int(rp.total)} answers stayed the same</div>
        <div class="dots">${dots.join("")}</div>
        <div class="muted" style="font-size:13px">The ${diffs.length} that changed:</div>
        <div class="diffs">${diffs.map((d) => `<div class="q"><div class="t">“${esc(d.input)}”</div><div class="a">Before: <b>${esc(d.before)}</b> · After: <b>${esc(d.after)}</b></div></div>`).join("")}</div>
        ${st.guard ? `<label class="switch"><input type="checkbox" data-act="guard" ${st.guard.enabled ? "checked" : ""} ${rp.decision ? "disabled" : ""}>
          <span>Keep the bigger AI for messages that mention ${st.guard.keywords.map((k) => `“${esc(k)}”`).join(" or ")}</span></label>` : ""}
        ${rp.decision ? `<div class="ok-line ${rp.decision === "accepted" ? "" : "bad"}"><span class="tick">${rp.decision === "accepted" ? "✓" : "✕"}</span>${rp.decision === "accepted" ? "You approved these answers" : "You kept the current AI"}</div>`
          : `<div class="btns"><button class="primary" data-act="decide" data-decision="accepted" ${dis}>${busy("decide")}Looks good</button>
             <button class="ghost" data-act="decide" data-decision="rejected" ${dis}>Keep the current AI</button></div>`}`;
    }
    const ok = mf.proof === "ledger" || rp?.decision === "accepted";
    s3 = `<div class="stage ${ok ? "done" : testsDone ? "now" : ""}"><div class="dot">${ok ? "✓" : "3"}</div><div><h3>Check the answers stay the same</h3>${body}</div></div>`;
  }

  const n = mf ? 4 : 3;
  const s4 = `<div class="stage ${stage === 3 ? "now" : ""}"><div class="dot">${n}</div><div><h3>Apply it</h3>
    <button class="primary big" data-act="accept" ${st.can_accept && !state.busy ? "" : "disabled"}>${busy("accept")}Apply fix · save ${about(sm.saved_usd)}/month</button></div></div>`;

  const diffText = Object.values(st.diffs).join("\n").split("\n").filter((l) => !l.startsWith("+++") && !l.startsWith("---") && !l.startsWith("@@"))
    .map((l) => `<span class="${l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}">${esc(l) || " "}</span>`).join("\n");

  return `<div class="card">
    <div class="wiz-head"><div><div class="label">${esc(friendly(g.function))}</div><div class="serif">Save ${about(sm.saved_usd)} a month</div></div>
      <div class="pills"><span class="pill">${rng(sm.saved_kwh)} kWh less energy</span><span class="pill white">${usd(sm.cost_before)} → ${usd(sm.cost_after)}</span></div></div></div>
    <div class="card" style="display:flex;flex-direction:column;gap:22px">${s1}${s2}${s3}${s4}</div>
    <details class="code"><summary>Show the code change</summary><pre>${diffText}</pre></details>`;
}

function renderCheck() {
  const el = $("#view-check");
  const p = state.project;
  if (!p) { el.innerHTML = ""; return; }
  if (el.dataset.project !== p.id) {
    el.dataset.project = p.id;
    const inc = p.incoming;
    el.innerHTML = `<div class="check-grid">
      <div class="card"><h2 class="title">How much will new code cost?</h2>
        <p class="muted" style="margin:0">${inc ? esc(inc.title.replace(/^PR #\d+:\s*/, "")) : "Paste a new feature before it goes live."}</p>
        <label class="field">Times it will run per month<input id="incCalls" type="number" value="${inc?.calls_per_month || 10000}"></label>
        <input id="incFile" type="hidden" value="${esc(inc?.file || "new_feature.py")}">
        <textarea id="incCode" spellcheck="false" placeholder="Paste the new code here">${esc(inc?.code || "")}</textarea>
        <div class="btns" style="margin-top:14px"><button class="primary big" data-act="review">Estimate the cost</button></div></div>
      <div class="card verdict" id="verdict"></div></div>`;
  }
  const v = $("#verdict"), r = state.review;
  if (!r) { v.innerHTML = `${gaugeArt(0, p.approval_threshold)}<p class="muted">Your estimate shows up here.</p>`; return; }
  const c = r.check, stop = c.needs_approval || c.over_budget;
  const kwh = r.items.reduce((a, i) => [a[0] + i.kwh[0], a[1] + i.kwh[1]], [0, 0]);
  v.innerHTML = `${gaugeArt(r.added_usd, c.threshold)}
    <div class="label" style="margin-top:6px">This would add</div>
    <div class="serif">${about(r.added_usd)} a month</div>
    <div class="muted">and ${rng(kwh)} kWh of energy</div>
    <div class="stamp ${stop ? "stop" : "go"}">${stop ? "Needs a manager's OK" : "Within your limits"}</div>
    <p class="muted" style="font-size:13px;max-width:320px">${c.needs_approval ? `Your team asks for approval above ${usd(c.threshold)} a month.` : ""}
    ${c.feature && c.over_budget ? ` It would push “${esc(c.feature)}” past its ${usd(c.budget)} limit.` : ""}</p>`;
}

function renderLimits() {
  const el = $("#view-limits");
  const p = state.project;
  if (!p) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="intro"><div><h2 class="title">Monthly limits</h2><p>Each part of your product gets an AI budget. The white inner ring means it's over.</p></div></div>
    ${p.budgets.length ? `<div class="rings">${p.budgets.map((b) => `<div class="card ring ${b.over ? "over" : ""}">${ringArt(b.cost, b.budget)}
      <div class="n">${esc(b.feature.replace(/-/g, " "))}</div><div class="s">${b.over ? `${usd(b.cost - b.budget)} over` : `${usd(b.budget - b.cost)} to spare`}</div></div>`).join("")}</div>`
      : `<div class="card empty-art" style="margin-top:22px">${sproutArt()}<p class="muted">No limits set for this project yet.</p></div>`}`;
}

function renderLearned() {
  const el = $("#view-learned");
  const e = state.ledger;
  el.innerHTML = `<div class="intro"><div><h2 class="title">What Prune has learned</h2>
      <p>Every answer comparison you approve teaches Prune which cheaper choices are safe, so similar fixes elsewhere need no comparison. Only the pattern is kept, never your messages.</p></div>
      ${e.length ? `<button class="ghost" data-act="ledger-reset">Start over</button>` : ""}</div>
    ${e.length ? `<div class="lessons">${e.slice().reverse().map((x) => {
      const miss = x.matched < x.total ? Math.max(1, Math.round((1 - x.match_rate) * 50)) : 0;
      const bars = Array.from({ length: 50 }, (_, i) => { const same = i < 50 - miss;
        return `<rect x="${i * 12}" y="${same ? 10 : 30}" width="7" height="${same ? 50 : 30}" rx="3.5" fill="${same ? "url(#gPurple)" : "#fff"}"/>`; }).join("");
      return `<div class="card lesson"><div class="label">${x.decision === "accepted" ? "Approved" : "Turned down"} · ${esc(x.recorded_at.split(" ")[0])}</div>
        <div class="serif">${esc(x.lesson)}</div><svg viewBox="0 0 600 70" preserveAspectRatio="none">${bars}</svg>
        <div class="muted" style="font-size:13px">${int(x.matched)} of ${int(x.total)} answers matched</div></div>`;
    }).join("")}</div>`
      : `<div class="card empty-art" style="margin-top:22px">${sproutArt()}<p class="muted">Nothing yet. Approve an answer comparison in Fixes and it shows up here.</p></div>`}`;
}

function render() {
  const p = state.project;
  $("#fixCount").textContent = p ? p.groups.filter((g) => g.has_edits).length || "" : "";
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + state.tab));
  ({ home: renderHome, fixes: renderFixes, check: renderCheck, limits: renderLimits, learned: renderLearned })[state.tab]();
}

function go(tab) {
  state.tab = tab;
  history.replaceState(null, "", "#" + tab);
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------- events ----------

document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-tab]");
  if (t) { e.preventDefault(); go(t.dataset.tab); return; }
  const g = e.target.closest("[data-go]");
  if (g) { go(g.dataset.go); return; }
  const open = e.target.closest("[data-open]");
  if (open) { if (open.dataset.open) state.selected = open.dataset.open; go("fixes"); return; }
  const sel = e.target.closest("[data-select]");
  if (sel) {
    state.selected = sel.dataset.select;
    renderFixes();
    if (innerWidth < 960) $("#wizard").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
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
    if (r.ledger_entry) toast("Prune will remember this for similar fixes");
    await refreshLedger();
    await retestIfChanged(gid);
  });
  if (act === "accept") await run("accept", async () => {
    const r = await api("/api/accept", { project: p.id, group: gid });
    setProject(r.project);
    state.selected = "accepted:" + r.accepted.id;
    toast(`Done. Saving ${about(r.accepted.saved_usd)} a month`);
  });
  if (act === "review") {
    const body = { project: p.id, file: $("#incFile").value, code: $("#incCode").value, calls_per_month: $("#incCalls").value };
    try { state.review = await api("/api/review-change", body); } catch (err) { toast(err.message); }
    renderCheck();
  }
  if (act === "ledger-reset") {
    if (!confirm("Forget everything Prune has learned?")) return;
    await api("/api/ledger/reset", {});
    await refreshLedger();
    if (p?.sample) loadSample(p.sample);
  }
});

// A changed fix (e.g. the "keep the bigger AI" option) must pass the safety check again.
async function retestIfChanged(gid) {
  const grp = state.project.groups.find((x) => x.id === gid);
  if (grp && grp.has_edits && !grp.status.tests) {
    setProject((await api("/api/tests", { project: state.project.id, group: gid })).project);
  }
}

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
});

const TABS = ["home", "fixes", "check", "limits", "learned"];
window.addEventListener("hashchange", () => {
  const t = location.hash.slice(1);
  if (TABS.includes(t) && t !== state.tab) { state.tab = t; if (state.project) render(); }
});
state.tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "home";
loadSample("stepup");
