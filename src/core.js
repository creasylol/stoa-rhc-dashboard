// Pure logic shared by the browser dashboard, the CLI and the tests: no network, no DOM.
// Counting follows Stoa's own /stats page (web/lib/routerStats.ts in StoaDex/Stoa): one Routed event is one
// settled swap, valued once on its stablecoin side, else its gas-token side at the router's quote, else DexScreener.

export const CHAIN_ID = 4663;
export const ROUTER = "0x2F2804fad735a38015650f32f95Ad5E08D6B3eE5";
export const DEPLOY_BLOCK = 114244443;
export const NATIVE = "0x0000000000000000000000000000000000000000";
export const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
// keccak256("Routed(address,address,address,address,address,uint256,uint256,address,address,address)")
export const ROUTED_TOPIC = "0x2bbce25631e8fa58085b7ea5929726c3acdf2df8d6b1f099eb32fb7425a4f6da";
export const REFERRER = "0x1F0AE5e17084857C7D4Ef289C15fC5d043087019";
export const FEE_BPS = 2;
export const REF_SHARE = 0.1;

export const lc = (a) => String(a || "").toLowerCase();
export const isZero = (a) => /^0x0{40}$/i.test(a || "");
export const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "–");

// Adapter addresses from contracts/deployments and web/lib/deployments-4663.json in StoaDex/Stoa.
export const VENUES = {
  "0x5c8537e7d755884326de0969ce7bdb14195f56be": "Uniswap V2",
  "0x28802ad6f9859d14dfc6226ea9a8b60686d3a2e6": "Uniswap V3",
  "0x27958279f95225b2a5517e7dd12b6fc0317e5c5d": "Uniswap V4",
  "0x8965140fb51b2e99a0cd31a0e99eae01d36517b8": "Uniswap V4",
  "0xf0904b95d66f565de215cc7dc58b6054f72a9352": "Aero",
  "0x87b3b896beabdc421f9d9b0a3fd3dbbae1ddd568": "Ramses",
  "0x58c2c83b66088b57b9dd487ba1090992bc9eebe0": "Pons",
  "0x1341db53ed69ce1def86bdbfc60d5fd92cf9004f": "Metric",
  "0xb40892c77bc4a1aba744c1afd96fce048d6456c3": "Up",
};
export const venueName = (a) => (isZero(a) ? null : VENUES[lc(a)] || "Other " + short(a));

const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
const addrAt = (hex, i) => "0x" + word(hex, i).slice(24);
const topicAddr = (t) => "0x" + t.slice(26);

/** Decode one eth_getLogs entry for the router's Routed event. Returns null for anything else. */
export function decodeRouted(log) {
  if (!log || !log.topics || lc(log.topics[0]) !== ROUTED_TOPIC || log.topics.length < 4) return null;
  if (!log.data || log.data.length < 2 + 64 * 7) return null;
  const d = log.data;
  return {
    hash: log.transactionHash,
    block: parseInt(log.blockNumber, 16),
    logIndex: parseInt(log.logIndex, 16),
    time: log.blockTimestamp ? parseInt(log.blockTimestamp, 16) : 0,
    sender: topicAddr(log.topics[1]),
    to: topicAddr(log.topics[2]),
    referrer: topicAddr(log.topics[3]),
    tokenIn: addrAt(d, 0), tokenOut: addrAt(d, 1),
    amountIn: BigInt("0x" + word(d, 2)).toString(),
    amountOut: BigInt("0x" + word(d, 3)).toString(),
    mid: addrAt(d, 4), venue1: addrAt(d, 5), venue2: addrAt(d, 6),
  };
}

// Tokens the router always deals in; no RPC lookup needed for these.
export const KNOWN_TOKENS = { [USDG.toLowerCase()]: { symbol: "USDG", decimals: 6 }, [WETH.toLowerCase()]: { symbol: "WETH", decimals: 18 } };

const PLAIN = new Set(["eth", "weth", "usdg", "usdc", "usdt", "usdt0", "usde", "usdh"]);

/**
 * Turn raw swaps into priced swaps.
 * ctx: { meta: {addr: {symbol, decimals}}, times: {block: unix}, gasUsd: number|0, dex: {addr: usdPrice} }
 */
