# tasaK

**English** · [Español](README.es.md)

Exchange rate of a local currency calculated from completed orders on one or more Mostro nodes.
It works for any node and currency; the example configuration is Kmbalache 🇨🇺 (CUP).

## Why tasaK

Many reference rates are calculated from **ads or buy/sell intentions**: what someone says they would
pay, not what was actually paid. tasaK starts from the opposite:

- **Only completed orders.** The rate is the volume-weighted price of the trades that were actually
  executed in the 24 hours up to the last one, not of published offers.
- **Verifiable by anyone.** Each order is an event signed by the Mostro node and published on Nostr.
  The page checks the signatures, and anyone can read the same events from the relays and recompute
  the same rate. Clicking an order shows its original event.
- **Price, volume and orders in plain sight.** Besides the rate you see the traded volume, every
  executed order, the order book with open orders and the market reference to compare with.
- **With or without a server.** The site's server (optional) makes it faster and keeps the history the
  relays delete, but what it sends is checked the same way, and the page works without it.
- **Any node.** Any community can point it at its own Mostro node and currency.

## Step by step on a server

Your own tasaK with its archive and the signed Tasa K, on a Linux server with Docker, the published
image and Caddy for HTTPS. You need:

- a server (VPS) with Debian or Ubuntu, amd64 or arm64, with ports 80 and 443 open; a small one is enough;
- a domain or subdomain whose DNS you manage;
- the Mostro node's pubkey and relays (and, to recover its history, a copy of its database: only the
  node's operator has it).

