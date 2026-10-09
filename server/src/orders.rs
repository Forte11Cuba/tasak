//! The `orders` table: the completed orders, derived with the logic of shared/ (`parse_order`,
//! `current_order`) from two sources: the archived events (signed) and the orders imported from the
//! node's database (`node_orders`, unsigned). The signed event wins; the database adds what the relays
//! didn't keep (the take time, market or fixed price) and the orders that are no longer on any relay.
//! Each run looks only at the orders with something new in either source since the previous one.

use crate::prices::{Asked, Candles, price_orders};
use sqlx::SqlitePool;
use std::collections::BTreeSet;
use std::time::Duration;
use tasak::logic::RawEvent;
use tasak::logic::orders::{Order, Origin, current_order, is_trade, parse_order, priced_at};
use tasak::logic::payment_methods::{NO_METHOD, PmLists, pm_key, pm_list_for};
use tracing::{info, warn};

/// Every minute: brings `orders` up to date with both sources and prices the orders without BTC/USD.
/// Runs until the task is dropped
pub async fn run(pool: SqlitePool, lists: PmLists, candles: impl Candles) {
    let (mut cursor, mut first) = (Cursor::default(), true);
    let mut asked = Asked::new();
    loop {
        match sync(&pool, &lists, cursor).await {
            Ok((synced, next)) => {
                if first || synced.completed > 0 {
                    info!("orders: {} completed orders updated", synced.completed);
                }
                (cursor, first) = (next, false);
            }
            Err(e) => warn!("orders: {e}"),
        }
        match price_orders(&pool, &candles, &mut asked).await {
            Ok(0) => {}
            Ok(n) => info!("orders: {n} priced in USD"),
            Err(e) => warn!("orders: cannot price: {e}"),
        }
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}

/// Where the previous run stopped in each source (rowids); the default is the beginning: everything
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Cursor {
    pub events: i64,
    pub node_orders: i64,
}

/// What a run changed
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Synced {
    /// Orders looked at
    pub looked_at: usize,
    /// Completed orders written (new or updated)
    pub completed: usize,
}

/// A completed order of the node's database, as imported (only public trade data)
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct NodeOrder {
    pub id: String,
    pub event_id: Option<String>,
    pub kind: String,
    pub status: String,
    pub fiat_code: String,
    pub fiat_amount: f64,
    pub amount: f64,
    pub premium: f64,
    pub price_from_api: Option<bool>,
    pub payment_method: String,
    pub created_at: i64,
    pub taken_at: Option<i64>,
    pub invoice_held_at: Option<i64>,
}

/// Updates `orders` with the orders that have something new after `after` in either source. Returns
/// what changed and where to start next time
pub async fn sync(pool: &SqlitePool, lists: &PmLists, after: Cursor) -> Result<(Synced, Cursor), sqlx::Error> {
    let next = Cursor {
        events: sqlx::query_scalar("SELECT coalesce(max(rowid), 0) FROM events")
            .fetch_one(pool)
            .await?,
        node_orders: sqlx::query_scalar("SELECT coalesce(max(rowid), 0) FROM node_orders")
            .fetch_one(pool)
            .await?,
    };
    let mut keys: BTreeSet<(String, String)> = BTreeSet::new();
    keys.extend(
        sqlx::query_as::<_, (String, String)>(
            "SELECT DISTINCT pubkey, d FROM events WHERE kind = 38383 AND d IS NOT NULL AND rowid > ? AND rowid <= ?",
        )
        .bind(after.events)
        .bind(next.events)
        .fetch_all(pool)
        .await?,
    );
    keys.extend(
        sqlx::query_as::<_, (String, String)>("SELECT node, id FROM node_orders WHERE rowid > ? AND rowid <= ?")
            .bind(after.node_orders)
            .bind(next.node_orders)
            .fetch_all(pool)
            .await?,
    );
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
        let from_db: Option<NodeOrder> = sqlx::query_as("SELECT * FROM node_orders WHERE node = ? AND id = ?")
            .bind(&node)
            .bind(&d)
            .fetch_optional(pool)
            .await?;
        let key = format!("{node}:{d}");
        match merge(current_order(&parsed), from_db.as_ref(), &node, lists) {
            Some((o, signed)) if is_trade(&o) => {
                write(pool, &o, signed).await?;
                synced.completed += 1;
            }
            _ => {
                sqlx::query("DELETE FROM orders WHERE key = ?")
                    .bind(&key)
                    .execute(pool)
                    .await?;
            }
        }
    }
    Ok((synced, next))
}

