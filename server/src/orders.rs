//! The `orders` table: the completed orders, derived from the archived events with the logic of
//! shared/ (`parse_order`, `current_order`). Each run looks only at the orders that received a new
//! version since the previous one; the first run (and any rebuild) looks at all of them.

use crate::prices::{Candles, price_orders};
use sqlx::SqlitePool;
use std::time::Duration;
use tasak::logic::RawEvent;
use tasak::logic::orders::{Order, current_order, is_trade, parse_order, priced_at};
use tasak::logic::payment_methods::PmLists;
use tracing::{info, warn};

/// Every minute: brings `orders` up to date with the archive and prices the orders without BTC/USD.
/// Runs until the task is dropped
pub async fn run(pool: SqlitePool, lists: PmLists, candles: impl Candles) {
    let mut last = 0;
    loop {
        match sync(&pool, &lists, last).await {
            Ok((synced, rowid)) => {
                if last == 0 || synced.completed > 0 {
                    info!("orders: {} completed orders updated", synced.completed);
                }
                last = rowid;
            }
            Err(e) => warn!("orders: {e}"),
        }
        match price_orders(&pool, &candles).await {
            Ok(0) => {}
            Ok(n) => info!("orders: {n} priced in USD"),
            Err(e) => warn!("orders: cannot price: {e}"),
        }
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}

/// What a run changed
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Synced {
    /// Orders whose versions were looked at
    pub looked_at: usize,
    /// Completed orders written (new or updated)
    pub completed: usize,
}

/// Updates `orders` with the orders that have events after `after_rowid` (0: all of them). Returns
/// what changed and the rowid to pass next time
pub async fn sync(pool: &SqlitePool, lists: &PmLists, after_rowid: i64) -> Result<(Synced, i64), sqlx::Error> {
    let last: i64 = sqlx::query_scalar("SELECT coalesce(max(rowid), 0) FROM events")
        .fetch_one(pool)
        .await?;
    let keys: Vec<(String, String)> = sqlx::query_as(
        "SELECT DISTINCT pubkey, d FROM events WHERE kind = 38383 AND d IS NOT NULL AND rowid > ? AND rowid <= ?",
    )
    .bind(after_rowid)
    .bind(last)
    .fetch_all(pool)
    .await?;
    let mut synced = Synced::default();
    for (node, d) in keys {
        synced.looked_at += 1;
        let versions: Vec<String> =
            sqlx::query_scalar("SELECT json FROM events WHERE kind = 38383 AND pubkey = ? AND d = ?")
                .bind(&node)
                .bind(&d)
                .fetch_all(pool)
                .await?;
        let parsed: Vec<Order> = versions
            .iter()
            .filter_map(|json| serde_json::from_str::<RawEvent>(json).ok())
            .filter_map(|ev| parse_order(&ev, lists))
            .collect();
        let key = format!("{node}:{d}");
        match current_order(&parsed) {
            Some(o) if o.status == "success" && is_trade(&o) => {
                write(pool, &o).await?;
                synced.completed += 1;
            }
            // Not completed (or no longer: a newer version can't normally follow success, but the
            // table must say what the events say)
            _ => {
                sqlx::query("DELETE FROM orders WHERE key = ?")
                    .bind(&key)
                    .execute(pool)
                    .await?;
            }
        }
    }
    Ok((synced, last))
}

/// Writes a completed order. Its BTC/USD is kept while the moment it is priced at doesn't change
/// (a takenAt seen later would change it: then it is priced again)
async fn write(pool: &SqlitePool, o: &Order) -> Result<(), sqlx::Error> {
    let json = |v: &[String]| serde_json::to_string(v).expect("strings always serialize");
    sqlx::query(
        "INSERT INTO orders (key, node, id, ts, taken_at, priced_at, side, fiat, fa, amt, premium, origin_fixed, \
         origin_premium, pm, pm_keys) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT (key) DO UPDATE SET id = excluded.id, ts = excluded.ts, taken_at = excluded.taken_at, \
         side = excluded.side, fiat = excluded.fiat, fa = excluded.fa, amt = excluded.amt, \
         premium = excluded.premium, origin_fixed = excluded.origin_fixed, origin_premium = excluded.origin_premium, \
         pm = excluded.pm, pm_keys = excluded.pm_keys, \
         btc_usd = CASE WHEN orders.priced_at = excluded.priced_at THEN orders.btc_usd END, \
         btc_usd_source = CASE WHEN orders.priced_at = excluded.priced_at THEN orders.btc_usd_source END, \
         btc_usd_at = CASE WHEN orders.priced_at = excluded.priced_at THEN orders.btc_usd_at END, \
         btc_usd_ref = CASE WHEN orders.priced_at = excluded.priced_at THEN orders.btc_usd_ref END, \
         priced_at = excluded.priced_at",
    )
    .bind(&o.key)
    .bind(&o.node)
    .bind(&o.id)
    .bind(o.ts)
    .bind(o.taken_at)
    .bind(priced_at(o))
    .bind(&o.side)
    .bind(&o.fiat)
    .bind(o.fa[0])
    .bind(o.amt)
    .bind(o.premium)
    .bind(o.origin.map(|x| x.fixed))
    .bind(o.origin.map(|x| x.premium))
    .bind(json(&o.pm))
    .bind(json(&o.pm_keys))
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::store::tests::memory_store;
    use nostr_sdk::prelude::*;

    /// A version of an order with the tags Mostro publishes
    pub fn version(keys: &Keys, d: &str, status: &str, at: u64, amt: &str, premium: &str) -> Event {
        EventBuilder::new(Kind::from_u16(38383), "")
            .tags([
                Tag::identifier(d),
                Tag::parse(["k", "sell"]).unwrap(),
                Tag::parse(["f", "CUP"]).unwrap(),
                Tag::parse(["s", status]).unwrap(),
                Tag::parse(["amt", amt]).unwrap(),
                Tag::parse(["fa", "1000"]).unwrap(),
                Tag::parse(["premium", premium]).unwrap(),
                Tag::parse(["pm", "Transfermovil", "llamar al +53 5555"]).unwrap(),
            ])
            .custom_created_at(Timestamp::from_secs(at))
            .finalize(keys)
            .unwrap()
    }

    pub fn lists() -> PmLists {
        PmLists::from([(
            "CUP".to_string(),
            vec!["Transfermovil".to_string(), "EnZona".to_string()],
        )])
    }

    type Row = (String, i64, Option<i64>, i64, Option<i64>, Option<f64>, String);

    async fn rows(pool: &SqlitePool) -> Vec<Row> {
        sqlx::query_as(
            "SELECT key, ts, taken_at, priced_at, origin_fixed, origin_premium, pm_keys FROM orders ORDER BY key",
        )
        .fetch_all(pool)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn keeps_only_completed_orders_with_their_origin_and_take_time() {
        let node = Keys::generate();
        let store = memory_store(&[node.public_key()]).await;
        let pk = node.public_key().to_hex();
        let events = [
            // Market price: pending (premium 3), taken at 1100, completed at 1200
            version(&node, "a", "pending", 1000, "0", "3"),
            version(&node, "a", "in-progress", 1100, "5000", "3"),
            version(&node, "a", "success", 1200, "5000", "3"),
            // Fixed price taken with the invoice: no in-progress
            version(&node, "b", "pending", 1000, "6000", "0"),
            version(&node, "b", "success", 1300, "6000", "0"),
            // Only the final version seen
            version(&node, "c", "success", 1400, "7000", "2"),
            // Never completed
            version(&node, "d", "pending", 1000, "0", "1"),
            version(&node, "d", "canceled", 1500, "0", "1"),
            version(&node, "e", "pending", 1600, "0", "1"),
        ];
        for ev in &events {
            store.store("wss://a", ev, 1).await.unwrap();
        }
        let (synced, last) = sync(store.pool(), &lists(), 0).await.unwrap();
        assert_eq!(
            synced,
            Synced {
                looked_at: 5,
                completed: 3
            }
        );
        let keys = |k: &str| format!("{pk}:{k}");
        let pm = r#"["Transfermovil","Otros"]"#.to_string();
        assert_eq!(
            rows(store.pool()).await,
            vec![
                (keys("a"), 1200, Some(1100), 1100, Some(0), Some(3.0), pm.clone()),
                (keys("b"), 1300, None, 1300, Some(1), Some(0.0), pm.clone()),
                (keys("c"), 1400, None, 1400, None, None, pm.clone()),
            ]
        );
        // Nothing new: nothing looked at
        let (again, _) = sync(store.pool(), &lists(), last).await.unwrap();
        assert_eq!(again, Synced::default());
    }

    #[tokio::test]
    async fn a_take_time_seen_later_prices_the_order_again() {
        let node = Keys::generate();
        let store = memory_store(&[node.public_key()]).await;
        store
            .store("wss://a", &version(&node, "a", "success", 1200, "5000", "3"), 1)
            .await
            .unwrap();
        let (_, last) = sync(store.pool(), &lists(), 0).await.unwrap();
        sqlx::query("UPDATE orders SET btc_usd = 100000, btc_usd_source = 'coinbase', btc_usd_at = 1200")
            .execute(store.pool())
            .await
            .unwrap();
        // The same version again (another relay): the price stays
        store
            .store("wss://b", &version(&node, "a", "success", 1200, "5000", "3"), 2)
            .await
            .unwrap();
        let (_, last) = sync(store.pool(), &lists(), last).await.unwrap();
        let price = || async {
            sqlx::query_scalar::<_, Option<f64>>("SELECT btc_usd FROM orders")
                .fetch_one(store.pool())
                .await
                .unwrap()
        };
        assert_eq!(price().await, Some(100000.0));
        // Its in-progress version arrives late (an import): priced at another moment, so priced again
        store
            .store("wss://a", &version(&node, "a", "in-progress", 1100, "5000", "3"), 3)
            .await
            .unwrap();
        sync(store.pool(), &lists(), last).await.unwrap();
        assert_eq!(price().await, None);
        assert_eq!(rows(store.pool()).await[0].3, 1100);
    }
}
