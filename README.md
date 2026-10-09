# tasaK

**English** · [Español](README.es.md)

Exchange rate of a local currency calculated from completed orders on one or more Mostro nodes.
It works for any node and currency; the example configuration is Kmbalache 🇨🇺 (CUP).

## Why tasaK

Many reference rates are calculated from **ads or buy/sell intentions**: what someone says they would
pay, not what was actually paid. tasaK starts from the opposite:

- **Only completed orders.** The rate is the volume-weighted price of the trades that were actually
  executed in the last 24 hours, not of published offers.
- **Verifiable by anyone.** Each order is an event signed by the Mostro node and published on Nostr.
  The page checks the signatures, and anyone can read the same events from the relays and recompute
  the same rate. Clicking an order shows its original event.
- **Price, volume and orders in plain sight.** Besides the rate you see the traded volume, every
  executed order, the order book with open orders and the market reference to compare with.
- **No middleman.** The data comes straight from the relays; the page doesn't depend on its own server
  or on a database you have to trust.
- **Any node.** Any community can point it at its own Mostro node and currency.

## Setup

Requirements: Rust (`cargo`), to build `tasak`, the program that reads `.env`, generates
`web/config.js`, copies `shared/` into `web/shared/` and serves the site.

```sh
cp .env.example .env            # set your node, relays, currency and community (the example is Kmbalache)
cargo install --path server --locked   # builds tasak and installs it in ~/.cargo/bin (on PATH with rustup)
tasak                           # from the repository folder (or --root DIR): generates and serves
                                # web/ at http://localhost:8765/ (LISTEN to change it)
tasak build                     # only generates web/config.js and web/shared/
```

Run `cargo install` again after updating the repository. Without installing it, `cargo build --release
--manifest-path server/Cargo.toml` leaves the program in `server/target/release/tasak`.

The site needs a web server, also to try it locally: opened as a file (`file://`) browsers don't load
its ES modules and the page shows a warning instead. `tasak` generates the files when it starts: run it
again after changing `.env` or `shared/`. Two ways to publish it:

- **With the tasaK server:** run `tasak` all the time and put a web server with HTTPS (nginx, Caddy…)
  in front of it. It only serves files (GET and HEAD, nothing that receives data) and listens on
  `127.0.0.1:8765` by default (`LISTEN`). It also archives the node's events (see [Archive](#archive));
  later it will publish the Tasa K.
- **As a static site:** run `tasak build` and publish the `web/` folder, which has everything the site
  needs, with any static web server or hosting. On GitHub Pages, publish `web/` with a GitHub Actions
  workflow that builds `tasak` and runs `tasak build` first: Pages can only publish the root or `/docs`
  of a branch, and `web/config.js` isn't in the repository.

`.env` variables:

