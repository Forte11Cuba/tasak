//! The archive's database (SQLite, in ARCHIVE_DIR): which events are stored and how. Every write is
//! idempotent: the same event stored twice, from the relays or from an import, leaves the same rows.

use nostr_sdk::prelude::*;
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Duration;
use tokio::sync::Mutex;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// Orders (NIP-69): every version of every currency
pub const ORDERS: u16 = 38383;
/// The node's prices (kind 30078 with d = mostro-rates); relays drop them 10 min after publication
pub const RATES: u16 = 30078;
pub const RATES_D: &str = "mostro-rates";
/// The node's profile (0), relays (10002) and information (38385), republished every 1–5 min
pub const META: [u16; 3] = [0, 10002, 38385];

/// File name of the database inside ARCHIVE_DIR
pub const FILE: &str = "tasak.sqlite";

pub async fn open(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        // Readers (the future indexer) don't block the writer; NORMAL is durable against crashes, and
        // what a power cut loses the relays still have
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(30));
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await?;
    MIGRATOR.run(&pool).await?;
    Ok(pool)
}

/// What became of an event offered to the archive
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stored {
    /// Stored for the first time
    New,
    /// Already stored: only which relay sent it is recorded
    Known,
    /// Node metadata with the same content as the last one stored (the node republishes it)
    Unchanged,
    /// Not from a configured node, a kind that isn't archived, or an invalid id or signature
    Rejected,
}

/// (kind, pubkey, d) of a node's metadata event
type MetaKey = (u16, String, String);

pub struct Store {
    pool: SqlitePool,
    nodes: HashSet<PublicKey>,
    /// One write at a time, so «already stored?» and the insert don't race between the live
    /// subscription and a catch-up; it also guards the fingerprint of the last metadata of each node
    last_meta: Mutex<HashMap<MetaKey, String>>,
}

impl Store {
    pub async fn new(pool: SqlitePool, nodes: impl IntoIterator<Item = PublicKey>) -> Result<Self, sqlx::Error> {
        // The last metadata stored for each node and kind (rowid = insertion order)
        let rows: Vec<String> = sqlx::query_scalar(
            "SELECT json FROM events WHERE rowid IN \
             (SELECT max(rowid) FROM events WHERE kind IN (0, 10002, 38385) GROUP BY kind, pubkey, d)",
        )
        .fetch_all(&pool)
        .await?;
        let last_meta = rows
            .iter()
            .filter_map(|json| Event::from_json(json).ok())
            .map(|ev| (meta_key(&ev), fingerprint(&ev)))
            .collect();
        Ok(Self {
            pool,
            nodes: nodes.into_iter().collect(),
            last_meta: Mutex::new(last_meta),
        })
    }

    #[cfg(test)]
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// Whether the event is something the archive keeps: from a configured node and of an archived kind
    pub fn accepts(&self, ev: &Event) -> bool {
        self.nodes.contains(&ev.pubkey)
            && match ev.kind.as_u16() {
                ORDERS => true,
                RATES => ev.tags.identifier().as_deref() == Some(RATES_D),
                k => META.contains(&k),
            }
    }

