-- The completed orders (the version in force is `success`), derived from `events` with the logic of
-- shared/ (src/logic/): rebuilt at any time. Open orders aren't kept (the order book reads them live
-- from the relays), nor canceled or expired ones (they never count).
CREATE TABLE orders (
    key TEXT PRIMARY KEY NOT NULL,      -- node:d
    node TEXT NOT NULL,
    id TEXT NOT NULL,                   -- the event of the success version
    ts INTEGER NOT NULL,                -- completed: created_at of that version
    taken_at INTEGER,                   -- its first in-progress version, if one was seen
    priced_at INTEGER NOT NULL,         -- taken_at, or ts if unknown: the moment of its BTC/USD
    side TEXT NOT NULL,                 -- buy | sell
    fiat TEXT NOT NULL,
    fa REAL NOT NULL,                   -- currency amount
    amt REAL NOT NULL,                  -- sats
    premium REAL NOT NULL,
    origin_fixed INTEGER,               -- from its newest pending version: 1 fixed price, 0 market; NULL unknown
    origin_premium REAL,
    pm TEXT NOT NULL,                   -- payment methods as typed (JSON array)
    pm_keys TEXT NOT NULL,              -- methods of the Mostro app's list (JSON array)
    btc_usd REAL,                       -- BTC/USD at priced_at; NULL until a source has it
    btc_usd_source TEXT,                -- node (its mostro-rates) | coinbase (1-min candle) | yadio
    btc_usd_at INTEGER,                 -- moment of the price used
    btc_usd_ref TEXT                    -- id of the mostro-rates event when the source is the node
) STRICT;
CREATE INDEX orders_by_fiat ON orders (fiat, ts);
CREATE INDEX orders_unpriced ON orders (priced_at) WHERE btc_usd IS NULL;

-- Coinbase's BTC-USD 1-minute closes: each one asked for once and kept
CREATE TABLE btc_prices (
    minute INTEGER PRIMARY KEY NOT NULL, -- start of the minute (unix seconds)
    close REAL NOT NULL
) STRICT;