The commands run on the server as root, unless they say otherwise. `tasa.example.org` is your domain
and `X.Y.Z` the latest [release](https://github.com/Forte11Cuba/tasak/releases).

**1. Point the domain at the server.** In your DNS provider, add an `A` record with the server's IPv4
(host `@` for the bare domain). Add `AAAA` only if the server has working IPv6: Let's Encrypt uses it
when it exists. Remove the registrar's parking or redirect records for that name. Each pair of lines must give
the same IP (the first column of `getent`):

```sh
getent ahostsv4 tasa.example.org | head -1; curl -4 ifconfig.me; echo   # the A record
getent ahostsv6 tasa.example.org | head -1; curl -6 ifconfig.me; echo   # the AAAA record, if you added it
```

If your users are in a country where services are blocked, check from there that the domain and the
server's IP open: the block can be the hosting provider's, not the domain's.

**2. Install Docker and git** (Docker Compose 2.24 or newer, which the official script installs):

```sh
apt update && apt install -y git curl sqlite3      # sqlite3, for the backups
curl -fsSL https://get.docker.com | sh
docker compose version
```

**3. Get tasaK and use the published image.** Your changes go in `docker-compose.override.yml`, which
Docker Compose merges with `docker-compose.yml`: the repository's files stay untouched and updating is
changing the version.

```sh
git clone --branch vX.Y.Z https://github.com/Forte11Cuba/tasak.git && cd tasak
cat > docker-compose.override.yml <<'EOF'
services:
  tasak:
    image: ghcr.io/forte11cuba/tasak:X.Y.Z   # the same version as the clone
    build: !reset null                       # don't build: use the published image
  caddy:
    environment:
      DOMAIN: tasa.example.org
EOF
docker compose pull tasak
```

**4. Configure your node.** `cp .env.example .env` and edit it: `MOSTRO_PUBKEYS`, `RELAYS`, `FIAT`,
`TIMEZONE`, `HIDDEN_PAYMENT_METHODS`, your community… (see the [variables](#docker)). Leave `ARCHIVE_DIR`,
`LISTEN` and `SIGNING_KEY_FILE` empty: Docker sets them. The image carries the repository's `web/`; for
your own logo, put the file next to `docker-compose.yml`, mount it under `tasak:` in the override and
set `LOGO=my-logo.svg`:

```yaml
    volumes:
      - ./my-logo.svg:/app/web/my-logo.svg:ro
```

**5. Create the signing key** (to publish the signed Tasa K; without it, the site and the archive work the
same). Generated on the server, for this only (not the node's key, not a personal one):

```sh
mkdir -m 700 secrets
docker compose run --rm --no-deps --user root -v "$PWD/secrets:/secrets" tasak keygen /secrets/nsec
docker compose run --rm --no-deps --user root -v "$PWD/secrets:/secrets" --entrypoint chown tasak 10001:10001 /secrets/nsec
```

It shows the key's npub: that is what you share. The nsec never goes in a chat nor in the repository.
Then give it to `tasak` in the override, which ends up like this:

```yaml
services:
  tasak:
    image: ghcr.io/forte11cuba/tasak:X.Y.Z
    build: !reset null
    environment:
      SIGNING_KEY_FILE: /run/secrets/tasak-key
    secrets:
      - tasak-key
  caddy:
    environment:
      DOMAIN: tasa.example.org

secrets:
  tasak-key:
    file: ./secrets/nsec
```

Keep a copy of `secrets/nsec` off the server, somewhere encrypted (from your computer, `scp
root@SERVER:tasak/secrets/nsec .`): without it, a new key means a new npub.

**6. Import the node's history** (optional, only for the node's operator; before the first start). The
relays only keep about 15 days; the Mostro database has everything (see [Archive](#archive)). On the
node's machine, make a copy and send it straight to the server (it has private data: not through git or
a chat):

```sh
sqlite3 /path/to/mostro.db ".backup /tmp/mostro-copy.db"
scp /tmp/mostro-copy.db root@SERVER:/root/mostro-copy.db
```

On the server, import it and delete the copy:

```sh
docker compose run --rm -v /root/mostro-copy.db:/import/mostro.db:ro tasak import-mostro /import/mostro.db
rm /root/mostro-copy.db
```

**7. Start.** If the provider has a firewall in its panel, open ports 80 and 443 (TCP).

```sh
docker compose --profile https up -d
docker compose logs tasak | grep npub                       # signing the Tasa K as npub1…
docker compose logs caddy | grep "certificate obtained"     # the HTTPS certificate
```

**8. Check.** Open `https://tasa.example.org`. `https://tasa.example.org/api/tasa.json` gives the Tasa K
and, in `event`, the id of the signed event, published every 5 minutes on the `.env` relays: look it up
in `https://nostrinspect.com/e/` followed by that id: it must be signed by your npub.

**9. Back up** the archive (it is the history the relays forget) and the key. `.backup` is safe while
`tasak` runs; copying the file isn't. The volume is called `tasak_tasak-data` with the repository in a
folder named `tasak`:

```sh
sqlite3 "$(docker volume inspect -f '{{.Mountpoint}}' tasak_tasak-data)/tasak.sqlite" ".backup /root/tasak-backup.sqlite"
```

Copy it off the server, for example every day with cron.

**10. Day to day.** After changing `.env`: `docker compose restart tasak`. Logs: `docker compose logs -f
tasak`. To update to a new version:

```sh
git fetch --tags && git checkout vX.Y.Z          # the new one
# change the version in docker-compose.override.yml (image:)
docker compose pull tasak && docker compose --profile https up -d
```

## Setup

Requirements: Rust (`cargo`), to build `tasak`, the program that reads `.env`, generates
`web/config.js`, copies `shared/` into `web/shared/` and serves the site.

```sh
cp .env.example .env            # set your node, relays, currency and community (the example is Kmbalache)
cargo install --path server --locked   # builds tasak and installs it in ~/.cargo/bin (on PATH with rustup)
tasak                           # from the repository folder (or --root DIR): generates and serves
                                # web/ at http://localhost:8765/ (LISTEN to change it)
tasak build                     # only generates web/config.js, web/favicon.svg and web/shared/
```

Run `cargo install` again after updating the repository. Without installing it, `cargo build --release
--manifest-path server/Cargo.toml` leaves the program in `server/target/release/tasak`.

Without Rust: each [release](https://github.com/Forte11Cuba/tasak/releases) has `tasak` built for Linux
(x86_64 and aarch64, static: it runs on any distribution) together with `web/`, `shared/`,
`.env.example` and `tasak.service`, and a `SHA256SUMS` file to check them:

```sh
tar xzf tasak-X.Y.Z-x86_64-linux.tar.gz   # after sha256sum -c --ignore-missing SHA256SUMS
cd tasak-X.Y.Z-x86_64-linux
cp .env.example .env && ./tasak           # the folder is the repository's: --root not needed
```

The site needs a web server, also to try it locally: opened as a file (`file://`) browsers don't load
its ES modules and the page shows a warning instead. `tasak` generates the files when it starts: run it
again after changing `.env` or `shared/`. Two ways to publish it:

- **With the tasaK server:** with Docker (see [Docker](#docker) and the [step by step](#step-by-step-on-a-server)) or run `tasak` all the time and put a web server with HTTPS (nginx, Caddy…)
  in front of it. It only serves files (GET and HEAD, nothing that receives data) and listens on
  `127.0.0.1:8765` by default (`LISTEN`). It also archives the node's events (see [Archive](#archive))
  and publishes the Tasa K (see [Published rate](#published-rate)).
- **As a static site:** run `tasak build` and publish the `web/` folder, which has everything the site
  needs, with any static web server or hosting. On GitHub Pages, publish `web/` with a GitHub Actions
  workflow that builds `tasak` and runs `tasak build` first: Pages can only publish the root or `/docs`
  of a branch, and `web/config.js` isn't in the repository.

### Docker

The image has `tasak`, `web/` and `shared/`; you only need Docker and your `.env`:

```sh
cp .env.example .env                  # your node, relays, currency and community
docker compose up -d --build          # serves the site at http://127.0.0.1:8765/ and archives
DOMAIN=tasa.example.org docker compose --profile https up -d --build   # the same, with Caddy and HTTPS
docker compose logs -f tasak
```

- `.env` is mounted read-only and read by `tasak` as without Docker (`docker compose restart tasak`
  after changing it). Inside the container `LISTEN` is `0.0.0.0:8765`, published only on the host's
  `127.0.0.1`: the HTTPS proxy is what faces the internet.
- The archive lives in the `tasak-data` volume (`/data`): keep it, it is the history the relays forget.
- `--profile https` adds Caddy (`Caddyfile`), with an automatic certificate for `DOMAIN` (which must
  point to the machine; ports 80 and 443) and compression. Without `DOMAIN`, `https://localhost`. With
  your own proxy, leave it out and point it at `127.0.0.1:8765`.
- Logo or icon files (`LOGO`, `FAVICON`) go in `web/` before building the image.
- After updating the repository: `docker compose up -d --build`.
- Without building: each release also publishes the image, `ghcr.io/forte11cuba/tasak:X.Y.Z` (and
  `:latest`), for amd64 and arm64. Use it from a `docker-compose.override.yml`, as in the
  [step by step](#step-by-step-on-a-server). It carries the repository's `web/`: mount your own logo
  files into `/app/web/`.

To import the node's history, mount the copy of the Mostro database read-only (see [Archive](#archive)):

```sh
sqlite3 /path/to/mostro.db ".backup /tmp/mostro-copy.db"
docker compose run --rm -v /tmp/mostro-copy.db:/import/mostro.db:ro tasak import-mostro /import/mostro.db
```

To publish the signed Tasa K, create the key in a `secrets/` folder outside `web/` (as root inside the
container, and then hand it to its user, uid 10001), then uncomment `SIGNING_KEY_FILE` and the
`secrets` lines in `docker-compose.yml` (or add them to the override, as in the
[step by step](#step-by-step-on-a-server)):

```sh
mkdir -p secrets
docker compose run --rm --no-deps --user root -v "$PWD/secrets:/secrets" tasak keygen /secrets/nsec
docker compose run --rm --no-deps --user root -v "$PWD/secrets:/secrets" --entrypoint chown tasak 10001:10001 /secrets/nsec
```

Keep a backup of that file (`sudo cp secrets/nsec …`): without it, a new key means a new npub.

`.env` variables:

| Variable | What it is |
|---|---|
| `SITE_NAME` | Site name: logo, browser tab and icon (default `tasaK`; if it ends in capitals, that part is highlighted) |
| `RATE_NAME` | Name of the rate across the page (default `Tasa K`) |
| `LOGO` | Site logo: file in `web/`, next to `index.html` (svg, png, jpg, webp), or https link. Empty = the name as text |
| `LOGO_LIGHT` | Logo for the light theme (optional; if missing, `LOGO` is used) |
| `FAVICON` | Browser tab icon: a file in `web/` (svg, png or ico), not a link, and not named `favicon.svg` (that's the generated one). Empty = generated by `tasak`: the capitals at the end of `SITE_NAME` (or its first letter) |
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
| `SIGNING_KEY_FILE` | File with the key that signs the published Tasa K (optional; see [Published rate](#published-rate)) |
| `RATE_DECIMALS` | Decimals of the published rate, 0 to 8 (optional; default `2`) |

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
Nor do the server's snapshot and signed Tasa K, which are about the `.env` nodes: that node is read from the
relays alone, with all the history they keep.

## Tasa K

Volume-weighted price of the orders completed in the 24 hours that end at the last completed order:

```
Tasa K = Σ(price × amount) ÷ Σ amount
```

Example (in CUP): 3 orders at 785 CUP/USD totalling 3,000 CUP and one at 750 for 5,000 CUP →
(785×3000 + 750×5000) ÷ 8000 = **763.13**.

So the Tasa K in the header changes only when a new order is completed: it doesn't move by itself as time
passes (with a window ending «now», an old order leaving it would shift the rate at any hour), and each
value is «the Tasa K after that order». If the last order is more than 24 hours old, the header says how
old. The chart's «Weighted» points per period are another thing: see below.

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

- **They count**: orders completed (`success`) in the 24 hours up to the last one, in the chosen currency, from the
  nodes in `.env`: signed by the node (checked in the browser) or, once their event is no longer on the
  relays, from the node's database (`tasak import-mostro`), unsigned and marked ◌, relying on whoever
  publishes the site.
- **They don't count**: orders never completed (open, taken, canceled, expired, in dispute); those with
  a payment method in `HIDDEN_PAYMENT_METHODS` (with «Otros», text not on the Mostro app's list, and
  «Pruebas», test orders: «prueba», «test», «no tomar»); and those without an amount in currency and in
  sats greater than zero.
- No price is discarded as an outlier, and market-price and fixed-price orders both count.

Visitors can choose other payment methods or nodes: the chart and the tables follow their choice, and
**Your selection** shows its weighted price of the 24 hours up to its last order next to the filters. The Tasa K in the
header doesn't change.

### The node's reference

Since Mostro 0.19 each node chooses its price sources (Yadio, CoinGecko, Blockchain.com, currency-api,
local-market sources or other nodes over Nostr), combines them and publishes the result, signed, in its
`mostro-rates` event with the sources in the `source` tag; it prices market orders with that same value.
The header says «Yadio reference» when the node uses Yadio alone and «Node reference» otherwise, with the
sources on hover; with several nodes, it is the newest reference among those that have orders in the
chosen currency (every node publishes every currency, at its own reference). In the order book each market order is priced with its own node's prices, which the node
keeps using for up to 30 minutes when it can't refresh them; without them, the price is estimated with
Yadio's API and marked «≈», and with neither the order is shown without a price («—»).

BTC buys and sells close at different prices, since each side sets its premium; the Tasa K weighs them all
together. For information only, without changing the rate, hovering over the Tasa K and the FAQ show the
weighted price of buys and of sells in the Tasa K's window, and how many orders were at market price (with
their average premium) or at fixed price. Market or fixed comes from the order's `pending` version or,
without it, from a premium other than 0 (Mostro doesn't allow a premium with a fixed price); orders with
premium 0 whose `pending` version wasn't seen are counted as unknown.

The chart has three modes:

- **Price**: one point per executed order, or per period (1h, 4h, 1D, 1W, 1M, 1Y) with that period's weighted price.
- **Candles**: open, high, low and close of each period.
- **Weighted**: at each point, the volume-weighted price of the previous 24 hours, `Σ(price × amount) ÷ Σ amount`. With one point per order, the 24 hours up to that order: the Tasa K after it. Per period, the 24 hours up to the period's close (or now, in the current one): it does move with time, and differs from the Tasa K when the period closed without an order.

Volume is shown at the bottom of the chart and, when hovering, the legend at the top shows that point's
values. The chart can be zoomed and scrolled (the zoom is kept when new orders arrive; double-click to see
everything again) and can go full screen. The payment method filter is in the «Payment method» menu.

The methods in `HIDDEN_PAYMENT_METHODS` are left out by default; they can be enabled from that menu.

## Security

The pages carry a Content Security Policy (`<meta>` in `index.html` and `node.html`, so it also applies
on a static host): only the site's own scripts, styles and fonts, nothing inline; images from the site or
`https` (the node's picture); and connections only to the site, to relays (`wss://`) and to the Yadio and
Coinbase APIs. The text of events is never inserted as HTML; and if someone still managed to inject code into the page,
the browser wouldn't run it nor let it connect elsewhere. It could still load an image from any `https`
address (allowed for the node's picture), which reveals the visitor's IP address to that server. The one inline style allowed, by its hash, is the
one lightweight-charts adds for TradingView's attribution logo. `tasak` also sends `frame-ancestors
'none'` (no other site may show this one in a frame), which only works as a header, and generates the
icon (`favicon.svg`, the letter of `SITE_NAME`; or `FAVICON`, a file of the site) as a file, since the
policy doesn't allow `data:` images.

## Working when services are blocked

Designed for countries or networks where some services are blocked. The page doesn't depend on any CDN:
the libraries are copied into `web/vendor/` (lightweight-charts 5.2.1 and nostr-tools 2.25.2), about 105 KB
compressed.

External services it uses and what happens if they are blocked:

| Service | Used for | If blocked |
|---|---|---|
| Nostr relays | the orders, and the current prices the node publishes (`mostro-rates`: BTC/USD, the currency's USD reference, market-price order book) | no data without them (one responding is enough) |
| Yadio | only if a node doesn't publish valid `mostro-rates`: an estimate of the current prices | currency/USD can't be calculated; currency/BTC and currency/sat keep working |
| Coinbase | hourly historical BTC/USD, for currency/USD (the hour each order was taken or, if unknown, completed); not needed when the site's server gives each order its BTC/USD | it's calculated with the current BTC/USD (the node's or Yadio's) and marked as approximate |

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
- `orders`: the completed orders, derived every minute from `events` and from `node_orders` (see below).
  Open ones are read live from the relays, and canceled or expired ones never count. Each has its current
  version, whether it was at market or fixed price, when it was taken, and its BTC/USD at that moment
  with where it came from: the node's `mostro-rates` or, without it, Coinbase (1-minute candles) or Yadio.
  So the orders from before the archive (or imported from the node's database) carry Coinbase's BTC/USD
  and the later ones the node's: currency/USD may jump slightly between them (they usually differ by less
  than 0.1%), while currency/BTC and currency/sat don't change, as they come only from the events.
- `btc_prices`: Coinbase's 1-minute BTC/USD closes, each asked for once and kept.

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
database. On a copy (`sqlite3 mostro.db ".backup mostro-copy.db"`; a `cp` of the running database is
refused if its `-wal` file has changes not yet in it), run (with Docker, see [Docker](#docker)):

```sh
tasak import-mostro mostro-copy.db        # add the node's pubkey if .env has several nodes
```

It reads the copy read-only and imports its completed orders (`success`) into the archive's
`node_orders` table. Only public trade data (currency, amounts, premium, payment methods, times, market
or fixed price), never keys, invoices or the users table. They join `orders`: an order that is also
archived as a signed event keeps the event's data and takes from the database what the relays no longer
had (when it was taken, market or fixed price); the others are marked as unsigned («node data»). The
database has no completion time: for those, the escrow lock is used. Importing again changes nothing.

## Published rate

With the archive on, every 5 minutes the server computes the official Tasa K from its `orders` table,
with the same rules as the header (the `.env`'s nodes and currency, the payment methods it doesn't hide,
and also the orders that only come from the node's database, marked as unsigned), and publishes it:

- **`/api/tasa.json`**: the rate in currency/BTC, currency/USD and currency/sat, the previous 24 h, its
  volume and orders, its window, when it was updated and the id of the signed event. For bots,
  spreadsheets and apps that don't speak Nostr.
- **A signed Nostr event**, if `SIGNING_KEY_FILE` is set: kind 30078 with `d = tasak`, content
  `{"BTC": {"CUP": …}, "tasak": {…}}`. The `tasak` part has everything needed to recompute it without
  relays or Coinbase: each order of the window with its amounts, moment and BTC/USD (and its source),
  whether it is signed, the rules' version and the decimals. It expires after 10 minutes.

- **`/api/snapshot.json`**: what the site needs to draw at once, without waiting for the relays: the
  signed events of the completed orders (all their versions), the newest `mostro-rates` and the node's
  information, the unsigned orders of the node's database, each order's BTC/USD with its source, and the
  newest signed rate. The open orders aren't in it: the order book comes live from the relays.

When there is a key, its public key goes into `config.js` (`ratePubkey`), for the site to check who
signed the rate.

The site served by `tasak` loads the snapshot first and draws at once; the relays then add what's new.
It verifies the snapshot's events as those of the relays (author, kind, signature), shows the signed Tasa
K only if `ratePubkey` signed it (with a ⚠ if it doesn't match the one it computes with the same data),
marks the unsigned orders (◌) and says how old the server's data is. It asks the relays only for the
last 7 days (longer if the node's orders last longer) and warns if the server lacks a completed order
they have. Without the server, or if it fails,
it works as before, with the relays alone; also when the URL changes the node.

Its window always ends at the last completed order (`to`); `empty_since` says since when there have been
no orders in the last 24 hours. Values are rounded to
`RATE_DECIMALS` decimals, as JavaScript's `toFixed`.

The key must be dedicated to this (not the Mostro node's, not a personal one) and live outside the
repository: `tasak` refuses a key inside `web/` or the archive's folder, or one other users can read.

```sh
tasak keygen ~/.config/tasak/nsec    # shows its npub; then SIGNING_KEY_FILE=~/.config/tasak/nsec
```

The Tasa K says at what price currency is being traded; it is not meant as a market price source for
Mostro (hence `d = tasak`, not `mostro-rates`): a node pricing its orders with it would feed it back to
itself through the premiums.

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
| `Dockerfile`, `docker-compose.yml`, `Caddyfile` | the Docker image (`tasak` with `web/` and `shared/`) and an example deployment, with Caddy for HTTPS (see [Docker](#docker)) |
| `.github/workflows/release.yml` | publishes a version when a `vX.Y.Z` tag is pushed (it must match `server/Cargo.toml`): the static binaries and the Docker image (amd64 and arm64, in GHCR), after checking that they run; run by hand, or in a pull request that changes it, it only builds and checks |
| `.github/workflows/ci.yml` | the checks run on every pull request and every push to `main`: `cargo fmt`, `clippy` and `cargo test` of the server, `node --test` of `shared/`, `tools/reference.mjs` and `tools/snapshot.mjs` in headless Chrome (after `tasak build`), and the Docker image (it builds, starts and serves the site) |
| `tools/` | development checks in headless Chrome (Node, no dependencies); `node tools/reference.mjs` checks that `web/` computes the values in `shared/test/expected.json` from fixed data, without the server; `node tools/snapshot.mjs`, with a server's snapshot and a signed rate |

## Languages

The page is in Spanish and English. The language is chosen in this order: `?lang=` in the URL, the
ES · EN switch (remembered in the browser), `LANGUAGE` in `.env` and, otherwise, the browser language.
The original texts are in Spanish; translations live in `web/i18n.js` (`EN`). Adding another language is
just another dictionary like it.

## License

[MIT](LICENSE). The third-party code in `web/vendor/` keeps its own licenses (see `web/vendor/README.md`).