| Variable | What it is |
|---|---|
| `SITE_NAME` | Site name: logo, browser tab and icon (default `tasaK`; if it ends in capitals, that part is highlighted) |
| `RATE_NAME` | Name of the rate across the page (default `Tasa K`) |
| `LOGO` | Site logo: file in `web/`, next to `index.html` (svg, png, jpg, webp), or https link. Empty = the name as text |
| `LOGO_LIGHT` | Logo for the light theme (optional; if missing, `LOGO` is used) |
| `THEME` | Default theme, `light` or `dark` (empty = the system theme). Visitors can switch it with ☀ / ☾ |
| `LANGUAGE` | Default language, `es` or `en` (empty = the browser language). Visitors can switch it with ES · EN |
| `MOSTRO_PUBKEYS` | Nodes to show, in hex or npub, comma separated (required) |
| `RELAYS` | Relays to connect to, comma separated (required; `wss://`) |
| `FIAT` | Currency shown on load (empty = the most traded one on the node) |
| `TIMEZONE` | Time zone for dates and candles, e.g. `America/Caracas` (empty = the browser's) |
| `HIDDEN_PAYMENT_METHODS` | Payment methods that don't count by default, comma separated (default `Pruebas,Otros`) |
| `COMMUNITY`, `COMMUNITY_URL` | Community running the node (optional) |
| `SOCIAL_LINKS` | Links to its social media, comma separated (optional; Telegram, X, YouTube, GitHub and Nostr are recognised automatically) |
| `ARCHIVE_DIR` | Folder of the archive's database (optional; default `data/`, relative to the repository folder; see [Archive](#archive)) |
| `ARCHIVE` | `false` serves the site without archiving (optional; default `true`) |
| `LISTEN` | Address the tasaK server (`tasak`) listens on (optional; default `127.0.0.1:8765`) |

Each currency's payment methods come from the Mostro app's list; anything not on it is grouped as
«Otros» (other). In `HIDDEN_PAYMENT_METHODS` add the ones that trade at a different rate in your market
or are used by mistake (in the Cuba example, «Saldo móvil» and «Tarjeta Clásica»), with their full name as
in the app's list.

The node information (name, description, website, fee, amounts, version, Lightning node, relays) is read
from its own Nostr events (kind 0, 38385 and 10002). It has its own page, `node.html`, reached with the
«Mostro node» button or by clicking the node name in the currency bar (it keeps the URL parameters). The
community and social links are only shown for the nodes in `.env`.

Any visitor can view another node without deploying anything, overriding `.env` from the URL:

```
index.html?mostro=npub1…,npub1…&relays=wss://relay.mostro.network,wss://nos.lol&fiat=VES&lang=en
```

If the URL changes the node and has no `fiat`, the `.env` currency doesn't apply: the page picks the most traded one on that node.

## Tasa K

Volume-weighted price of the orders completed in the last 24 hours:

```
Tasa K = Σ(price × amount) ÷ Σ amount
```

Example (in CUP): 3 orders at 785 CUP/USD totalling 3,000 CUP and one at 750 for 5,000 CUP →
(785×3000 + 750×5000) ÷ 8000 = **763.13**.

### What it measures

The price at which the currency is actually exchanged in bitcoin trades. In currency/USD it is an implied
rate: currency paid per BTC divided by BTC/USD. It is not the price of cash dollars or transfers: if
buying or selling bitcoin with the currency carries a premium of its own, it is in the Tasa K too.
Currency/BTC and currency/sat don't go through the dollar.

Almost all orders are at market price: the node sets the sats from its reference price and the order's
premium, so their price is roughly `reference ÷ (1 − premium)`. The Tasa K therefore follows that
reference, and its distance from it («above Yadio» in the header) is mostly the premiums people trade at.
Fixed-price orders don't depend on it.

### Which orders count

The Tasa K always follows the same rules, so every visitor sees the same figure:

- **They count**: orders completed (`success`) in the last 24 hours, in the chosen currency, from the
  nodes in `.env`, with the node's signature verified.
- **They don't count**: orders never completed (open, taken, canceled, expired, in dispute); those with
  a payment method in `HIDDEN_PAYMENT_METHODS` (with «Otros», text not on the Mostro app's list, and
  «Pruebas», test orders: «prueba», «test», «no tomar»); and those without an amount in currency and in
  sats greater than zero.
- No price is discarded as an outlier, and market-price and fixed-price orders both count.

Visitors can choose other payment methods or nodes: the chart and the tables follow their choice, and
**Your selection** shows its weighted price of the last 24 hours next to the filters. The Tasa K in the
header doesn't change.

### The node's reference

Since Mostro 0.19 each node chooses its price sources (Yadio, CoinGecko, Blockchain.com, currency-api,
local-market sources or other nodes over Nostr), combines them and publishes the result, signed, in its
`mostro-rates` event with the sources in the `source` tag; it prices market orders with that same value.
The header says «Yadio reference» when the node uses Yadio alone and «Node reference» otherwise, with the
sources on hover. In the order book each market order is priced with its own node's prices, which the node
keeps using for up to 30 minutes when it can't refresh them; without them, the price is estimated with
Yadio's API and marked «≈», and with neither the order is shown without a price («—»).

BTC buys and sells close at different prices, since each side sets its premium; the Tasa K weighs them all
together. For information only, without changing the rate, hovering over the Tasa K and the FAQ show the
weighted price of buys and of sells in the last 24 hours, and how many orders were at market price (with
their average premium) or at fixed price. Market or fixed comes from the order's `pending` version or,
without it, from a premium other than 0 (Mostro doesn't allow a premium with a fixed price); orders with
premium 0 whose `pending` version wasn't seen are counted as unknown.

The chart has three modes:

- **Price**: one point per executed order, or per period (1h, 4h, 1D, 1W, 1M, 1Y) with that period's weighted price.
- **Candles**: open, high, low and close of each period.
- **Weighted**: at each point, the volume-weighted price of the previous 24 hours, `Σ(price × amount) ÷ Σ amount` (after each order, or at the close of each period). It is the Tasa K over time.

Volume is shown at the bottom of the chart and, when hovering, the legend at the top shows that point's
values. The chart can be zoomed and scrolled (the zoom is kept when new orders arrive; double-click to see
everything again) and can go full screen. The payment method filter is in the «Payment method» menu.

The methods in `HIDDEN_PAYMENT_METHODS` are left out by default; they can be enabled from that menu.

## Working when services are blocked

Designed for countries or networks where some services are blocked. The page doesn't depend on any CDN:
the libraries are copied into `web/vendor/` (lightweight-charts 5.2.1 and nostr-tools 2.25.2), about 105 KB
compressed.

External services it uses and what happens if they are blocked:

| Service | Used for | If blocked |
|---|---|---|
| Nostr relays | the orders, and the current prices the node publishes (`mostro-rates`: BTC/USD, the currency's USD reference, market-price order book) | no data without them (one responding is enough) |
| Yadio | only if a node doesn't publish valid `mostro-rates`: an estimate of the current prices | currency/USD can't be calculated; currency/BTC and currency/sat keep working |
| Coinbase | hourly historical BTC/USD, for currency/USD | it's calculated with the current BTC/USD (the node's or Yadio's) and marked as approximate |

## Archive

Relays keep orders for about 15 days and only their latest version: once an order is completed, the
`pending` version (market or fixed price) and the `in-progress` one (when it was taken) are gone. The
node's `mostro-rates` (BTC price in every currency, from its price sources) expire after 10 minutes. To keep a full
history, the tasaK server (`tasak`) subscribes to the `.env` relays and stores everything the node
publishes, verified (signature, author and kind), in a SQLite database, `data/tasak.sqlite`
(`ARCHIVE_DIR` to change the folder):

- `events`: every signed event as received: orders of every currency and every version, each
  `mostro-rates`, and the node's metadata when it changes. Anyone can verify them again.
- `event_relays`: which relays sent each event and when, to check which relay had what.
- `yadio`: Yadio's BTC/USD every 5 minutes for the last 24 h, to fill the gaps when the archive was off.

It must run all the time: whatever happens while it is off is lost, except the latest version of each
order. Each relay has a live subscription and, every 5 minutes, a catch-up of its recent history that
covers disconnections. Around 1 MB per day. `ARCHIVE=false` serves the site without archiving.

To run it as a service that starts by itself, see `server/tasak.service`. The daily files of the old
JavaScript archiver (`{"relay", "recibido", "evento"}` lines) can be imported; importing twice changes
nothing:

```sh
tasak import-jsonl indexer/data/eventos/*.jsonl indexer/data/yadio/*.jsonl
```

The history from before the archive can be recovered by the node's operator from the Mostro
database. On a copy (`sqlite3 mostro.db ".backup mostro-copy.db"`), run:

```sh
node indexer/export-mostro.mjs mostro-copy.db
```

It needs Node.js ≥ 22.13 and writes the executed orders to `indexer/data/mostro-db/`. It exports only
public trade data (currency, amounts, premium, payment methods, times, market or fixed price), never
keys, invoices or the users table. Those orders are unsigned: an order counts as confirmed when its
signed Nostr event is also archived.

## Files

| File | What it is |
|---|---|
| `web/` | the site, the folder to publish |
| `web/index.html` | the rate: chart, order book and executed orders |
| `web/node.html` | Mostro node information |
| `web/js/` | the pages' modules: relay client (`nostr-client.js`) and event store (`event-store.js`) shared by both pages, chart, panels, prices and state |
| `web/css/` | styles of each page |
| `web/i18n.js` | language (Spanish / English): dictionary and text translation |
| `web/common.js`, `web/common.css` | configuration, formatting, colours and node card, shared by both pages |
| `web/vendor/` | copied libraries (no CDN) and the Mostro app's payment methods per currency (`mostro-payment-methods.js`) |
| `shared/` | pure logic of the rate (ES modules: payment methods, orders, the node's prices (`mostro-rates`), time zones and periods, units, Tasa K and candles), used by the pages (`tasak` copies it to `web/shared/`) |
| `shared/test/` | tests of `shared/` (`node --test 'shared/test/*.test.js'`, Node ≥ 22), fixed real data (`fixtures/`), the reference values the code must reproduce (`expected.json`) and hand-written cases (`cases.json`): the vectors that the Rust version of this logic (`server/src/logic/`) passes too |
| `server/` | the tasaK server in Rust (`tasak`): reads `.env`, generates `web/config.js`, serves `web/` and archives the node's events; its systemd service is `server/tasak.service`. `src/logic/` is the logic of `shared/` in Rust, checked with the same vectors (`server/tests/shared_vectors.rs`); `server/tests/config-cases.json` is the `web/config.js` each `.env` must give (`cargo test`) |
| `indexer/` | the Mostro database exporter (`export-mostro.mjs`; it will move to `tasak`) |
| `tools/` | development checks in headless Chrome (Node, no dependencies); `node tools/reference.mjs` checks that `web/` computes the values in `shared/test/expected.json` from fixed data |

## Languages

The page is in Spanish and English. The language is chosen in this order: `?lang=` in the URL, the
ES · EN switch (remembered in the browser), `LANGUAGE` in `.env` and, otherwise, the browser language.
The original texts are in Spanish; translations live in `web/i18n.js` (`EN`). Adding another language is
just another dictionary like it.

## License

[MIT](LICENSE). The third-party code in `web/vendor/` keeps its own licenses (see `web/vendor/README.md`).
