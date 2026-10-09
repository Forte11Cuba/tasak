//! The BTC/USD of each completed order, at the moment it is priced at (when it was taken or, if
//! unknown, completed), kept in `orders` with its source and moment. Sources, in order:
//! 1. the node: its newest mostro-rates published by then that it still used (signed: verifiable);
//! 2. Coinbase: the 1-minute candle, asked for once and kept in `btc_prices`;
//! 3. Yadio: its archived BTC/USD every 5 min of the last 24 h.
//!
//! An order no source has stays without price and is tried again on the next run.

use sqlx::SqlitePool;
use std::collections::{BTreeSet, HashMap};
use std::time::{Duration, Instant};
use tasak::logic::RawEvent;
use tasak::logic::rates::{parse_rates, usable_until};
use tracing::warn;

/// A candle this far before the moment still prices it (a minute without trades has no candle)
const CANDLE_GAP: i64 = 15 * 60;
/// A Yadio point this far before the moment still prices it (they come every 5 min)
const YADIO_GAP: i64 = 10 * 60;
/// Coinbase gives at most 300 candles per request (more is a 400): each request covers a window of
/// STEP plus the CANDLE_GAP before it, 300 minutes in all
pub const STEP: i64 = 300 * 60 - CANDLE_GAP;
/// A window already asked for isn't asked again before this (Coinbase down or blocked, or a window
/// without the candle an order needs): otherwise every run would ask for all of them again
pub const RETRY: Duration = Duration::from_secs(3600);
pub const COINBASE_URL: &str = "https://api.exchange.coinbase.com/products/BTC-USD/candles";

/// Where the 1-minute candles come from (Coinbase; a fake one in the tests)
pub trait Candles {
    /// Closes (minute start, close) between `start` and `end` (unix seconds), at most 300
    fn candles(&self, start: i64, end: i64) -> impl Future<Output = Result<Vec<(i64, f64)>, String>> + Send;
}

pub struct Coinbase {
    http: reqwest::Client,
}

impl Coinbase {
    pub fn new() -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            // Coinbase refuses requests without one
            .user_agent(concat!("tasak/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self { http })
    }
}

impl Candles for Coinbase {
    async fn candles(&self, start: i64, end: i64) -> Result<Vec<(i64, f64)>, String> {
        let url = format!("{COINBASE_URL}?granularity=60&start={}&end={}", iso(start), iso(end));
        let res = self.http.get(url).send().await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("HTTP {}", res.status()));
        }
        // [time, low, high, open, close, volume], newest first
        let rows: Vec<Vec<f64>> = res.json().await.map_err(|e| e.to_string())?;
        Ok(rows
            .iter()
            .filter(|r| r.len() >= 5)
            .map(|r| (r[0] as i64, r[4]))
            .collect())
    }
}

/// ISO 8601 in UTC, as Coinbase takes it
fn iso(t: i64) -> String {
    let d = chrono::DateTime::from_timestamp(t, 0).unwrap_or_default().naive_utc();
    use chrono::{Datelike, Timelike};
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        d.year(),
        d.month(),
        d.day(),
        d.hour(),
        d.minute(),
        d.second()
    )
}

#[derive(Debug, Clone, PartialEq)]
pub struct Price {
    pub btc_usd: f64,
    pub source: &'static str,
    pub at: i64,
    /// The mostro-rates event, when the source is the node
    pub reference: Option<String>,
}

