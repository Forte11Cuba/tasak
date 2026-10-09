//! `web/api/snapshot.json`: what the site needs to draw at once, without waiting for the relays. Signed
//! events as they were received (the site verifies them as those of the relays: no need to trust the
//! server for them), the unsigned orders of the node's database marked as such, each order's BTC/USD
//! (so the site converts to USD exactly as the server, without asking Coinbase) and the signed Tasa K.
//! The order book is not here: open orders come live from the relays.

use serde::Serialize;
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::BTreeMap;

pub const VERSION: u32 = 1;

/// A completed order that is only in the node's database (no signed event to send)
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeOrder {
    pub key: String,
    pub node: String,
    /// Its success event according to the node's database (unverifiable)
    pub id: String,
    pub ts: i64,
    pub taken_at: Option<i64>,
    pub side: String,
    pub fiat: String,
    pub fa: f64,
    pub amt: f64,
    pub premium: f64,
    pub origin: Option<Origin>,
    pub pm: Vec<String>,
    pub pm_keys: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Origin {
    pub fixed: bool,
    pub premium: f64,
}

/// The BTC/USD the server gave an order
#[derive(Debug, Serialize, PartialEq)]
pub struct BtcUsd {
    pub usd: f64,
    /// node | coinbase | yadio
    pub source: String,
    pub at: i64,
    /// The mostro-rates event, when the source is the node
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: u32,
    pub generated: i64,
    /// Signed events: every version of the signed completed orders, the newest mostro-rates of each node
    /// and its newest profile, information and relays
    pub events: Vec<Value>,
    pub node_orders: Vec<NodeOrder>,
    /// Order key (node:d) -> its BTC/USD
    pub btc_usd: BTreeMap<String, BtcUsd>,
    /// The newest signed Tasa K event, or null without a signing key
    pub rate: Option<Value>,
}

type Row = (
    String,
    String,
    String,
    i64,
    Option<i64>,
    String,
    String,
    f64,
    f64,
    f64,
    Option<bool>,
    Option<f64>,
    String,
    String,
);

pub async fn build(pool: &SqlitePool, rate: Option<Value>, generated: i64) -> Result<Snapshot, sqlx::Error> {
    let jsons: Vec<String> = sqlx::query_scalar(
        // Every version of the signed completed orders, oldest first
        "SELECT e.json FROM events e JOIN orders o ON o.signed = 1 AND o.key = e.pubkey || ':' || e.d \
         WHERE e.kind = 38383 \
         UNION ALL \
         SELECT json FROM events WHERE kind = 30078 AND d = 'mostro-rates' AND rowid IN \
           (SELECT e2.rowid FROM events e2 WHERE e2.kind = 30078 AND e2.d = 'mostro-rates' AND e2.created_at = \
             (SELECT max(created_at) FROM events e3 WHERE e3.kind = 30078 AND e3.d = 'mostro-rates' AND e3.pubkey = e2.pubkey)) \
         UNION ALL \
         SELECT json FROM events WHERE rowid IN \
           (SELECT max(rowid) FROM events WHERE kind IN (0, 10002, 38385) GROUP BY kind, pubkey, d)",
    )
    .fetch_all(pool)
    .await?;
    let events: Vec<Value> = jsons.iter().filter_map(|j| serde_json::from_str(j).ok()).collect();

    let rows: Vec<Row> = sqlx::query_as(
        "SELECT key, node, id, ts, taken_at, side, fiat, fa, amt, premium, origin_fixed, origin_premium, pm, pm_keys \
         FROM orders WHERE signed = 0 ORDER BY ts, key",
    )
    .fetch_all(pool)
    .await?;
    let list = |j: &str| serde_json::from_str::<Vec<String>>(j).unwrap_or_default();
    let node_orders = rows
        .into_iter()
        .map(
            |(key, node, id, ts, taken_at, side, fiat, fa, amt, premium, fixed, origin_premium, pm, pm_keys)| {
                NodeOrder {
                    key,
                    node,
                    id,
                    ts,
                    taken_at,
                    side,
                    fiat,
                    fa,
                    amt,
                    premium,
                    origin: fixed.map(|fixed| Origin {
                        fixed,
                        premium: origin_premium.unwrap_or(0.0),
                    }),
                    pm: list(&pm),
                    pm_keys: list(&pm_keys),
                }
            },
        )
        .collect();

    let prices: Vec<(String, f64, String, i64, Option<String>)> = sqlx::query_as(
        "SELECT key, btc_usd, btc_usd_source, btc_usd_at, btc_usd_ref FROM orders WHERE btc_usd IS NOT NULL",
    )
    .fetch_all(pool)
    .await?;
    let btc_usd = prices
        .into_iter()
        .map(|(key, usd, source, at, r#ref)| (key, BtcUsd { usd, source, at, r#ref }))
        .collect();

    Ok(Snapshot {
        version: VERSION,
        generated,
        events,
        node_orders,
        btc_usd,
        rate,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orders::tests::{lists, version};
    use crate::orders::{Cursor, sync};
    use crate::store::tests::{memory_store, rates};
    use nostr_sdk::prelude::*;

    #[tokio::test]
    async fn signed_events_unsigned_orders_and_prices() {
        let node = Keys::generate();
        let store = memory_store(&[node.public_key()]).await;
        let profile = EventBuilder::new(Kind::Metadata, r#"{"name":"Nodo"}"#)
            .finalize(&node)
            .unwrap();
        for ev in [
            version(&node, "a", "pending", 1000, "0", "3"),
            version(&node, "a", "success", 1200, "5000", "3"),
            // Not completed: none of its versions go
            version(&node, "b", "pending", 1300, "0", "1"),
            rates(&node, "mostro-rates", 900),
            rates(&node, "mostro-rates", 1100),
            profile.clone(),
        ] {
            store.store("wss://a", &ev, 1).await.unwrap();
        }
        sqlx::query(
            "INSERT INTO node_orders (node, id, event_id, kind, status, fiat_code, fiat_amount, amount, premium, \
             price_from_api, payment_method, created_at, taken_at, invoice_held_at, imported) \
             VALUES (?, 'c', 'ev-c', 'buy', 'success', 'CUP', 2000, 4000, 2, 1, 'EnZona', 500, 600, 650, 1)",
        )
        .bind(node.public_key().to_hex())
        .execute(store.pool())
        .await
        .unwrap();
        sync(store.pool(), &lists(), Cursor::default()).await.unwrap();
        sqlx::query(
            "UPDATE orders SET btc_usd = 90000, btc_usd_source = 'coinbase', btc_usd_at = 1200 WHERE key LIKE '%:a'",
        )
        .execute(store.pool())
        .await
        .unwrap();
        let snap = build(store.pool(), None, 2000).await.unwrap();

        let kinds_and_status: Vec<(u64, String)> = snap
            .events
            .iter()
            .map(|e| {
                let s = e["tags"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|t| t[0] == "s")
                    .map(|t| t[1].as_str().unwrap().to_string());
                (e["kind"].as_u64().unwrap(), s.unwrap_or_default())
            })
            .collect();
        // Both versions of «a», the newest mostro-rates only, the profile; nothing of «b»
        assert_eq!(snap.events.len(), 4, "{kinds_and_status:?}");
        assert_eq!(kinds_and_status.iter().filter(|(k, _)| *k == 38383).count(), 2);
        let rates_ts: Vec<i64> = snap
            .events
            .iter()
            .filter(|e| e["kind"] == 30078)
            .map(|e| e["created_at"].as_i64().unwrap())
            .collect();
        assert_eq!(rates_ts, [1100]);
        // Every event is the signed one: it verifies
        for e in &snap.events {
            assert!(Event::from_json(e.to_string()).unwrap().verify().is_ok());
        }
        // The unsigned order, merged as in `orders`
        let pk = node.public_key().to_hex();
        assert_eq!(
            snap.node_orders,
            vec![NodeOrder {
                key: format!("{pk}:c"),
                node: pk.clone(),
                id: "ev-c".into(),
                ts: 650,
                taken_at: Some(600),
                side: "buy".into(),
                fiat: "CUP".into(),
                fa: 2000.0,
                amt: 4000.0,
                premium: 2.0,
                origin: Some(super::Origin {
                    fixed: false,
                    premium: 2.0
                }),
                pm: vec!["EnZona".into()],
                pm_keys: vec!["EnZona".into()],
            }]
        );
        assert_eq!(snap.btc_usd.len(), 1);
        assert_eq!(snap.btc_usd[&format!("{pk}:a")].usd, 90000.0);
        let json = serde_json::to_value(&snap).unwrap();
        assert!(json["rate"].is_null());
        assert_eq!(json["nodeOrders"][0]["takenAt"], 600);
        assert!(json["btcUsd"][format!("{pk}:a")].get("ref").is_none());
    }
}
