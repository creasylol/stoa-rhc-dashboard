// Reads the router's Routed events straight from Robinhood Chain's public RPC. Works in the browser and in Node 18+.
import { ROUTER, ROUTED_TOPIC, DEPLOY_BLOCK, NATIVE, USDG, lc, short, decodeRouted, unknownTokens, needsDex } from "./core.js";

export const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const LOG_SPAN = 9_000_000;   // the public RPC caps a getLogs query at 10M blocks
const REORG_BACK = 25;               // re-read this many blocks on every refresh so a reorg can't leave a stale swap

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => "0x" + n.toString(16);

export function makeRpc(url = PUBLIC_RPC, { timeoutMs = 20000, retries = 2 } = {}) {
  let id = 0;
  async function post(body) {
    let last;
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error("RPC answered " + res.status);
        return await res.json();
      } catch (e) { last = e; if (i < retries) await sleep(400 * (i + 1)); }
    }
    throw last;
  }
  async function call(method, params = []) {
    const j = await post({ jsonrpc: "2.0", id: ++id, method, params });
    if (j.error) throw new Error(method + ": " + (j.error.message || "RPC error"));
    return j.result;
  }
  // JSON-RPC batch in chunks; falls back to single calls if the node refuses batches
  async function batch(calls, chunk = 25) {
    const out = [];
    for (let i = 0; i < calls.length; i += chunk) {
      const part = calls.slice(i, i + chunk);
      let res;
      try {
        const j = await post(part.map((c, k) => ({ jsonrpc: "2.0", id: k, method: c.method, params: c.params })));
        if (!Array.isArray(j)) throw new Error("batch refused");
        res = part.map((_, k) => j.find((x) => x.id === k));
      } catch {
        res = await Promise.all(part.map((c) => call(c.method, c.params).then((result) => ({ result }), (error) => ({ error: { message: String(error.message) } }))));
      }
      out.push(...res);
    }
    return out;
  }
  return { url, call, batch };
}

export async function fetchLogs(rpc, from, to) {
  const logs = [];
  for (let a = from; a <= to; a += LOG_SPAN) {
    const b = Math.min(a + LOG_SPAN - 1, to);
    logs.push(...(await rpc.call("eth_getLogs", [{ address: ROUTER, topics: [ROUTED_TOPIC], fromBlock: hex(a), toBlock: hex(b) }])));
  }
  return logs.map(decodeRouted).filter(Boolean);
}

export async function fetchBlockTimes(rpc, blocks) {
  const out = {};
  const res = await rpc.batch(blocks.map((b) => ({ method: "eth_getBlockByNumber", params: [hex(b), false] })));
  res.forEach((r, i) => { if (r && r.result && r.result.timestamp) out[blocks[i]] = parseInt(r.result.timestamp, 16); });
  return out;
}

function decodeString(h) {
  if (!h || h === "0x") return null;
  try {
    const b = h.slice(2);
    if (b.length === 64) return Buffer_fromHex(b);                       // bytes32 symbol
    const len = parseInt(b.slice(64, 128), 16);
    return Buffer_fromHex(b.slice(128, 128 + len * 2));
  } catch { return null; }
}
function Buffer_fromHex(h) {
  const bytes = h.match(/../g) || [];
  return new TextDecoder().decode(Uint8Array.from(bytes.map((x) => parseInt(x, 16)))).replace(/\0/g, "");
}

export async function fetchTokenMeta(rpc, addrs) {
  const out = {};
  if (!addrs.length) return out;
  const calls = addrs.flatMap((a) => [
    { method: "eth_call", params: [{ to: a, data: "0x95d89b41" }, "latest"] },
    { method: "eth_call", params: [{ to: a, data: "0x313ce567" }, "latest"] },
  ]);
  const res = await rpc.batch(calls);
  addrs.forEach((a, i) => {
    const s = res[i * 2]?.result, d = res[i * 2 + 1]?.result;
    const symbol = (decodeString(s) || "TOKEN").replace(/[^\w.$-]/g, "").slice(0, 12) || "TOKEN";
    const decimals = d && d !== "0x" ? Number(BigInt(d)) : 18;
    out[a] = { symbol, decimals: Number.isFinite(decimals) ? decimals : 18 };
  });
  return out;
}