/// The node's BTC/USD at `t`: its newest mostro-rates published by then, if it still used them
async fn from_node(pool: &SqlitePool, node: &str, t: i64) -> Result<Option<Price>, sqlx::Error> {
    let json: Option<String> = sqlx::query_scalar(
        "SELECT json FROM events WHERE kind = 30078 AND pubkey = ? AND d = 'mostro-rates' AND created_at <= ? \
         ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(node)
    .bind(t)
    .fetch_optional(pool)
    .await?;
    let Some(r) = json
        .and_then(|j| serde_json::from_str::<RawEvent>(&j).ok())
        .and_then(|ev| parse_rates(&ev))
    else {
        return Ok(None);
    };
    let usd = r.btc.get("USD").copied();
    Ok(usd.filter(|_| (t as f64) < usable_until(&r)).map(|btc_usd| Price {
        btc_usd,
        source: "node",
        at: r.ts,
        reference: Some(r.id.clone()),
    }))
}

/// Coinbase's close of the minute of `t`, or of the closest minute before it (within CANDLE_GAP)
async fn from_coinbase(pool: &SqlitePool, t: i64) -> Result<Option<Price>, sqlx::Error> {
    let minute = t.div_euclid(60) * 60;
    let row: Option<(i64, f64)> = sqlx::query_as(
        "SELECT minute, close FROM btc_prices WHERE minute <= ? AND minute > ? ORDER BY minute DESC LIMIT 1",
    )
    .bind(minute)
    .bind(minute - CANDLE_GAP)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(at, btc_usd)| Price {
        btc_usd,
        source: "coinbase",
        at,
        reference: None,
    }))
}

/// Yadio's archived BTC/USD closest before `t` (within YADIO_GAP): each response covers the 24 h
/// before it was received
async fn from_yadio(pool: &SqlitePool, t: i64) -> Result<Option<Price>, sqlx::Error> {
    let responses: Vec<String> = sqlx::query_scalar("SELECT data FROM yadio WHERE received >= ? AND received <= ?")
        .bind(t)
        .bind(t + 25 * 3600)
        .fetch_all(pool)
        .await?;
    let mut best: Option<(i64, f64)> = None;
    for data in responses {
        let Ok(serde_json::Value::Array(points)) = serde_json::from_str(&data) else {
            continue;
        };
        for p in points {
            let (Some(ms), Some(price)) = (p["timestamp"].as_f64(), p["price"].as_f64()) else {
                continue;
            };
            let at = (ms / 1000.0).floor() as i64;
            if at <= t && at > t - YADIO_GAP && price > 0.0 && best.is_none_or(|(b, _)| at > b) {
                best = Some((at, price));
            }
        }
    }
    Ok(best.map(|(at, btc_usd)| Price {
        btc_usd,
        source: "yadio",
        at,
        reference: None,
    }))
}

/// When each Coinbase window was last asked for (its start -> moment)
pub type Asked = HashMap<i64, Instant>;

