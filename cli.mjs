#!/usr/bin/env node
// node cli.mjs [--out data/stats.json] [--rpc URL] [--compare]
// Reads every Routed event from the StoaRouter, prints the same numbers the dashboard shows,
// optionally writes the snapshot the page loads first, and optionally compares with stoadex.com/api/stats.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { makeRpc, sync, emptyState, snapshotOf, stateFromSnapshot, PUBLIC_RPC } from "./src/chain.js";
import { priceSwaps, aggregate, short } from "./src/core.js";

const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
const flag = (k) => process.argv.includes(k);
const out = arg("--out"), rpcUrl = arg("--rpc") || PUBLIC_RPC;
const usd = (n) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 });

let state = emptyState();
if (out) { try { state = stateFromSnapshot(JSON.parse(readFileSync(out, "utf8"))); } catch { /* first run */ } }
await sync(makeRpc(rpcUrl), state, (s) => console.error("·", s));

const swaps = priceSwaps(state.raw, state);
const a = aggregate(swaps);
console.log(`\nStoaRouter on Robinhood Chain, head block ${state.head}`);
console.log(`swaps ${a.total.swaps}   volume ${usd(a.total.usdAll)}   24h ${usd(a.total.usd24h)}   traders ${a.total.traders}   unpriced ${a.total.unpriced}   ETH ${usd(state.gasUsd)}`);
console.log("\nvenues:");
for (const v of a.venues) console.log(`  ${v.name.padEnd(14)} ${String(v.swaps).padStart(4)} swaps  ${usd(v.usd).padStart(12)}`);
console.log(`\nreferred swaps ${a.referred.swaps} (${usd(a.referred.usd)}); ours ${a.ours.swaps} swaps, ${a.ours.wallets} wallets this month`);

if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(snapshotOf(state)) + "\n");
  console.log("\nsnapshot written to", out);
}
if (flag("--compare")) {
  try {
    const j = await (await fetch("https://stoadex.com/api/stats", { headers: { "user-agent": "stoa-rhc-dashboard-verify" } })).json();
    const rh = (j.chains || []).find((c) => c.key === "robinhood") || {};
    const dSwaps = a.total.swaps - rh.swaps, dUsd = a.total.usdAll - rh.usdAll;
    console.log(`\nstoadex.com/api/stats  swaps ${rh.swaps}  volume ${usd(rh.usdAll || 0)}`);
    console.log(`difference             swaps ${dSwaps >= 0 ? "+" : ""}${dSwaps}  volume ${dUsd >= 0 ? "+" : ""}${usd(dUsd)}  (new swaps since their 5-minute cache explain small gaps)`);
  } catch (e) { console.log("\ncompare skipped:", e.message); }
}
