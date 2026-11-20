# Stoa on Robinhood Chain: Public Analytics Dashboard

Open-source public dashboard for swaps through the StoaRouter on Robinhood Chain (chain ID 4663).

- StoaRouter: 0x2F2804fad735a38015650f32f95Ad5E08D6B3eE5 (from https://stoadex.com/docs/contracts)
- Referrer: 0x1F0AE5e17084857C7D4Ef289C15fC5d043087019 (set in every quote request and swap link)
- Data source: Blockscout API (https://robinhoodchain.blockscout.com), account txlist for the router
- Quote API: https://stoadex.com/api/v1/quote

## Status
- Live feed, router transaction count, and unique sender count: implemented (v0), not yet verified against live Blockscout responses.
- Venue breakdown: NOT implemented yet. Requires decoding swap data per transaction.
- Volume in USD: NOT implemented yet.
- Known limitation: reads only the latest 100 router transactions.
- Swap link format is a placeholder and must be checked against the Stoa web app before submission.

## Run locally
Open index.html in a browser, or serve the folder with any static server.