/// Gives a BTC/USD to the completed orders that don't have one. Asks Coinbase only for the windows
/// that contain an order without price from the node, each one at most once per RETRY (`asked` keeps
/// track across runs). Returns how many orders got a price
pub async fn price_orders(pool: &SqlitePool, candles: &impl Candles, asked: &mut Asked) -> Result<usize, sqlx::Error> {
    let pending: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT key, node, priced_at FROM orders WHERE btc_usd IS NULL ORDER BY priced_at")
            .fetch_all(pool)
            .await?;
    let mut priced = 0;
    let mut missing = Vec::new();
    for (key, node, t) in pending {
        match first(&[from_node(pool, &node, t).await?, from_coinbase(pool, t).await?]) {
            Some(p) => {
                save(pool, &key, &p).await?;
                priced += 1;
            }
            None => missing.push((key, t)),
        }
    }
    if missing.is_empty() {
        return Ok(priced);
    }
    // Coinbase, once per window, a little slower than its public limit
    let windows: BTreeSet<i64> = missing
        .iter()
        .map(|(_, t)| (t.div_euclid(60) * 60).div_euclid(STEP) * STEP)
        .filter(|start| asked.get(start).is_none_or(|at| at.elapsed() >= RETRY))
        .collect();
    let (mut failed, mut last_error) = (0, String::new());
    for (i, start) in windows.into_iter().enumerate() {
        if i > 0 {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        asked.insert(start, Instant::now());
        match candles.candles(start - CANDLE_GAP, start + STEP - 60).await {
            Ok(rows) => {
                for (minute, close) in rows.into_iter().filter(|&(_, c)| c > 0.0) {
                    sqlx::query("INSERT OR IGNORE INTO btc_prices (minute, close) VALUES (?, ?)")
                        .bind(minute)
                        .bind(close)
                        .execute(pool)
                        .await?;
                }
            }
            Err(e) => {
                failed += 1;
                last_error = e;
            }
        }
    }
    if failed > 0 {
        warn!("coinbase: {failed} requests failed ({last_error}); trying them again in an hour");
    }
    for (key, t) in missing {
        if let Some(p) = first(&[from_coinbase(pool, t).await?, from_yadio(pool, t).await?]) {
            save(pool, &key, &p).await?;
            priced += 1;
        }
    }
    Ok(priced)
}

fn first(prices: &[Option<Price>]) -> Option<Price> {
    prices.iter().flatten().next().cloned()
}

async fn save(pool: &SqlitePool, key: &str, p: &Price) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE orders SET btc_usd = ?, btc_usd_source = ?, btc_usd_at = ?, btc_usd_ref = ? WHERE key = ?")
        .bind(p.btc_usd)
        .bind(p.source)
        .bind(p.at)
        .bind(&p.reference)
        .bind(key)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orders::sync;
    use crate::orders::tests::{lists, version};
    use crate::store::tests::memory_store;
    use nostr_sdk::prelude::*;
    use std::sync::Mutex;

    /// Candles of a fixed price per minute, counting the requests
    struct Fake {
        price: Option<f64>,
        asked: Mutex<Vec<(i64, i64)>>,
    }

    impl Candles for Fake {
        async fn candles(&self, start: i64, end: i64) -> Result<Vec<(i64, f64)>, String> {
            self.asked.lock().unwrap().push((start, end));
            let price = self.price.ok_or("down")?;
            Ok((start.div_euclid(60)..=end.div_euclid(60))
                .map(|m| (m * 60, price))
                .collect())
        }
    }

    fn rates(keys: &Keys, at: u64, usd: f64) -> Event {
        EventBuilder::new(Kind::from_u16(30078), format!(r#"{{"BTC":{{"USD":{usd},"CUP":1}}}}"#))
            .tags([
                Tag::identifier("mostro-rates"),
                Tag::parse(["expiration", &(at + 600).to_string()]).unwrap(),
            ])
            .custom_created_at(Timestamp::from_secs(at))
            .finalize(keys)
            .unwrap()
    }

    type Row = (String, Option<f64>, Option<String>, Option<i64>);

    async fn prices(pool: &SqlitePool) -> Vec<Row> {
        sqlx::query_as("SELECT substr(key, 66), btc_usd, btc_usd_source, btc_usd_at FROM orders ORDER BY key")
            .fetch_all(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn node_then_coinbase_then_yadio() {
        let node = Keys::generate();
        let store = memory_store(&[node.public_key()]).await;
        let t0: i64 = 1_791_000_000;
        for ev in [
            // The node published at t0 and still used them 30 min later
            rates(&node, t0 as u64, 100_000.0),
            version(&node, "a", "success", t0 as u64 + 600, "5000", "3"),
            // Completed 2 h after the node's last rates: beyond the 30 min it keeps using them
            version(&node, "b", "success", t0 as u64 + 7200, "5000", "3"),
            // Before any rates of the node
            version(&node, "c", "success", t0 as u64 - 60, "5000", "3"),
        ] {
            store.store("wss://a", &ev, 1).await.unwrap();
        }
        sync(store.pool(), &lists(), 0).await.unwrap();
        let fake = Fake {
            price: Some(90_000.0),
            asked: Mutex::new(vec![]),
        };
        assert_eq!(price_orders(store.pool(), &fake, &mut Asked::new()).await.unwrap(), 3);
        let at = |t: i64| Some(t.div_euclid(60) * 60);
        let rows = prices(store.pool()).await;
        let by = |d: &str| rows.iter().find(|r| r.0 == d).unwrap().clone();
        assert_eq!(by("a"), ("a".into(), Some(100_000.0), Some("node".into()), Some(t0)));
        assert_eq!(
            by("b"),
            ("b".into(), Some(90_000.0), Some("coinbase".into()), at(t0 + 7200))
        );
        assert_eq!(
            by("c"),
            ("c".into(), Some(90_000.0), Some("coinbase".into()), at(t0 - 60))
        );
        // Coinbase asked once per 5-hour window with an order without the node's price
        let windows: BTreeSet<i64> = [t0 + 7200, t0 - 60].iter().map(|t| t.div_euclid(STEP)).collect();
        assert_eq!(fake.asked.lock().unwrap().len(), windows.len());
        // Already priced: nothing to do, nothing asked
        assert_eq!(price_orders(store.pool(), &fake, &mut Asked::new()).await.unwrap(), 0);
        assert_eq!(fake.asked.lock().unwrap().len(), windows.len());
    }

    #[tokio::test]
    async fn yadio_when_coinbase_fails_and_none_when_nothing_has_it() {
        let node = Keys::generate();
        let store = memory_store(&[node.public_key()]).await;
        let t0: i64 = 1_791_000_000;
        store
            .store("wss://a", &version(&node, "a", "success", t0 as u64, "5000", "3"), 1)
            .await
            .unwrap();
        store
            .store(
                "wss://a",
                &version(&node, "b", "success", t0 as u64 - 3 * 86400, "5000", "3"),
                1,
            )
            .await
            .unwrap();
        // A Yadio response received an hour later, with a point 2 min before the order
        let points = format!(
            r#"[{{"price":85000.5,"timestamp":{}}},{{"price":1,"timestamp":{}}}]"#,
            (t0 - 120) * 1000,
            (t0 + 60) * 1000
        );
        store
            .store_yadio(t0 + 3600, "https://api.yadio.io/today/24/USD", &points)
            .await
            .unwrap();
        sync(store.pool(), &lists(), 0).await.unwrap();
        let down = Fake {
            price: None,
            asked: Mutex::new(vec![]),
        };
        let mut asked = Asked::new();
        assert_eq!(price_orders(store.pool(), &down, &mut asked).await.unwrap(), 1);
        let requests = down.asked.lock().unwrap().len();
        // Coinbase down: the next run doesn't ask for the same windows again before RETRY
        assert_eq!(price_orders(store.pool(), &down, &mut asked).await.unwrap(), 0);
        assert_eq!(down.asked.lock().unwrap().len(), requests);
        let rows = prices(store.pool()).await;
        let by = |d: &str| rows.iter().find(|r| r.0 == d).unwrap().clone();
        assert_eq!(
            by("a"),
            ("a".into(), Some(85000.5), Some("yadio".into()), Some(t0 - 120))
        );
        // Three days earlier, nothing has it: it stays without price and is tried again
        assert_eq!(by("b"), ("b".into(), None, None, None));
        let up = Fake {
            price: Some(80_000.0),
            asked: Mutex::new(vec![]),
        };
        // Once it's time to ask again (a new memory here) and Coinbase answers, it gets its price
        assert_eq!(price_orders(store.pool(), &up, &mut Asked::new()).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn each_request_asks_for_300_candles_at_most() {
        let node = Keys::generate();
        let store = memory_store(&[node.public_key()]).await;
        for (i, t) in [1_791_000_000u64, 1_791_050_000, 1_791_100_000].iter().enumerate() {
            store
                .store(
                    "wss://a",
                    &version(&node, &format!("o{i}"), "success", *t, "5000", "3"),
                    1,
                )
                .await
                .unwrap();
        }
        sync(store.pool(), &lists(), 0).await.unwrap();
        let fake = Fake {
            price: Some(1.0),
            asked: Mutex::new(vec![]),
        };
        price_orders(store.pool(), &fake, &mut Asked::new()).await.unwrap();
        for (start, end) in fake.asked.lock().unwrap().iter() {
            assert_eq!((end - start) / 60 + 1, 300, "{start}..{end}");
        }
    }

    #[test]
    fn iso_dates() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(1_791_194_400), "2026-10-05T10:00:00Z");
    }
}
