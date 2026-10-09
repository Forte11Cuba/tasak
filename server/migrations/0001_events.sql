-- Every signed event of the configured Mostro nodes, as received: the source of truth, never updated.
-- Orders (38383, every currency and every version), mostro-rates (30078) and the node's metadata
-- (0, 10002, 38385; only when its content changes).
CREATE TABLE events (
    id TEXT PRIMARY KEY NOT NULL,       -- hex
    pubkey TEXT NOT NULL,               -- hex
    kind INTEGER NOT NULL,
    created_at INTEGER NOT NULL,        -- unix seconds, from the event
    d TEXT,                             -- the d tag of addressable events (the order id, mostro-rates)
    received INTEGER NOT NULL,          -- unix seconds, the first time any relay sent it
    json TEXT NOT NULL                  -- the signed event (NIP-01 JSON): anyone can verify it again
) STRICT;
CREATE INDEX events_by_kind ON events (kind, created_at);
CREATE INDEX events_by_address ON events (kind, pubkey, d, created_at);

-- Which relays sent each event, and when each one first did (to check later which relay had what)
CREATE TABLE event_relays (
    id TEXT NOT NULL REFERENCES events (id),
    relay TEXT NOT NULL,
    received INTEGER NOT NULL,
    PRIMARY KEY (id, relay)
) STRICT, WITHOUT ROWID;
CREATE INDEX event_relays_by_relay ON event_relays (relay, received);

-- Yadio's BTC/USD every 5 min for the last 24 h, as downloaded: only to fill the gaps when the archive
-- was off (mostro-rates expire after 10 min)
CREATE TABLE yadio (
    received INTEGER NOT NULL,
    url TEXT NOT NULL,
    data TEXT NOT NULL,                 -- the JSON response
    PRIMARY KEY (received, url)
) STRICT;
