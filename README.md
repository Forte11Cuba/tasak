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

Requirements: Node.js ≥ 18 (only to generate `web/config.js`, no dependencies) and any static web server.

```sh
cp .env.example .env            # set your node, relays, currency and community (the example is Kmbalache)
node build.mjs                  # generates web/config.js and copies shared/ into web/shared/
python3 -m http.server -d web   # or any static server; open http://localhost:8000
```

The folder to publish is `web/` (after running `node build.mjs`): everything the site needs is in it.
It needs a web server, also to try it locally: opened as a file (`file://`) browsers don't load its
ES modules and the page shows a warning instead.

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
| `ARCHIVE_DIR` | Folder for the archiver's data (optional; default `indexer/data/`, see [Archiver](#archiver)) |

Each currency's payment methods come from the Mostro app's list; anything not on it is grouped as
«Otros» (other). In `HIDDEN_PAYMENT_METHODS` add the ones that trade at a different rate in your market
(in the Cuba example, «Saldo móvil»).

The node information (name, description, website, fee, amounts, version, Lightning node, relays) is read
from its own Nostr events (kind 0, 38385 and 10002). It has its own page, `node.html`, reached with the
«Mostro node» button or by clicking the node name in the currency bar (it keeps the URL parameters). The
community and social links are only shown for the nodes in `.env`.

Any visitor can view another node without deploying anything, overriding `.env` from the URL:

```
index.html?mostro=npub1…,npub1…&relays=wss://relay.mostro.network,wss://nos.lol&fiat=VES&lang=en
```

## Tasa K

Volume-weighted price of the orders completed in the last 24 hours:

```
Tasa K = Σ(price × amount) ÷ Σ amount
```

Example (in CUP): 3 orders at 785 CUP/USD totalling 3,000 CUP and one at 750 for 5,000 CUP →
(785×3000 + 750×5000) ÷ 8000 = **763.13**.

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
| Nostr relays | the orders | no data without them (one responding is enough) |
| Yadio | current BTC/USD, the currency's USD reference, market-price order book | currency/USD can't be calculated; currency/BTC and currency/sat keep working |
| Coinbase | hourly historical BTC/USD, for currency/USD | it's calculated with Yadio's current BTC/USD and marked as approximate |

## Archiver

Relays keep orders for about 15 days and only their latest version: once an order is completed, the
`pending` version (market or fixed price) and the `in-progress` one (when it was taken) are gone. The
node's `mostro-rates` (BTC price in every currency, from Yadio) expire after 10 minutes. To keep a full
history, `indexer/archiver.mjs` subscribes to the `.env` relays and stores everything the node
publishes, verified (signature and author), in daily files:

- `indexer/data/eventos/YYYY-MM-DD.jsonl`: orders of every currency (one line per relay that had it, to
  check which relay had what), each `mostro-rates` once, and the node's metadata when it changes.
- `indexer/data/yadio/YYYY-MM-DD.jsonl`: Yadio's BTC/USD every 5 minutes for the last 24 h, to fill the
  gaps when the archiver was off.

It needs Node.js ≥ 22 (native WebSocket), no dependencies, and must run all the time: whatever happens
while it is off is lost, except the latest version of each order. Around 1 MB per day.

```sh
node indexer/archiver.mjs
```

To run it as a service that starts by itself, see `indexer/tasak-archiver.service`. Two archivers on
different machines can be merged later (events are deduplicated by id). These files will feed the
future indexer.

The history from before the archiver can be recovered by the node's operator from the Mostro
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
| `shared/` | pure logic of the rate (ES modules: payment methods, orders, time zones and periods, units, Tasa K and candles), used by the pages (`build.mjs` copies it to `web/shared/`) |
| `shared/test/` | tests of `shared/` (`node --test 'shared/test/*.test.js'`, Node ≥ 22), fixed real data (`fixtures/`), the reference values the code must reproduce (`expected.json`) and hand-written cases (`cases.json`) |
| `build.mjs` | reads `.env`, generates `web/config.js` and copies `shared/` into `web/shared/` |
| `indexer/` | the event archiver, its systemd service and the Mostro database exporter |
| `tools/` | development checks in headless Chrome (Node, no dependencies); `node tools/reference.mjs` checks that `web/` computes the values in `shared/test/expected.json` from fixed data |

## Languages

The page is in Spanish and English. The language is chosen in this order: `?lang=` in the URL, the
ES · EN switch (remembered in the browser), `LANGUAGE` in `.env` and, otherwise, the browser language.
The original texts are in Spanish; translations live in `web/i18n.js` (`EN`). Adding another language is
just another dictionary like it.

## License

[MIT](LICENSE). The third-party code in `web/vendor/` keeps its own licenses (see `web/vendor/README.md`).
