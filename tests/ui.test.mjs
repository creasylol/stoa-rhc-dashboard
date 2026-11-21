// Renders the real index.html in jsdom against a mocked chain and checks what a visitor would see.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { ROUTED_TOPIC, ROUTER, USDG, NATIVE, WETH, REFERRER } from "../src/core.js";

const pad = (a) => a.replace("0x", "").toLowerCase().padStart(64, "0");
const num = (n) => BigInt(n).toString(16).padStart(64, "0");
const V3 = "0x28802Ad6F9859d14dfC6226eA9A8b60686D3A2E6", V4 = "0x27958279F95225b2a5517E7DD12b6Fc0317E5c5d", TKN = "0x00000000000000000000000000000000000000aa";
const NOW = Math.floor(Date.now() / 1000);
const mkLog = (i, o) => ({ address: ROUTER, topics: [ROUTED_TOPIC, "0x" + pad("0x" + String(i + 1).repeat(40).slice(0, 40)), "0x" + pad("0x" + String(i + 3).repeat(40).slice(0, 40)), "0x" + pad(o.ref || NATIVE)],
  data: "0x" + pad(o.tIn) + pad(o.tOut) + num(o.aIn) + num(o.aOut) + pad(o.mid || NATIVE) + pad(o.v1) + pad(o.v2 || NATIVE),
  transactionHash: "0x" + String(i + 1).repeat(64).slice(0, 64), blockNumber: "0x" + (119_000_000 + i * 1000).toString(16), logIndex: "0x0", blockTimestamp: "0x" + (NOW - i * 3600).toString(16) });
const LOGS = [
  mkLog(0, { tIn: NATIVE, tOut: USDG, aIn: 10n ** 16n, aOut: 18_000_000n, v1: V3, ref: REFERRER }),
  mkLog(1, { tIn: USDG, tOut: TKN, aIn: 50_000_000n, aOut: 10n ** 20n, v1: V4, v2: V3, mid: WETH }),
  mkLog(2, { tIn: USDG, tOut: TKN, aIn: 5_000_000n, aOut: 10n ** 19n, v1: V4 }),
];
const str = (s) => "0x" + (32).toString(16).padStart(64, "0") + s.length.toString(16).padStart(64, "0") + Buffer.from(s).toString("hex").padEnd(64, "0");

function rpcAnswer(c) {
  switch (c.method) {
    case "eth_blockNumber": return "0x" + (119_010_000).toString(16);
    case "eth_getLogs": return LOGS;
    case "eth_getBlockByNumber": return { timestamp: "0x" + NOW.toString(16) };
    case "eth_call": {
      const d = c.params[0].data;
      if (d.startsWith("0x95d89b41")) return str("TKN");
      if (d.startsWith("0x313ce567")) return "0x" + num(18);
      if (d.startsWith("0xb6466384")) return "0x" + num(18_000_000n) + "0".repeat(64 * 6);
    }
  }
  return null;
}

test("page renders live numbers from a mocked chain", async () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
  const dom = new JSDOM(html, { url: "https://creasylol.github.io/stoa-rhc-dashboard/" });
  Object.assign(globalThis, { document: dom.window.document, window: dom.window, location: dom.window.location, localStorage: dom.window.localStorage, Blob: dom.window.Blob, __STOA_NO_AUTO: true, __STOA_NO_POLL: true });
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("data/stats.json")) return { ok: false, json: async () => null };
    if (u.includes("rpc.mainnet")) {
      const body = JSON.parse(opts.body), one = (c) => ({ jsonrpc: "2.0", id: c.id, result: rpcAnswer(c) });
      return { ok: true, json: async () => (Array.isArray(body) ? body.map(one) : one(body)) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const app = await import("../src/app.js");
  await app.init();
  const doc = dom.window.document;
  assert.match(doc.getElementById("status-text").textContent, /^Live, block 119,010,000/);
  const kpis = doc.getElementById("kpis").textContent;
  assert.match(kpis, /Total volume\$73/);           // 18 + 50 + 5 USDG
  assert.match(kpis, /3 swaps/);
  assert.ok(doc.querySelectorAll("#chart .col").length >= 1);
  assert.match(doc.getElementById("venues").textContent, /Uniswap V3/);
  assert.match(doc.getElementById("venues").textContent, /Uniswap V4/);
  assert.match(doc.getElementById("shape").textContent, /2 direct/); assert.match(doc.getElementById("shape").textContent, /1 two-hop/);
  assert.equal(doc.querySelectorAll("#swaps-table tbody tr.clickable").length, 3);
  assert.match(doc.getElementById("referrers").textContent, /this dashboard/);
  assert.match(doc.getElementById("ours").textContent, /1 referred swap/);
  // interactions
  const row = doc.querySelector("#swaps-table tr.clickable"); row.click();
  assert.equal(doc.querySelectorAll("#swaps-table tr.detail").length, 1);
  const q = doc.getElementById("q"); q.value = "TKN"; q.dispatchEvent(new dom.window.Event("input"));
  assert.equal(doc.querySelectorAll("#swaps-table tbody tr.clickable").length, 2);
  const sel = doc.getElementById("f-ref"); sel.value = "ours"; sel.dispatchEvent(new dom.window.Event("change"));
  assert.match(doc.getElementById("swaps-table").textContent, /No swaps match/);
  doc.querySelector('[data-metric="swaps"]').click();
  assert.match(doc.querySelector("#chart svg").getAttribute("aria-label"), /swap count/);
  assert.ok(doc.getElementById("q-token").options.length >= 2);
});