/// The completed order from both sources, and whether it is signed. The signed event wins, and takes
/// from the database what it lacks; without a success event, the database's order (unsigned: its
/// event may have expired before it was archived)
fn merge(
    from_events: Option<Order>,
    from_db: Option<&NodeOrder>,
    node: &str,
    lists: &PmLists,
) -> Option<(Order, bool)> {
    let from_db = from_db.filter(|n| n.status == "success");
    match (from_events, from_db) {
        (Some(mut o), db) if o.status == "success" => {
            if let Some(n) = db {
                if o.fa.first() != Some(&n.fiat_amount) || o.amt != n.amount {
                    warn!(
                        "orders: {}: the node's database says {} {} for {} sats, its signed event {:?} for {} (the event wins)",
                        o.key, n.fiat_amount, n.fiat_code, n.amount, o.fa, o.amt
                    );
                }
                o.taken_at = o.taken_at.or(n.taken_at);
                o.origin = o.origin.or_else(|| origin(n));
            }
            Some((o, true))
        }
        (_, Some(n)) => Some((from_node(n, node, lists), false)),
        _ => None,
    }
}

/// Market or fixed price from the database: price_from_api (the sats were computed at take time)
fn origin(n: &NodeOrder) -> Option<Origin> {
    n.price_from_api.map(|market| Origin {
        fixed: !market,
        premium: n.premium,
    })
}

/// An order of the node's database as the logic sees one. There is no completion time: the escrow
/// lock (after the take) is the closest one it has
fn from_node(n: &NodeOrder, node: &str, lists: &PmLists) -> Order {
    let fiat = n.fiat_code.to_uppercase();
    let pm: Vec<String> = n
        .payment_method
        .split(',')
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(String::from)
        .collect();
    let list = pm_list_for(lists, &fiat);
    let mut pm_keys: Vec<String> = Vec::new();
    for k in pm.iter().map(|m| pm_key(m, &list)) {
        if !pm_keys.contains(&k) {
            pm_keys.push(k);
        }
    }
    if pm_keys.is_empty() {
        pm_keys.push(NO_METHOD.to_string());
    }
    Order {
        key: format!("{node}:{}", n.id),
        node: node.to_string(),
        node_name: None,
        id: n.event_id.clone().unwrap_or_default(),
        ts: n.invoice_held_at.or(n.taken_at).unwrap_or(n.created_at),
        status: "success".into(),
        side: n.kind.to_lowercase(),
        fiat,
        fa: vec![n.fiat_amount],
        amt: n.amount,
        premium: n.premium,
        expires_at: 0.0,
        pm,
        pm_keys,
        origin: origin(n),
        taken_at: n.taken_at,
    }
}

/// Writes a completed order. Its BTC/USD is kept while the moment it is priced at doesn't change
/// (a take time seen later would change it: then it is priced again)
async fn write(pool: &SqlitePool, o: &Order, signed: bool) -> Result<(), sqlx::Error> {
    let json = |v: &[String]| serde_json::to_string(v).expect("strings always serialize");
    sqlx::query(
        "INSERT INTO orders (key, node, id, ts, taken_at, priced_at, side, fiat, fa, amt, premium, origin_fixed, \
         origin_premium, pm, pm_keys, signed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT (key) DO UPDATE SET id = excluded.id, ts = excluded.ts, taken_at = excluded.taken_at, \
         side = excluded.side, fiat = excluded.fiat, fa = excluded.fa, amt = excluded.amt, \
         premium = excluded.premium, origin_fixed = excluded.origin_fixed, origin_premium = excluded.origin_premium, \
         pm = excluded.pm, pm_keys = excluded.pm_keys, signed = excluded.signed, \
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
    .bind(signed)
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
        let (synced, last) = sync(store.pool(), &lists(), Cursor::default()).await.unwrap();
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
        let (_, last) = sync(store.pool(), &lists(), Cursor::default()).await.unwrap();
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
