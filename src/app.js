import {
  CHAIN_ID, ROUTER, USDG, REFERRER, DEPLOY_BLOCK, FEE_BPS, lc, short, isZero,
  priceSwaps, aggregate, toCsv, parseUnits,
} from "./core.js";
import { makeRpc, sync, emptyState, stateFromSnapshot, fetchTokenMeta, PUBLIC_RPC } from "./chain.js";

const EXPLORER = "https://robinhoodchain.blockscout.com";
const API = "https://stoadex.com/api/v1";
const TRADE = "https://stoadex.com/trade?ref=" + REFERRER;
const CACHE_KEY = "stoa-ledger-state-v1";
const POLL_MS = 60_000;
const PAGE = 12;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd = (n) => (n == null ? "–" : "$" + (n >= 1000 ? Math.round(n).toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 2 })));
const usdShort = (n) => (n >= 1e6 ? "$" + (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? "$" + (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k" : "$" + Math.round(n));
const amt = (n) => (n === 0 ? "0" : n >= 1000 ? Math.round(n).toLocaleString("en-US") : n.toLocaleString("en-US", { maximumSignificantDigits: 5 }));
const pct = (n) => (n * 100 < 10 && n > 0 ? (n * 100).toFixed(1) : Math.round(n * 100)) + "%";
const stamp = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") : "–");
const addrLink = (a) => `<a class="mono" href="${EXPLORER}/address/${esc(a)}" rel="noopener">${esc(short(a))}</a>`;
const txLink = (h) => `<a class="mono" href="${EXPLORER}/tx/${esc(h)}" rel="noopener">${esc(short(h))}</a>`;
const MINE = lc(REFERRER);

const S = {
  chain: emptyState(), swaps: [], agg: null, rpc: makeRpc(new URLSearchParams(location.search).get("rpc") || PUBLIC_RPC),
  metric: "usd", range: 30, sort: { key: "time", dir: -1 }, page: 0, open: new Set(),
  q: "", venue: "", ref: "", min: 0, busy: false, lastOk: 0, account: null, quote: null, source: "none", error: null,
};

/* ---------------- data ---------------- */
function readCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch { return null; } }
function writeCache() {
  try { const { raw, lastBlock, head, times, meta, gasUsd, dex, updated } = S.chain; localStorage.setItem(CACHE_KEY, JSON.stringify({ version: 1, router: ROUTER, raw, lastBlock, head, times, meta, gasUsd, dex, updated })); } catch { /* private mode */ }
}
async function loadSnapshot() { try { const r = await fetch("data/stats.json", { cache: "no-cache" }); return r.ok ? await r.json() : null; } catch { return null; } }

function recompute() {
  S.swaps = priceSwaps(S.chain.raw, S.chain);
  S.agg = aggregate(S.swaps);
  renderAll();
}

async function refresh() {
  if (S.busy) return;
  S.busy = true; $("reload").disabled = true;
  try {
    await sync(S.rpc, S.chain, (step) => { if (!S.lastOk) setStatus("loading", step + "…"); });
    S.lastOk = Date.now(); S.source = "live"; S.error = null;
    writeCache(); recompute();
  } catch (e) {
    S.error = e.message || "request failed";
    setStatus("err", `Can’t reach the chain right now (${S.error}). Showing ${S.chain.raw.length ? "data up to block " + S.chain.lastBlock.toLocaleString("en-US") : "nothing yet"}.`);
    if (S.agg) renderAll();
  } finally { S.busy = false; $("reload").disabled = false; }
}

function setStatus(kind, text) {
  $("status").className = "pill " + (kind === "live" ? "live" : kind === "err" ? "err" : "");
  $("status-text").textContent = text;
}
function statusLine() {
  if (S.error) return;
  if (S.source === "live") setStatus("live", `Live, block ${S.chain.head.toLocaleString("en-US")}, updated ${new Date(S.chain.updated * 1000).toISOString().slice(11, 19)} UTC`);
  else if (S.chain.raw.length) setStatus("", `Snapshot from ${stamp(S.chain.updated)} UTC, catching up with the chain…`);
}

/* ---------------- rendering ---------------- */
function renderAll() {
  if (!S.agg) return;
  statusLine(); renderKpis(); renderChart(); renderVenues(); renderPeople(); renderSwaps(); renderQuoteTokens();
}

function renderKpis() {
  const t = S.agg.total, r = S.agg.referred;
  const cells = [
    ["Total volume", usd(t.usdAll), `${t.swaps.toLocaleString("en-US")} swaps${t.unpriced ? `, ${t.unpriced} unpriced` : ""}`],
    ["Last 24 hours", usd(t.usd24h), `${t.swaps24h} swaps`],
    ["Last 7 days", usd(t.usd7d), `${t.swaps7d} swaps`],
    ["Traders", t.traders.toLocaleString("en-US"), `average swap ${usd(t.avg)}`],
    ["Referred", pct(r.share), `${r.swaps} swaps, ${usd(r.usd)}`],
    ["Fees at 2 bps", usd(S.agg.feeEstimate), t.largest ? `largest swap ${usd(t.largest.usd)}` : "estimate"],
  ];
  $("kpis").innerHTML = cells.map(([k, v, sub]) => `<div class="kpi"><dt>${esc(k)}</dt><dd>${esc(v)}</dd><small>${esc(sub)}</small></div>`).join("");
}

/* the colonnade: one fluted column per UTC day */
const niceMax = (v) => { if (v <= 0) return 1; const e = 10 ** Math.floor(Math.log10(v)), f = v / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e; };
function chartDays() { const d = S.agg.days; return S.range ? d.slice(-S.range) : d; }
function renderChart() {
  const days = chartDays(), el = $("chart");
  if (!days.length) { el.innerHTML = `<p class="empty">No swaps yet.</p>`; return; }
  const val = (d) => (S.metric === "usd" ? d.usd : d.swaps);
  const max = niceMax(Math.max(...days.map(val))), n = days.length;
  const slot = Math.max(28, Math.min(66, 980 / n)), gut = 56, W = gut + n * slot + 10, H = 290, base = 246, top = 14;
  const inner = base - top - 20;
  const fmt = (v) => (S.metric === "usd" ? usdShort(v) : String(Math.round(v)));
  let g = `<defs>
    <linearGradient id="shaft" x1="0" x2="1"><stop offset="0" stop-color="#2a8fd0"/><stop offset=".45" stop-color="#5fb4e6"/><stop offset="1" stop-color="#0d6aa8"/></linearGradient>
    <pattern id="flutes" width="7" height="10" patternUnits="userSpaceOnUse"><rect x="1.5" width="1.2" height="10" fill="#fff" opacity=".3"/><rect x="4.6" width="1" height="10" fill="#094e7c" opacity=".18"/></pattern>
  </defs>`;
  for (const f of [0, 0.5, 1]) {
    const y = base - 4 - f * inner;
    g += `<line class="grid-line" x1="${gut - 6}" x2="${W}" y1="${y}" y2="${y}"/><text x="${gut - 12}" y="${y + 4}" text-anchor="end">${f ? fmt(max * f) : "0"}</text>`;
  }
  days.forEach((d, i) => {
    const cx = gut + i * slot + slot / 2, cw = Math.min(slot * 0.5, 30), v = val(d);
    const h = v > 0 ? Math.max(6, (v / max) * inner) : 0, ys = base - 4 - h;
    const label = `${d.date}: ${S.metric === "usd" ? usd(d.usd) : d.swaps + " swaps"}${S.metric === "usd" ? ", " + d.swaps + " swaps" : ", " + usd(d.usd)}`;
    g += `<g class="col" tabindex="0" data-i="${i}" data-label="${esc(d.date)}" data-main="${esc(S.metric === "usd" ? usd(d.usd) : d.swaps + (d.swaps === 1 ? " swap" : " swaps"))}" data-alt="${esc(S.metric === "usd" ? d.swaps + (d.swaps === 1 ? " swap" : " swaps") : usd(d.usd))}" aria-label="${esc(label)}">
      <rect x="${cx - slot / 2}" y="${top}" width="${slot}" height="${base - top}" fill="transparent"/>`;
    if (h) {
      g += `<rect class="shaft" x="${cx - cw / 2}" y="${ys}" width="${cw}" height="${h}" fill="url(#shaft)"/>
        <rect x="${cx - cw / 2}" y="${ys}" width="${cw}" height="${h}" fill="url(#flutes)" style="pointer-events:none"/>
        <rect class="cap" x="${cx - cw / 2 - 5}" y="${ys - 8}" width="${cw + 10}" height="5"  rx="1.5"/>
        <rect class="cap" x="${cx - cw / 2 - 2}" y="${ys - 3}" width="${cw + 4}" height="3"/>`;
    } else g += `<rect class="stub" x="${cx - cw / 2}" y="${base - 7}" width="${cw}" height="3" rx="1.5"/>`;
    g += `<rect class="plinth" x="${cx - cw / 2 - 4}" y="${base - 4}" width="${cw + 8}" height="4" rx="1.5"/></g>`;
    if (n <= 16 || i % Math.ceil(n / 14) === 0 || i === n - 1) g += `<text x="${cx}" y="${base + 22}" text-anchor="middle">${esc(d.date.slice(5))}</text>`;
  });
  el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" style="min-width:${Math.min(W, 1100)}px" role="group" aria-label="${S.metric === "usd" ? "Daily volume in USD" : "Daily swap count"}">${g}</svg>`;
}
function bindChart() {
  const wrap = $("chart-card"), tip = $("tip");
  const show = (g) => {
    wrap.querySelectorAll(".col.on").forEach((x) => x.classList.remove("on")); g.classList.add("on");
    tip.innerHTML = `<b>${esc(g.dataset.label)}</b>${esc(g.dataset.main)}, ${esc(g.dataset.alt)}`;
    const r = g.getBoundingClientRect(), w = wrap.getBoundingClientRect();
    tip.style.left = Math.min(Math.max(r.left + r.width / 2 - w.left, 70), w.width - 70) + "px"; tip.style.top = r.top - w.top + 38 + "px"; tip.classList.add("on");
  };
  const hide = () => { tip.classList.remove("on"); wrap.querySelectorAll(".col.on").forEach((x) => x.classList.remove("on")); };
  wrap.addEventListener("pointerover", (e) => { const g = e.target.closest(".col"); if (g) show(g); });
  wrap.addEventListener("focusin", (e) => { const g = e.target.closest(".col"); if (g) show(g); });
  wrap.addEventListener("pointerleave", hide); wrap.addEventListener("focusout", hide);
}

function renderVenues() {
  const a = S.agg;
  $("venues").innerHTML = a.venues.length ? a.venues.map((v, i) => `<div>
    <div class="row-top"><b>${esc(v.name)}</b><span class="num">${v.swaps} ${v.swaps === 1 ? "swap" : "swaps"}, ${usd(v.usd)}</span></div>
    <div class="track" role="img" aria-label="${esc(v.name)} ${pct(v.share)} of swaps"><div class="fill ${i % 2 ? "alt" : ""}" style="width:${Math.max(2, v.share * 100)}%"></div></div>
    <div class="muted" style="font-size:13.5px;margin-top:4px">${pct(v.share)} of swaps${v.twoHop ? `, ${v.twoHop} as part of a two-hop route` : ""}</div></div>`).join("") : `<p class="empty">No swaps yet.</p>`;
  const s = a.shape, tot = s.direct + s.twoHop || 1;
  $("shape").innerHTML = `<div class="stack" role="img" aria-label="${s.direct} direct, ${s.twoHop} two-hop"><i style="width:${(s.direct / tot) * 100}%;background:var(--ocean)"></i><i style="width:${(s.twoHop / tot) * 100}%;background:var(--wave)"></i></div>
    <div class="legend"><span style="--c:var(--ocean)">${s.direct} direct, ${usd(s.usdDirect)}</span><span style="--c:var(--wave)">${s.twoHop} two-hop, ${usd(s.usdTwoHop)}</span></div>`;
  $("legs").innerHTML = a.legs.length ? table(["Path", "Swaps", "Volume"], a.legs.slice(0, 6).map((l) => [esc(l.path), l.swaps, usd(l.usd)]), [1, 2]) : `<p class="empty">No two-hop swaps yet.</p>`;
}

function table(head, rows, right = [], cls = []) {
  if (!rows.length) return `<p class="empty">Nothing here yet.</p>`;
  return `<table><thead><tr>${head.map((h, i) => `<th class="${right.includes(i) ? "r" : ""}">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r, ri) => `<tr class="${cls[ri] || ""}">${r.map((c, i) => `<td class="num ${right.includes(i) ? "r" : ""}">${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function renderPeople() {
  const a = S.agg, totalUsd = a.total.usdAll || 1;
  $("traders").innerHTML = table(["Trader", "Swaps", "Volume", "Share"], a.traders.slice(0, 10).map((t) => [addrLink(t.address), t.swaps, usd(t.usd), pct(t.usd / totalUsd)]), [1, 2, 3]);
  $("bought").innerHTML = table(["Token", "Buys", "Volume", "Last 24h"], a.bought.slice(0, 8).map((t) => [`<a href="${EXPLORER}/token/${esc(t.token)}" rel="noopener"><b>${esc(t.symbol)}</b></a>`, t.buys, usd(t.usd), usd(t.usd24h)]), [1, 2, 3]);
  const refs = a.referrers.slice(0, 10);
  $("referrers").innerHTML = table(["Referrer", "Swaps", "Volume", "Last 7 days", "Wallets this month", "Earned (est.)"],
    refs.map((r) => [addrLink(r.address) + (r.address === MINE ? ` <span class="tag you">this dashboard</span>` : ""), r.swaps, usd(r.usd), usd(r.usd7d), r.wallets, usd(r.earned)]), [1, 2, 3, 4, 5], refs.map((r) => (r.address === MINE ? "mine" : "")));
  const o = a.ours, w = Math.min(o.wallets, 10);
  $("ours").innerHTML = `<h3>This dashboard’s referrer address</h3>
    <p class="sub">${addrLink(REFERRER)}: ${o.swaps} referred ${o.swaps === 1 ? "swap" : "swaps"}, ${usd(o.usd)} volume, about ${usd(o.earned)} earned. From December 2026 Stoa pays a $10 USDG bonus to integrators with 10 or more wallets in a month.</p>
    <div class="progress" role="img" aria-label="${w} of 10 wallets"><i style="width:${w * 10}%"></i></div>
    <div class="muted" style="font-size:14px">${o.wallets} of 10 wallets this UTC month${o.wallets >= 10 ? ` <span class="tag ok">qualifies</span>` : ""}</div>`;
}

/* swaps explorer */
function filtered() {
  const q = S.q.trim().toLowerCase();
  let rows = S.swaps.filter((s) => {
    if (q && ![s.symIn, s.symOut, s.hash, s.trader, s.sender, s.referrer, s.tokenIn, s.tokenOut].some((x) => lc(x).includes(q))) return false;
    if (S.venue && !s.route.includes(S.venue)) return false;
    if (S.ref === "ours" && s.referrer !== MINE) return false;
    if (S.ref === "any" && !s.referrer) return false;
    if (S.ref === "none" && s.referrer) return false;
    if (S.min && (s.usd || 0) < S.min) return false;
    return true;
  });
  const k = S.sort.key, d = S.sort.dir;
  rows = rows.slice().sort((a, b) => d * ((a[k] ?? -1) - (b[k] ?? -1)) || d * (a.block - b.block));
  return rows;
}
function renderSwaps() {
  const sel = $("f-venue"), cur = S.venue;
  const names = S.agg.venues.map((v) => v.name);
  if (sel.options.length - 1 !== names.length) { sel.innerHTML = `<option value="">All venues</option>` + names.map((n) => `<option>${esc(n)}</option>`).join(""); sel.value = cur; }
  const rows = filtered(), pages = Math.max(1, Math.ceil(rows.length / PAGE));
  S.page = Math.min(S.page, pages - 1);
  const slice = rows.slice(S.page * PAGE, S.page * PAGE + PAGE);
  const arrow = (k) => (S.sort.key === k ? ` <span class="arr">${S.sort.dir > 0 ? "↑" : "↓"}</span>` : "");
  const sortAttr = (k) => (S.sort.key === k ? ` aria-sort="${S.sort.dir > 0 ? "ascending" : "descending"}"` : "");
  const key = (s) => s.hash + ":" + s.logIndex;
  let body = "";
  for (const s of slice) {
    const mine = s.referrer === MINE, open = S.open.has(key(s));
    body += `<tr class="clickable ${mine ? "mine" : ""}" data-k="${esc(key(s))}" tabindex="0" aria-expanded="${open}">
      <td class="num">${esc(stamp(s.time))}</td><td><b>${esc(s.symIn)}</b> → <b>${esc(s.symOut)}</b></td>
      <td class="num r">${esc(amt(s.amountIn))} ${esc(s.symIn)}</td><td class="num r">${esc(amt(s.amountOut))} ${esc(s.symOut)}</td>
      <td class="num r"><b>${usd(s.usd)}</b></td><td>${s.route.map((r) => `<span class="tag">${esc(r)}</span>`).join(" ")}</td>
      <td>${addrLink(s.trader)}</td><td>${s.referrer ? addrLink(s.referrer) : `<span class="muted">none</span>`}${mine ? ` <span class="tag you">mine</span>` : ""}</td></tr>`;
    if (open) body += `<tr class="detail"><td colspan="8"><div class="kv">
      <div><b>Transaction</b>${txLink(s.hash)}</div><div><b>Block</b>${s.block.toLocaleString("en-US")}</div>
      <div><b>Sender</b>${addrLink(s.sender)}</div><div><b>Received by</b>${addrLink(s.trader)}</div>
      <div><b>Route</b>${esc(s.route.join(" → ") || "none")}${s.mid ? `, through ${addrLink(s.mid)}` : ", direct"}</div>
      <div><b>Priced from</b>${esc(s.source || "not priced")}</div></div></td></tr>`;
  }
  $("swaps-table").innerHTML = rows.length ? `<table><thead><tr><th class="sort"${sortAttr("time")} data-sort="time">Time (UTC)${arrow("time")}</th><th>Pair</th><th class="r">Sold</th><th class="r">Received</th><th class="r sort"${sortAttr("usd")} data-sort="usd">USD${arrow("usd")}</th><th>Route</th><th>Trader</th><th>Referrer</th></tr></thead><tbody>${body}</tbody></table>` : `<p class="empty">No swaps match these filters.</p>`;
  $("pager-info").textContent = rows.length ? `${S.page * PAGE + 1}–${Math.min(rows.length, S.page * PAGE + PAGE)} of ${rows.length}` : "0 swaps";
  $("prev").disabled = S.page === 0; $("next").disabled = S.page >= pages - 1;
}

function bindSwaps() {
  $("q").addEventListener("input", (e) => { S.q = e.target.value; S.page = 0; renderSwaps(); });
  $("f-venue").addEventListener("change", (e) => { S.venue = e.target.value; S.page = 0; renderSwaps(); });
  $("f-ref").addEventListener("change", (e) => { S.ref = e.target.value; S.page = 0; renderSwaps(); });
  $("f-min").addEventListener("input", (e) => { S.min = Number(e.target.value) || 0; S.page = 0; renderSwaps(); });
  $("prev").addEventListener("click", () => { S.page--; renderSwaps(); });
  $("next").addEventListener("click", () => { S.page++; renderSwaps(); });
  const toggle = (tr) => { const k = tr.dataset.k; S.open.has(k) ? S.open.delete(k) : S.open.add(k); renderSwaps(); };
  $("swaps-table").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort]");
    if (th) { const k = th.dataset.sort; S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : -1 }; renderSwaps(); return; }
    if (e.target.closest("a")) return;
    const tr = e.target.closest("tr.clickable"); if (tr) toggle(tr);
  });
  $("swaps-table").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { const tr = e.target.closest("tr.clickable"); if (tr) { e.preventDefault(); toggle(tr); } } });
  $("csv").addEventListener("click", () => {
    const blob = new Blob([toCsv(filtered())], { type: "text/csv" }), a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "stoa-swaps.csv"; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
}

/* ---------------- quote and swap ---------------- */
function renderQuoteTokens() {
  const sel = $("q-token"), cur = sel.value;
  const opts = [["USDG", USDG], ...S.agg.bought.slice(0, 8).map((t) => [t.symbol, t.token])];
  const seen = new Set();
  sel.innerHTML = opts.filter(([, a]) => !seen.has(lc(a)) && seen.add(lc(a))).map(([s, a]) => `<option value="${esc(a)}">${esc(s)} ${esc(short(a))}</option>`).join("") + `<option value="custom">Other address…</option>`;
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
}
const ethereum = () => (typeof window !== "undefined" ? window.ethereum : undefined);

async function getQuote() {
  const out = $("q-out"), wei = parseUnits($("q-amount").value, 18);
  const buy = $("q-token").value === "custom" ? $("q-custom").value.trim() : $("q-token").value;
  if (!wei || wei <= 0n) { out.innerHTML = `<div class="notice warn">Enter an amount of ETH to sell, like 0.01.</div>`; return; }
  if (!/^0x[0-9a-fA-F]{40}$/.test(buy)) { out.innerHTML = `<div class="notice warn">Enter a token address that starts with 0x and has 40 hex characters.</div>`; return; }
  out.innerHTML = `<p class="muted" style="margin:0">Asking Stoa for the best route…</p>`; $("q-get").disabled = true; S.quote = null;
  try {
    const p = new URLSearchParams({ chain: "robinhood", sellToken: "native", buyToken: buy, amount: wei.toString(), slippageBps: "50", referrer: REFERRER });
    if (S.account) p.set("taker", S.account);
    const res = await fetch(`${API}/quote?${p}`, { signal: AbortSignal.timeout(15000) });
    const j = await res.json();
    if (!res.ok || j.error) throw new Error(j.error || "Stoa answered " + res.status);
    let dec = lc(buy) === lc(USDG) ? 6 : S.chain.meta[lc(buy)]?.decimals;
    let sym = lc(buy) === lc(USDG) ? "USDG" : S.chain.meta[lc(buy)]?.symbol;
    if (dec == null) { const m = (await fetchTokenMeta(S.rpc, [lc(buy)]))[lc(buy)]; dec = m?.decimals ?? 18; sym = m?.symbol ?? "TOKEN"; }
    S.quote = j;
    const f = (x) => Number(x) / 10 ** dec;
    const legs = (j.route?.legs || []).map((l) => l.name || short(l.venue)).join(" → ") || "direct";
    out.innerHTML = `<div class="muted" style="font-size:14px">You receive about</div><div class="big">${esc(amt(f(j.amountOut)))} ${esc(sym)}</div>
      <div class="kv" style="margin-top:14px"><div><b>Least you accept (0.5% slippage)</b>${esc(amt(f(j.minOut)))} ${esc(sym)}</div><div><b>Price impact</b>${esc(String(j.priceImpactPct ?? "n/a"))}%</div>
      <div><b>Route</b>${esc(legs)}${j.route?.mid ? ", through ETH" : ""}</div><div><b>Valid for</b>${esc(String(j.validForSeconds || 30))} seconds</div></div>
      <div class="controls" style="margin-top:16px">${j.tx ? `<button class="btn primary" id="q-send" type="button">Swap with my wallet</button>` : ""}<a class="btn" href="${esc(TRADE)}" rel="noopener">Open in Stoa</a></div>
      <div id="q-msg" style="margin-top:12px"></div>
      ${j.tx ? "" : `<p class="muted" style="font-size:14px;margin:12px 0 0">Connect a wallet to get a transaction you can send from here.</p>`}`;
    const send = $("q-send"); if (send) send.addEventListener("click", sendSwap);
  } catch (e) { out.innerHTML = `<div class="notice warn">Couldn’t get a quote: ${esc(e.message)}. Stoa’s API allows 60 requests a minute per IP.</div>`; }
  finally { $("q-get").disabled = false; }
}

async function connect() {
  const eth = ethereum(), msg = $("q-out");
  if (!eth) { msg.innerHTML = `<div class="notice warn">No wallet found in this browser. Use Open in Stoa to swap with your referrer applied.</div>`; return; }
  try {
    const [acc] = await eth.request({ method: "eth_requestAccounts" });
    S.account = acc; $("q-connect").textContent = short(acc);
    eth.on?.("accountsChanged", (a) => { S.account = a[0] || null; $("q-connect").textContent = S.account ? short(S.account) : "Connect wallet"; });
  } catch (e) { msg.innerHTML = `<div class="notice warn">Wallet connection was cancelled.</div>`; }
}

async function sendSwap() {
  const eth = ethereum(), tx = S.quote?.tx, box = $("q-msg");
  try {
    if (!eth || !S.account || !tx) throw new Error("Connect a wallet and get a fresh quote first.");
    // the checks Stoa's API docs ask for before signing anything built from a response
    if (lc(tx.to) !== lc(ROUTER)) throw new Error("The transaction doesn’t go to the Stoa router, so it was not sent.");
    if (Number(tx.chainId) !== CHAIN_ID) throw new Error("The transaction is for another chain, so it was not sent.");
    if (!lc(tx.data).includes(lc(REFERRER).slice(2))) throw new Error("The transaction doesn’t carry the referrer address, so it was not sent.");
    try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + CHAIN_ID.toString(16) }] }); }
    catch (e) {
      if (e.code !== 4902) throw e;
      await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0x" + CHAIN_ID.toString(16), chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [PUBLIC_RPC], blockExplorerUrls: [EXPLORER] }] });
    }
    box.innerHTML = `<div class="notice">Confirm the swap in your wallet…</div>`;
    const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from: S.account, to: tx.to, value: "0x" + BigInt(tx.value || 0).toString(16), data: tx.data }] });
    box.innerHTML = `<div class="notice good">Sent. ${txLink(hash)}. It appears in the table above within a minute.</div>`;
    setTimeout(refresh, 8000);
  } catch (e) { box.innerHTML = `<div class="notice warn">${esc(e.message || "The wallet rejected the request.")}</div>`; }
}