export function priceSwaps(raws, ctx) {
  const meta = ctx.meta || {}, times = ctx.times || {}, dex = ctx.dex || {};
  const gasUsd = ctx.gasUsd || 0;
  const stables = new Set([lc(USDG)]);
  const gasSide = new Set([lc(NATIVE), lc(WETH)]);
  const m = (a) => (lc(a) === lc(NATIVE) ? { symbol: "ETH", decimals: 18 } : KNOWN_TOKENS[lc(a)] || meta[lc(a)] || { symbol: short(a), decimals: 18 });
  return raws.map((r) => {
    const tIn = lc(r.tokenIn), tOut = lc(r.tokenOut), mIn = m(r.tokenIn), mOut = m(r.tokenOut);
    const amountIn = Number(r.amountIn) / 10 ** mIn.decimals, amountOut = Number(r.amountOut) / 10 ** mOut.decimals;
    let usd = null, source = null;
    if (stables.has(tIn)) { usd = amountIn; source = "stablecoin"; }
    else if (stables.has(tOut)) { usd = amountOut; source = "stablecoin"; }
    else if (gasSide.has(tIn) && gasUsd) { usd = amountIn * gasUsd; source = "ETH quote"; }
    else if (gasSide.has(tOut) && gasUsd) { usd = amountOut * gasUsd; source = "ETH quote"; }
    else if (dex[tIn]) { usd = amountIn * dex[tIn]; source = "DexScreener"; }
    else if (dex[tOut]) { usd = amountOut * dex[tOut]; source = "DexScreener"; }
    const v1 = venueName(r.venue1), v2 = isZero(r.mid) ? null : venueName(r.venue2);
    return {
      hash: r.hash, block: r.block, logIndex: r.logIndex, time: r.time || times[r.block] || 0,
      sender: lc(r.sender), trader: lc(r.to), referrer: isZero(r.referrer) ? null : lc(r.referrer),
      tokenIn: r.tokenIn, tokenOut: r.tokenOut, symIn: mIn.symbol, symOut: mOut.symbol,
      amountIn, amountOut, usd, source,
      mid: isZero(r.mid) ? null : r.mid, venue1: r.venue1, venue2: isZero(r.mid) ? null : r.venue2,
      route: [v1, v2].filter(Boolean),
    };
  }).sort((a, b) => b.time - a.time || b.block - a.block || b.logIndex - a.logIndex);
}

/** Tokens whose addresses still need symbol/decimals. */
export function unknownTokens(raws, meta) {
  const out = new Set();
  for (const r of raws) for (const a of [r.tokenIn, r.tokenOut]) {
    if (lc(a) !== lc(NATIVE) && !KNOWN_TOKENS[lc(a)] && !meta[lc(a)]) out.add(lc(a));
  }
  return [...out];
}
/** Tokens that have no stablecoin or ETH side to price from. */
export function needsDex(raws) {
  const known = new Set([lc(USDG), lc(NATIVE), lc(WETH)]);
  const out = new Set();
  for (const r of raws) {
    if (known.has(lc(r.tokenIn)) || known.has(lc(r.tokenOut))) continue;
    out.add(lc(r.tokenIn)); out.add(lc(r.tokenOut));
  }
  return [...out];
}

const sum = (xs, f) => xs.reduce((a, x) => a + (f(x) || 0), 0);
const dayOf = (t) => Math.floor(t / 86400);
export const isoDay = (d) => new Date(d * 86400000).toISOString().slice(0, 10);

