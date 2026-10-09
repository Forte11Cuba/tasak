-- Completed orders read from a copy of the node's Mostro database (tasak import-mostro): the history the
-- relays no longer have. Only public trade data (what its 38383 events publish, plus taken_at,
-- invoice_held_at and price_from_api), never keys, invoices, preimages or the users table. Unsigned: an
-- order that is also a signed event in `events` is confirmed by it, and the event wins.
CREATE TABLE node_orders (
    node TEXT NOT NULL,                 -- the node's pubkey (hex): the database doesn't say it
    id TEXT NOT NULL,                   -- the order id: the d tag of its events
    event_id TEXT,                      -- its success event, according to the database
    kind TEXT NOT NULL,                 -- buy | sell
    status TEXT NOT NULL,
    fiat_code TEXT NOT NULL,
    fiat_amount REAL NOT NULL,
    amount REAL NOT NULL,               -- sats
    premium REAL NOT NULL,
    price_from_api INTEGER,             -- 1 market price, 0 fixed; NULL in old databases
    payment_method TEXT NOT NULL,       -- comma separated, as Mostro keeps it
    created_at INTEGER NOT NULL,
    taken_at INTEGER,                   -- the take (0 in the database = not set)
    invoice_held_at INTEGER,            -- the escrow lock, after the take
    range_parent_id TEXT,               -- a completed slice of a range order
    imported INTEGER NOT NULL,          -- when it was imported
    PRIMARY KEY (node, id)
) STRICT;

-- 1: from a signed event in `events`; 0: only in the node's database («node data»)
ALTER TABLE orders ADD COLUMN signed INTEGER NOT NULL DEFAULT 1;
