import test from "node:test";
import assert from "node:assert/strict";
import { decodeRouted, priceSwaps, aggregate, toCsv, parseUnits, ROUTED_TOPIC, USDG, WETH, NATIVE, REFERRER, ROUTER } from "../src/core.js";

const pad = (a) => a.replace("0x", "").toLowerCase().padStart(64, "0");
const num = (n) => BigInt(n).toString(16).padStart(64, "0");
const V3 = "0x28802Ad6F9859d14dfC6226eA9A8b60686D3A2E6", V4 = "0x27958279F95225b2a5517E7DD12b6Fc0317E5c5d";
const TOKEN = "0x00000000000000000000000000000000000000aa";
const ZERO = NATIVE;

function log({ hash = "0x" + "1".repeat(64), block = 100, idx = 0, sender = "0x" + "2".repeat(40), to = "0x" + "3".repeat(40), ref = ZERO, tIn, tOut, aIn, aOut, mid = ZERO, v1 = V3, v2 = ZERO, ts }) {
  return {
    address: ROUTER, topics: [ROUTED_TOPIC, "0x" + pad(sender), "0x" + pad(to), "0x" + pad(ref)],
    data: "0x" + pad(tIn) + pad(tOut) + num(aIn) + num(aOut) + pad(mid) + pad(v1) + pad(v2),
    transactionHash: hash, blockNumber: "0x" + block.toString(16), logIndex: "0x" + idx.toString(16), ...(ts ? { blockTimestamp: "0x" + ts.toString(16) } : {}),
  };
}

test("decodes a Routed log", () => {
  const d = decodeRouted(log({ tIn: NATIVE, tOut: USDG, aIn: 10n ** 16n, aOut: 18_000_000n, ref: REFERRER }));
  assert.equal(d.tokenIn, NATIVE); assert.equal(d.tokenOut.toLowerCase(), USDG.toLowerCase());
  assert.equal(d.amountIn, "10000000000000000"); assert.equal(d.amountOut, "18000000");
  assert.equal(d.referrer.toLowerCase(), REFERRER.toLowerCase()); assert.equal(d.block, 100);
});
test("ignores other events and short data", () => {
  assert.equal(decodeRouted({ topics: ["0xdead"], data: "0x" }), null);
  assert.equal(decodeRouted({ topics: [ROUTED_TOPIC, "0x0", "0x0", "0x0"], data: "0x00" }), null);
});

const meta = { [USDG.toLowerCase()]: { symbol: "USDG", decimals: 6 }, [TOKEN]: { symbol: "TKN", decimals: 18 }, [WETH.toLowerCase()]: { symbol: "WETH", decimals: 18 } };
const NOW = 1_800_000_000;
const mk = (o, time) => ({ ...decodeRouted(log(o)), time });

test("prices on the stablecoin side first, then ETH quote, then DexScreener, else null", () => {
  const raws = [
    mk({ tIn: USDG, tOut: TOKEN, aIn: 5_000_000n, aOut: 10n ** 18n }, NOW),
    mk({ hash: "0x" + "4".repeat(64), tIn: TOKEN, tOut: USDG, aIn: 10n ** 18n, aOut: 7_000_000n }, NOW),
    mk({ hash: "0x" + "5".repeat(64), tIn: NATIVE, tOut: TOKEN, aIn: 10n ** 16n, aOut: 10n ** 18n }, NOW),
    mk({ hash: "0x" + "6".repeat(64), tIn: TOKEN, tOut: "0x00000000000000000000000000000000000000bb", aIn: 10n ** 18n, aOut: 10n ** 18n }, NOW),
  ];
  const s = priceSwaps(raws, { meta, gasUsd: 1800, dex: {} });
  const by = Object.fromEntries(s.map((x) => [x.hash.slice(2, 4), x]));
  assert.equal(by["11"].usd, 5); assert.equal(by["44"].usd, 7);
  assert.equal(by["55"].usd, 18); assert.equal(by["55"].source, "ETH quote");
  assert.equal(by["66"].usd, null);
  assert.equal(priceSwaps(raws.slice(3), { meta, gasUsd: 0, dex: { [TOKEN]: 2 } })[0].usd, 2);
});

test("aggregates venues once per swap, shape, referrers and the wallet test", () => {
  const day = 86400;
  const raws = [
    mk({ hash: "0x" + "a".repeat(64), tIn: USDG, tOut: TOKEN, aIn: 10_000_000n, aOut: 1n, v1: V3 }, NOW),
    mk({ hash: "0x" + "b".repeat(64), tIn: USDG, tOut: TOKEN, aIn: 20_000_000n, aOut: 1n, v1: V3, v2: V4, mid: WETH, to: "0x" + "9".repeat(40), ref: REFERRER }, NOW - 100),
    mk({ hash: "0x" + "c".repeat(64), tIn: USDG, tOut: TOKEN, aIn: 30_000_000n, aOut: 1n, v1: V4, v2: V4, mid: WETH, ref: REFERRER }, NOW - 10 * day),
  ];
  const a = aggregate(priceSwaps(raws, { meta }), NOW);
  assert.equal(a.total.swaps, 3); assert.equal(a.total.usdAll, 60); assert.equal(a.total.usd24h, 30); assert.equal(a.total.usd7d, 30);
  const v = Object.fromEntries(a.venues.map((x) => [x.name, x]));
  assert.equal(v["Uniswap V3"].swaps, 2); assert.equal(v["Uniswap V4"].swaps, 2);   // V4→V4 counts once
  assert.equal(a.shape.direct, 1); assert.equal(a.shape.twoHop, 2);
  assert.equal(a.referred.swaps, 2); assert.equal(a.ours.swaps, 2); assert.equal(a.ours.usd, 50);
  assert.ok(Math.abs(a.ours.earned - 50 * 0.0002 * 0.1) < 1e-12);
  assert.equal(a.days.length, 11); assert.equal(a.days.at(-1).swaps, 2);
  assert.equal(a.total.traders, 2);
});

test("csv escapes and has one row per swap", () => {
  const s = priceSwaps([mk({ tIn: USDG, tOut: TOKEN, aIn: 1_000_000n, aOut: 1n }, NOW)], { meta });
  const lines = toCsv(s).trim().split("\n");
  assert.equal(lines.length, 2); assert.match(lines[1], /^2027|^20\d\d-/);
});
test("parseUnits is exact", () => {
  assert.equal(parseUnits("0.01"), 10n ** 16n); assert.equal(parseUnits("1"), 10n ** 18n);
  assert.equal(parseUnits(".5"), 5n * 10n ** 17n); assert.equal(parseUnits("abc"), null); assert.equal(parseUnits(""), null);
  assert.equal(parseUnits("0.1234567890123456789"), 123456789012345678n);
});