/** ETH price in USD from the router itself: its quote for selling 0.01 ETH into USDG. */
export async function fetchGasUsd(rpc) {
  try {
    const pad = (a) => a.slice(2).toLowerCase().padStart(64, "0");
    const amount = 10n ** 16n;
    const data = "0xb6466384" + pad(NATIVE) + pad(USDG) + amount.toString(16).padStart(64, "0");
    const r = await rpc.call("eth_call", [{ to: ROUTER, data }, "latest"]);
    const out = Number(BigInt("0x" + r.slice(2, 66))) / 1e6;     // USDG has 6 decimals
    return out > 0 ? out / 0.01 : 0;
  } catch { return 0; }
}

export async function fetchDexPrices(addrs) {
  const out = {};
  if (!addrs.length) return out;
  try {
    const r = await fetch("https://api.dexscreener.com/tokens/v1/robinhood/" + addrs.slice(0, 30).join(","), { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return out;
    const pairs = await r.json(), liq = {};
    for (const p of pairs) {
      const a = lc(p.baseToken?.address), usd = Number(p.priceUsd), l = p.liquidity?.usd ?? 0;
      if (usd > 0 && isFinite(usd) && addrs.includes(a) && (liq[a] ?? -1) < l) { liq[a] = l; out[a] = usd; }
    }
  } catch { /* leave unpriced */ }
  return out;
}

export const emptyState = () => ({ raw: [], lastBlock: 0, head: 0, times: {}, meta: {}, gasUsd: 0, dex: {}, updated: 0 });

/**
 * Bring `state` up to the chain head. Mutates and returns it.
 * Only new blocks are scanned after the first run; the last REORG_BACK blocks are always re-read.
 */
export async function sync(rpc, state, onStep = () => {}) {
  onStep("Reading the latest block");
  const head = parseInt(await rpc.call("eth_blockNumber"), 16);
  const from = state.lastBlock ? Math.max(DEPLOY_BLOCK, state.lastBlock - REORG_BACK) : DEPLOY_BLOCK;
  onStep(state.lastBlock ? "Checking new blocks" : "Reading every Routed event since launch");
  const fresh = await fetchLogs(rpc, from, head);
  const kept = state.raw.filter((r) => r.block < from);
  state.raw = [...kept, ...fresh].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  state.lastBlock = head; state.head = head;

  const missing = [...new Set(state.raw.filter((r) => !r.time && !state.times[r.block]).map((r) => r.block))];
  if (missing.length) { onStep("Reading block times"); Object.assign(state.times, await fetchBlockTimes(rpc, missing)); }

  const unknown = unknownTokens(state.raw, state.meta);
  if (unknown.length) { onStep("Reading token symbols"); Object.assign(state.meta, await fetchTokenMeta(rpc, unknown)); }

  onStep("Pricing");
  const g = await fetchGasUsd(rpc);
  if (g) state.gasUsd = g;
  const dexNeeded = needsDex(state.raw).filter((a) => !(a in state.dex));
  if (dexNeeded.length) Object.assign(state.dex, await fetchDexPrices(dexNeeded));
  state.updated = Math.floor(Date.now() / 1000);
  return state;
}

export const snapshotOf = (s) => ({ version: 1, chainId: 4663, router: ROUTER, updated: s.updated, head: s.head, lastBlock: s.lastBlock, gasUsd: s.gasUsd, times: s.times, meta: s.meta, dex: s.dex, raw: s.raw });
export function stateFromSnapshot(snap) {
  const s = emptyState();
  if (!snap || snap.version !== 1 || lc(snap.router) !== lc(ROUTER)) return s;
  return { ...s, raw: snap.raw || [], lastBlock: snap.lastBlock || 0, head: snap.head || 0, times: snap.times || {}, meta: snap.meta || {}, gasUsd: snap.gasUsd || 0, dex: snap.dex || {}, updated: snap.updated || 0 };
}
export { short };