/** Everything the dashboard shows, from priced swaps. */
export function aggregate(swaps, now = Math.floor(Date.now() / 1000), ours = REFERRER) {
  const day = swaps.filter((s) => s.time >= now - 86400), week = swaps.filter((s) => s.time >= now - 7 * 86400);
  const priced = swaps.filter((s) => s.usd != null);
  const traders = new Map();
  for (const s of swaps) {
    if (!s.trader || isZero(s.trader)) continue;
    const t = traders.get(s.trader) || { address: s.trader, swaps: 0, usd: 0, last: 0 };
    t.swaps++; t.usd += s.usd || 0; t.last = Math.max(t.last, s.time); traders.set(s.trader, t);
  }
  const total = {
    swaps: swaps.length, usdAll: sum(swaps, (s) => s.usd), usd24h: sum(day, (s) => s.usd), usd7d: sum(week, (s) => s.usd),
    swaps24h: day.length, swaps7d: week.length, unpriced: swaps.length - priced.length, traders: traders.size,
    avg: priced.length ? sum(priced, (s) => s.usd) / priced.length : 0,
    largest: priced.reduce((a, s) => (!a || s.usd > a.usd ? s : a), null),
    first: swaps.length ? Math.min(...swaps.map((s) => s.time || now)) : null,
    last: swaps.length ? Math.max(...swaps.map((s) => s.time)) : null,
  };

  // every UTC day from the first swap to today
  const days = [];
  if (total.first) {
    const byDay = new Map();
    for (const s of swaps) { const k = dayOf(s.time); const o = byDay.get(k) || { swaps: 0, usd: 0 }; o.swaps++; o.usd += s.usd || 0; byDay.set(k, o); }
    for (let d = dayOf(total.first); d <= dayOf(now); d++) days.push({ date: isoDay(d), ...(byDay.get(d) || { swaps: 0, usd: 0 }) });
  }

  // venues: a swap counts once for each distinct venue it touched
  const venues = new Map();
  for (const s of swaps) for (const name of new Set(s.route)) {
    const v = venues.get(name) || { name, swaps: 0, usd: 0, twoHop: 0 };
    v.swaps++; v.usd += s.usd || 0; if (s.route.length > 1) v.twoHop++; venues.set(name, v);
  }
  const venueList = [...venues.values()].sort((a, b) => b.swaps - a.swaps || b.usd - a.usd).map((v) => ({ ...v, share: swaps.length ? v.swaps / swaps.length : 0 }));

  const hops = swaps.filter((s) => s.route.length > 1);
  const shape = { direct: swaps.length - hops.length, twoHop: hops.length, usdDirect: sum(swaps.filter((s) => s.route.length < 2), (s) => s.usd), usdTwoHop: sum(hops, (s) => s.usd) };
  const legs = new Map();
  for (const s of hops) { const k = s.route.join(" → "); const o = legs.get(k) || { path: k, swaps: 0, usd: 0 }; o.swaps++; o.usd += s.usd || 0; legs.set(k, o); }

  const pairs = new Map();
  for (const s of swaps) { const k = s.symIn + " → " + s.symOut; const o = pairs.get(k) || { pair: k, swaps: 0, usd: 0 }; o.swaps++; o.usd += s.usd || 0; pairs.set(k, o); }

  const bought = new Map();
  for (const s of swaps) {
    if (PLAIN.has(lc(s.symOut))) continue;
    const k = lc(s.tokenOut); const o = bought.get(k) || { token: s.tokenOut, symbol: s.symOut, buys: 0, usd: 0, usd24h: 0 };
    o.buys++; o.usd += s.usd || 0; if (s.time >= now - 86400) o.usd24h += s.usd || 0; bought.set(k, o);
  }

  // referrers, with the integrator-bonus test: 10 wallets, $1 or more each, in this UTC month, not the referrer itself
  const d0 = new Date(now * 1000), monthStart = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1) / 1000;
  const refs = new Map(), wallets = new Map();
  for (const s of swaps) {
    if (!s.referrer) continue;
    const r = refs.get(s.referrer) || { address: s.referrer, swaps: 0, usd: 0, usd7d: 0, wallets: 0, earned: 0 };
    r.swaps++; r.usd += s.usd || 0; if (s.time >= now - 7 * 86400) r.usd7d += s.usd || 0; refs.set(s.referrer, r);
    if (s.time >= monthStart && s.trader !== s.referrer && (s.usd || 0) >= 1) {
      const w = wallets.get(s.referrer) || new Set(); w.add(s.trader); wallets.set(s.referrer, w);
    }
  }
  for (const r of refs.values()) { r.wallets = wallets.get(r.address)?.size || 0; r.earned = r.usd * (FEE_BPS / 10000) * REF_SHARE; }
  const referrers = [...refs.values()].sort((a, b) => b.usd - a.usd || b.swaps - a.swaps);
  const referred = swaps.filter((s) => s.referrer);
  const mine = lc(ours);
  return {
    total, days, venues: venueList, shape, legs: [...legs.values()].sort((a, b) => b.swaps - a.swaps),
    pairs: [...pairs.values()].sort((a, b) => b.usd - a.usd || b.swaps - a.swaps),
    bought: [...bought.values()].sort((a, b) => b.usd - a.usd || b.buys - a.buys),
    traders: [...traders.values()].sort((a, b) => b.usd - a.usd || b.swaps - a.swaps),
    referrers, referred: { swaps: referred.length, usd: sum(referred, (s) => s.usd), share: swaps.length ? referred.length / swaps.length : 0 },
    ours: refs.get(mine) || { address: mine, swaps: 0, usd: 0, usd7d: 0, wallets: 0, earned: 0 },
    feeEstimate: total.usdAll * (FEE_BPS / 10000),
  };
}

export function toCsv(swaps) {
  const head = ["time_utc", "tx", "block", "trader", "sender", "referrer", "token_in", "token_out", "amount_in", "amount_out", "usd", "price_source", "route", "mid"];
  const q = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = swaps.map((s) => [new Date(s.time * 1000).toISOString(), s.hash, s.block, s.trader, s.sender, s.referrer || "", s.symIn, s.symOut, s.amountIn, s.amountOut, s.usd == null ? "" : s.usd.toFixed(6), s.source || "", s.route.join(">"), s.mid || ""]);
  return [head, ...rows].map((r) => r.map(q).join(",")).join("\n") + "\n";
}

/** Parse a decimal string like "0.01" into wei (BigInt) without floating point. Returns null when invalid. */
export function parseUnits(str, decimals = 18) {
  const m = /^\s*(\d*)(?:\.(\d*))?\s*$/.exec(String(str));
  if (!m || (m[1] === "" && (m[2] === undefined || m[2] === ""))) return null;
  const frac = (m[2] || "").padEnd(decimals, "0").slice(0, decimals);
  return BigInt((m[1] || "0") + frac);
}