    /// Stores `ev` as sent by `relay` at `received` (unix seconds)
    pub async fn store(&self, relay: &str, ev: &Event, received: i64) -> Result<Stored, sqlx::Error> {
        // The signature too when the id is already stored: otherwise a relay could resend a stored event
        // with a forged signature and be recorded as one that had it
        if !self.accepts(ev) || !ev.verify_id() || !ev.verify_signature() {
            return Ok(Stored::Rejected);
        }
        let id = ev.id.to_hex();
        let mut last_meta = self.last_meta.lock().await;
        let known: Option<i64> = sqlx::query_scalar("SELECT 1 FROM events WHERE id = ?")
            .bind(&id)
            .fetch_optional(&self.pool)
            .await?;
        let meta = META
            .contains(&ev.kind.as_u16())
            .then(|| (meta_key(ev), fingerprint(ev)));
        if known.is_none()
            && let Some((key, print)) = &meta
            && last_meta.get(key) == Some(print)
        {
            return Ok(Stored::Unchanged);
        }
        let mut tx = self.pool.begin().await?;
        let stored = if known.is_some() {
            Stored::Known
        } else {
            sqlx::query(
                "INSERT INTO events (id, pubkey, kind, created_at, d, received, json) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(ev.pubkey.to_hex())
            .bind(i64::from(ev.kind.as_u16()))
            .bind(ev.created_at.as_secs() as i64)
            .bind(ev.tags.identifier())
            .bind(received)
            .bind(ev.as_json())
            .execute(&mut *tx)
            .await?;
            if let Some((key, print)) = meta {
                last_meta.insert(key, print);
            }
            Stored::New
        };
        sqlx::query("INSERT OR IGNORE INTO event_relays (id, relay, received) VALUES (?, ?, ?)")
            .bind(&id)
            .bind(relay)
            .bind(received)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(stored)
    }

    /// The last time `relay` sent an event (unix seconds), to resume from there after a restart
    pub async fn last_received(&self, relay: &str) -> Result<Option<i64>, sqlx::Error> {
        sqlx::query_scalar("SELECT max(received) FROM event_relays WHERE relay = ?")
            .bind(relay)
            .fetch_one(&self.pool)
            .await
    }

    /// Stores one Yadio response (`data`, JSON) as downloaded from `url`
    pub async fn store_yadio(&self, received: i64, url: &str, data: &str) -> Result<bool, sqlx::Error> {
        let r = sqlx::query("INSERT OR IGNORE INTO yadio (received, url, data) VALUES (?, ?, ?)")
            .bind(received)
            .bind(url)
            .bind(data)
            .execute(&self.pool)
            .await?;
        Ok(r.rows_affected() > 0)
    }
}

fn meta_key(ev: &Event) -> MetaKey {
    (
        ev.kind.as_u16(),
        ev.pubkey.to_hex(),
        ev.tags.identifier().unwrap_or_default(),
    )
}

/// Content and tags without the publication date, the tags sorted (the node changes their order in
/// 10002 on each publication): equal fingerprints = the same metadata republished
fn fingerprint(ev: &Event) -> String {
    let mut tags: Vec<String> = ev
        .tags
        .iter()
        .filter(|t| t.as_slice().first().map(String::as_str) != Some("published_at"))
        .map(|t| serde_json::to_string(t.as_slice()).expect("strings always serialize"))
        .collect();
    tags.sort();
    serde_json::to_string(&(&ev.content, tags)).expect("strings always serialize")
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// An in-memory archive (one connection: each connection would be another empty database)
    pub async fn memory_store(nodes: &[PublicKey]) -> Store {
        let options = SqliteConnectOptions::new().in_memory(true).foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .min_connections(1)
            .idle_timeout(None)
            .max_lifetime(None)
            .connect_with(options)
            .await
            .unwrap();
        MIGRATOR.run(&pool).await.unwrap();
        Store::new(pool, nodes.iter().copied()).await.unwrap()
    }

    pub fn order(keys: &Keys, d: &str, status: &str, at: u64) -> Event {
        EventBuilder::new(Kind::from_u16(ORDERS), "")
            .tags([
                Tag::identifier(d),
                Tag::parse(["s", status]).unwrap(),
                Tag::parse(["f", "CUP"]).unwrap(),
            ])
            .custom_created_at(Timestamp::from_secs(at))
            .finalize(keys)
            .unwrap()
    }

    pub fn rates(keys: &Keys, d: &str, at: u64) -> Event {
        EventBuilder::new(Kind::from_u16(RATES), r#"{"BTC":{"USD":100000,"CUP":44000000}}"#)
            .tags([Tag::identifier(d)])
            .custom_created_at(Timestamp::from_secs(at))
            .finalize(keys)
            .unwrap()
    }

    fn relays_info(keys: &Keys, relays: &[&str], at: u64) -> Event {
        EventBuilder::new(Kind::from_u16(10002), "")
            .tags(relays.iter().map(|r| Tag::parse(["r", r]).unwrap()))
            .custom_created_at(Timestamp::from_secs(at))
            .finalize(keys)
            .unwrap()
    }

    async fn count(store: &Store, sql: &'static str) -> i64 {
        sqlx::query_scalar(sql).fetch_one(store.pool()).await.unwrap()
    }

    #[tokio::test]
    async fn stores_each_event_once_and_every_relay_that_sent_it() {
        let node = Keys::generate();
        let store = memory_store(&[node.public_key()]).await;
        let ev = order(&node, "o1", "pending", 1000);
        assert_eq!(store.store("wss://a", &ev, 2000).await.unwrap(), Stored::New);
        assert_eq!(store.store("wss://b", &ev, 2001).await.unwrap(), Stored::Known);
        assert_eq!(store.store("wss://a", &ev, 2002).await.unwrap(), Stored::Known);
        assert_eq!(count(&store, "SELECT count(*) FROM events").await, 1);
        assert_eq!(count(&store, "SELECT count(*) FROM event_relays").await, 2);
        assert_eq!(count(&store, "SELECT received FROM events").await, 2000);
        assert_eq!(store.last_received("wss://a").await.unwrap(), Some(2000));
        assert_eq!(store.last_received("wss://c").await.unwrap(), None);
        // The stored JSON is the signed event: it verifies again
        let json: String = sqlx::query_scalar("SELECT json FROM events")
            .fetch_one(store.pool())
            .await
            .unwrap();
        assert!(Event::from_json(&json).unwrap().verify().is_ok());
        let d: String = sqlx::query_scalar("SELECT d FROM events")
            .fetch_one(store.pool())
            .await
            .unwrap();
        assert_eq!(d, "o1");
    }

    #[tokio::test]
    async fn keeps_every_version_of_an_order() {
        let node = Keys::generate();
        let store = memory_store(&[node.public_key()]).await;
        for (status, at) in [("pending", 1000), ("in-progress", 1100), ("success", 1200)] {
            assert_eq!(
                store
                    .store("wss://a", &order(&node, "o1", status, at), at as i64)
                    .await
                    .unwrap(),
                Stored::New
            );
        }
        assert_eq!(count(&store, "SELECT count(*) FROM events WHERE d = 'o1'").await, 3);
    }

    #[tokio::test]
    async fn rejects_other_authors_kinds_and_bad_signatures() {
        let node = Keys::generate();
        let other = Keys::generate();
        let store = memory_store(&[node.public_key()]).await;
        let reject = |ev: Event| {
            let store = &store;
            async move { store.store("wss://a", &ev, 1).await.unwrap() }
        };
        assert_eq!(reject(order(&other, "o1", "pending", 1000)).await, Stored::Rejected);
        let note = EventBuilder::new(Kind::TextNote, "hola").finalize(&node).unwrap();
        assert_eq!(reject(note).await, Stored::Rejected);
        // kind 30078 with another d is not mostro-rates
        assert_eq!(reject(rates(&node, "other-app", 1000)).await, Stored::Rejected);
        // Changed content: the id no longer matches
        let mut forged = order(&node, "o2", "success", 1000);
        forged.content = "x".into();
        assert_eq!(reject(forged).await, Stored::Rejected);
        // Valid id, signature from another key
        let good = order(&node, "o3", "success", 1000);
        let mut bad = good.clone();
        bad.sig = order(&other, "o3", "success", 1000).sig;
        assert_eq!(reject(bad).await, Stored::Rejected);
        assert_eq!(count(&store, "SELECT count(*) FROM events").await, 0);
        assert_eq!(reject(good.clone()).await, Stored::New);
        assert_eq!(reject(rates(&node, RATES_D, 1000)).await, Stored::New);
        // A stored event resent with a forged signature: no relay is recorded for it
        let mut resent = good.clone();
        resent.sig = order(&other, "o3", "success", 1000).sig;
        assert_eq!(store.store("wss://forger", &resent, 2).await.unwrap(), Stored::Rejected);
        assert_eq!(store.last_received("wss://forger").await.unwrap(), None);
    }

    #[tokio::test]
    async fn stores_node_metadata_only_when_it_changes() {
        let node = Keys::generate();
        let store = memory_store(&[node.public_key()]).await;
        let first = relays_info(&node, &["wss://a", "wss://b"], 1000);
        assert_eq!(store.store("wss://a", &first, 1).await.unwrap(), Stored::New);
        // Republished with the tags in another order: the same metadata
        let again = relays_info(&node, &["wss://b", "wss://a"], 1060);
        assert_eq!(store.store("wss://a", &again, 2).await.unwrap(), Stored::Unchanged);
        let changed = relays_info(&node, &["wss://a"], 1120);
        assert_eq!(store.store("wss://a", &changed, 3).await.unwrap(), Stored::New);
        // After a restart the last fingerprint comes from the database
        let reopened = Store::new(store.pool().clone(), [node.public_key()]).await.unwrap();
        let same = relays_info(&node, &["wss://a"], 1180);
        assert_eq!(reopened.store("wss://a", &same, 4).await.unwrap(), Stored::Unchanged);
        assert_eq!(count(&reopened, "SELECT count(*) FROM events").await, 2);
    }

    #[tokio::test]
    async fn yadio_responses_are_stored_once() {
        let store = memory_store(&[]).await;
        assert!(store.store_yadio(1, "https://y", "[]").await.unwrap());
        assert!(!store.store_yadio(1, "https://y", "[]").await.unwrap());
        assert!(store.store_yadio(2, "https://y", "[]").await.unwrap());
    }
}
