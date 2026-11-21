# Stoa Ledger

Live dashboard for every swap routed through the [Stoa](https://stoadex.com) router on Robinhood Chain (chain 4663).

**Live:** https://creasylol.github.io/stoa-rhc-dashboard/

It reads the router’s `Routed` events straight from the chain’s public RPC and counts them the way Stoa’s own [/stats](https://stoadex.com/stats) page does, so the totals can be checked against it.

## What it shows

- Headline numbers: total, 24 hour and 7 day volume, traders, referred share, fee estimate.
- A colonnade chart of volume or swaps per UTC day, over 14 days, 30 days or all time.
- Routing: share of swaps per venue, direct against two-hop, and the most common two-hop paths.
- Top traders, most bought tokens, and the referrer board with each referrer’s distinct wallets this month (the integrator-bonus test).
- Every swap in a searchable, sortable, filterable table with a per-swap route breakdown and CSV export.
- A quote box on Stoa’s public API. Every quote and swap names `0x1F0AE5e17084857C7D4Ef289C15fC5d043087019` as `referrer`. The page refuses to send a transaction that doesn’t go to the router, is for another chain, or doesn’t carry that referrer. Only ETH sells can be sent from the page, so no approvals are involved.

## How it works

| File | Job |
| --- | --- |
| `src/core.js` | Pure logic: decode `Routed` logs, price swaps, aggregate everything. No network, no DOM. |
| `src/chain.js` | JSON-RPC client with batching and retries, incremental sync that re-reads the last 25 blocks to survive reorgs. |
| `src/app.js` | The page: state, polling every 60 seconds, rendering, the quote and swap flow. |
| `cli.mjs` | Same pipeline in Node. Prints the numbers, writes the snapshot, compares with Stoa’s API. |
| `data/stats.json` | Snapshot refreshed every 30 minutes by `.github/workflows/snapshot.yml`. The page paints from it instantly, then catches up from the chain. |
| `tests/` | Decoder, pricing and aggregation tests, plus the real page rendered in jsdom against a mocked chain. |

Counting rules: one `Routed` event is one settled swap (a failed swap reverts and emits nothing). Each swap is valued once: on its USDG side, else on its ETH side at the router’s own quote for 0.01 ETH, else at DexScreener’s current price. A swap counts once for every distinct venue it touched. The fee estimate is 2 bps of volume and a referrer’s share is 10% of that.

## Run it

The page uses ES modules, so serve it over HTTP rather than opening the file:

```
python3 -m http.server 8000
```

```
npm install          # only for the jsdom test
npm test
node cli.mjs --compare              # read the chain, compare with stoadex.com/api/stats
node cli.mjs --out data/stats.json  # refresh the snapshot by hand
```

Use `?rpc=https://your-node` in the page URL to read through a different RPC.

## Make it yours

Edit `REFERRER` in `src/core.js` to change the referrer address. Nothing else is hardcoded to one person.

## Limits

- ETH volume uses today’s price for every day, so older ETH-sided days are approximate.
- Fee and referral figures are estimates from volume, not FeeDistributor balances.
- Independent community project, not run or endorsed by Stoa.

MIT licensed.