/* ---------------- boot ---------------- */
function bindControls() {
  document.querySelectorAll("[data-metric]").forEach((b) => b.addEventListener("click", () => {
    S.metric = b.dataset.metric; document.querySelectorAll("[data-metric]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); renderChart();
  }));
  document.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => {
    S.range = Number(b.dataset.range); document.querySelectorAll("[data-range]").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); renderChart();
  }));
  $("reload").addEventListener("click", refresh);
  $("q-get").addEventListener("click", getQuote); $("q-connect").addEventListener("click", connect);
  $("q-token").addEventListener("change", (e) => { $("q-custom-wrap").hidden = e.target.value !== "custom"; });
  $("q-amount").addEventListener("keydown", (e) => { if (e.key === "Enter") getQuote(); });
  bindChart(); bindSwaps();
}

export async function init() {
  $("q-ref").textContent = REFERRER; $("trade-top").href = TRADE;
  $("m-block").textContent = DEPLOY_BLOCK.toLocaleString("en-US");
  const mr = $("m-router"); mr.textContent = ROUTER; mr.href = `${EXPLORER}/address/${ROUTER}`;
  $("kpis").innerHTML = Array.from({ length: 6 }, () => `<div class="kpi"><dt><span class="skeleton"></span></dt><dd><span class="skeleton" style="width:7em;height:1.2em"></span></dd></div>`).join("");
  setStatus("loading", "Loading swaps…");
  bindControls();
  // paint from the freshest copy we have, then catch up from the chain
  const [snap, cache] = [await loadSnapshot(), readCache()];
  const best = [stateFromSnapshot(snap), stateFromSnapshot(cache)].sort((a, b) => b.lastBlock - a.lastBlock)[0];
  if (best.lastBlock) { S.chain = best; S.source = "snapshot"; recompute(); }
  await refresh();
  if (!globalThis.__STOA_NO_POLL) setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - S.lastOk > POLL_MS / 2) refresh(); });
}

if (!globalThis.__STOA_NO_AUTO) init();
