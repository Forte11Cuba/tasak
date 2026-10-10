//! The official Tasa K, computed by the server from `orders` with the logic of shared/ and the site's
//! rules (the .env's nodes and currency, the payment methods it doesn't hide). Every 5 minutes it writes
//! `web/api/tasa.json` and, with a signing key, publishes it as a signed Nostr event (kind 30078,
//! d = tasak) with everything needed to recompute it: each order with its amounts, moment and BTC/USD.
//! Not meant as a price source for Mostro: hence `d = tasak`, not `mostro-rates`.

use crate::archive::now;
use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tasak::logic::js::to_fixed;
use tasak::logic::orders::{Filters, Order, Origin, get_trades, most_used_fiat};
use tasak::logic::payment_methods::{default_pm_selection, hidden_set, pm_stats};
use tasak::logic::rate::{TasaK, WINDOW, last_tasa_k, tasa_k};

/// Version of the rules the rate follows (which orders count): changes if they ever change
pub const RULES: u32 = 1;
pub const D_TAG: &str = "tasak";
pub const EVERY: Duration = Duration::from_secs(5 * 60);
/// The event expires after two intervals: a stale one disappears from the relays
pub const EXPIRES: i64 = 10 * 60;

/// What the site's configuration says about the rate
#[derive(Debug, Clone)]
pub struct Rules {
    /// The .env's nodes (hex)
    pub nodes: Vec<String>,
    /// FIAT, or empty: the currency with most completed orders
    pub fiat: String,
    pub hidden: Vec<String>,
    pub decimals: usize,
}

/// A completed order as `orders` keeps it, with its BTC/USD
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Row {
    pub key: String,
    pub node: String,
    pub id: String,
    pub ts: i64,
    pub taken_at: Option<i64>,
    pub priced_at: i64,
    pub side: String,
    pub fiat: String,
    pub fa: f64,
    pub amt: f64,
    pub premium: f64,
    pub origin_fixed: Option<bool>,
    pub origin_premium: Option<f64>,
    pub pm_keys: String,
    pub signed: bool,
    pub btc_usd: Option<f64>,
    pub btc_usd_source: Option<String>,
    pub btc_usd_at: Option<i64>,
    pub btc_usd_ref: Option<String>,
}

impl Row {
    fn order(&self) -> Order {
        Order {
            key: self.key.clone(),
            node: self.node.clone(),
            node_name: None,
            id: self.id.clone(),
            ts: self.ts,
            status: "success".into(),
            side: self.side.clone(),
            fiat: self.fiat.clone(),
            fa: vec![self.fa],
            amt: self.amt,
            premium: self.premium,
            expires_at: 0.0,
            pm: vec![],
            pm_keys: serde_json::from_str(&self.pm_keys).unwrap_or_default(),
            origin: self.origin_fixed.map(|fixed| Origin {
                fixed,
                premium: self.origin_premium.unwrap_or(0.0),
            }),
            taken_at: self.taken_at,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Pair {
    pub btc: Option<f64>,
    pub usd: Option<f64>,
}

/// An order of the window, with what's needed to recompute the rate without relays or Coinbase
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AuditOrder {
    /// Its success event or, for node data, the id the node's database gives it
    pub id: String,
    pub key: String,
    /// false: only in the node's database (unsigned, «node data»)
    pub signed: bool,
    pub side: String,
    pub fa: f64,
    pub amt: f64,
    pub ts: i64,
    pub priced_at: i64,
    pub btc_usd: Option<f64>,
    pub btc_usd_source: Option<String>,
    pub btc_usd_at: Option<i64>,
    /// The mostro-rates event, when the BTC/USD is the node's
    pub mostro_rates: Option<String>,
}

/// Everything about the published rate (the event's audit and, with a little more, the API)
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Rate {
    pub rules: u32,
    pub decimals: usize,
    pub fiat: String,
    pub nodes: Vec<String>,
    pub hidden_methods: Vec<String>,
    /// (from, to]: the 24 hours before `to`
    pub from: i64,
    pub to: i64,
    /// No orders in the last 24 h since then: the rate is the last one (the window of the last order)
    pub empty_since: Option<i64>,
    pub rate: Pair,
    pub previous: Pair,
    /// Currency moved
    pub volume: f64,
    pub count: usize,
    /// Orders of the window not counted in currency/USD (still without BTC/USD)
    pub without_usd: usize,
    pub unsigned: usize,
    pub orders: Vec<AuditOrder>,
}

/// The rate at `now`, or None if there has never been a completed order (in that currency)
pub fn compute(rows: &[Row], rules: &Rules, now: i64) -> Option<Rate> {
    let orders: Vec<Order> = rows.iter().map(Row::order).collect();
    let fiat = if rules.fiat.is_empty() {
        most_used_fiat(&orders)?
    } else {
        rules.fiat.clone()
    };
    let nodes: HashSet<String> = rules.nodes.iter().cloned().collect();
    let keys: Vec<String> = pm_stats(&orders, &fiat, &nodes, now as f64)
        .into_iter()
        .map(|s| s.key)
        .collect();
    let filters = Filters {
        fiat: fiat.clone(),
        nodes,
        pm_sel: default_pm_selection(&keys, &hidden_set(&rules.hidden)),
    };
    let by_key: HashMap<&str, &Row> = rows.iter().map(|r| (r.key.as_str(), r)).collect();
    let btc = get_trades(&orders, &filters, |p, _| Some(p));
    let usd = get_trades(&orders, &filters, |p, o| by_key[o.key.as_str()].btc_usd.map(|b| p / b));
    // No completed order: no rate. With an empty window, the last one (`last_tasa_k`, as the site)
    btc.last()?;
    let last = last_tasa_k(&btc, now as f64);
    let (to, empty_since) = (last.to as i64, last.empty_since.map(|e| e as i64));
    let (k, k_usd) = (last.k, tasa_k(&usd, last.to));
    let round = |x: Option<f64>| x.and_then(|v| to_fixed(v, rules.decimals).parse().ok());
    let pair = |b: &TasaK, u: &TasaK, previous: bool| {
        if previous {
            Pair {
                btc: round(b.previous),
                usd: round(u.previous),
            }
        } else {
            Pair {
                btc: round(b.rate),
                usd: round(u.rate),
            }
        }
    };
    let used: BTreeSet<&str> = k_usd.ids.iter().map(String::as_str).collect();
    let orders: Vec<AuditOrder> = btc
        .iter()
        .filter(|t| k.ids.contains(&t.id))
        .map(|t| {
            let r = by_key[t.key.as_str()];
            AuditOrder {
                id: r.id.clone(),
                key: r.key.clone(),
                signed: r.signed,
                side: r.side.clone(),
                fa: r.fa,
                amt: r.amt,
                ts: r.ts,
                priced_at: r.priced_at,
                btc_usd: r.btc_usd,
                btc_usd_source: r.btc_usd_source.clone(),
                btc_usd_at: r.btc_usd_at,
                mostro_rates: r.btc_usd_ref.clone(),
            }
        })
        .collect();
    Some(Rate {
        rules: RULES,
        decimals: rules.decimals,
        fiat,
        nodes: rules.nodes.clone(),
        hidden_methods: rules.hidden.clone(),
        from: to - WINDOW as i64,
        to,
        empty_since,
        rate: pair(&k, &k_usd, false),
        previous: pair(&k, &k_usd, true),
        volume: k.volume,
        count: k.count,
        without_usd: orders.iter().filter(|o| !used.contains(o.id.as_str())).count(),
        unsigned: orders.iter().filter(|o| !o.signed).count(),
        orders,
    })
}

/// The event's content: the shape of mostro-rates ({"BTC": {currency: per BTC}}) plus the audit
pub fn content(rate: &Rate) -> serde_json::Value {
    serde_json::json!({ "BTC": { rate.fiat.as_str(): rate.rate.btc }, "tasak": rate })
}

/// What /api/tasa.json says: the rate in the three units, when and how, and the event to verify it
#[derive(Debug, Serialize)]
pub struct Api<'a> {
    pub fiat: &'a str,
    pub btc: Option<f64>,
    pub usd: Option<f64>,
    pub sat: Option<f64>,
    pub previous: &'a Pair,
    pub volume: f64,
    pub count: usize,
    pub from: i64,
    pub to: i64,
    pub empty_since: Option<i64>,
    pub updated: i64,
    pub decimals: usize,
    pub unsigned: usize,
    pub without_usd: usize,
    /// The signed Nostr event (kind 30078, d = tasak), if the site has a signing key
    pub event: Option<String>,
    pub pubkey: Option<String>,
}

pub fn api<'a>(rate: &'a Rate, updated: i64, event: Option<String>, pubkey: Option<String>) -> Api<'a> {
    // currency/sat = currency/BTC ÷ 1e8, with 8 more decimals so it keeps the same precision
    let sat = rate
        .rate
        .btc
        .and_then(|b| to_fixed(b / 1e8, (rate.decimals + 8).min(16)).parse().ok());
    Api {
        fiat: &rate.fiat,
        btc: rate.rate.btc,
        usd: rate.rate.usd,
        sat,
        previous: &rate.previous,
        volume: rate.volume,
        count: rate.count,
        from: rate.from,
        to: rate.to,
        empty_since: rate.empty_since,
        updated,
        decimals: rate.decimals,
        unsigned: rate.unsigned,
        without_usd: rate.without_usd,
        event,
        pubkey,
    }
}

pub async fn load_rows(pool: &SqlitePool) -> Result<Vec<Row>, sqlx::Error> {
    sqlx::query_as(
        "SELECT key, node, id, ts, taken_at, priced_at, side, fiat, fa, amt, premium, origin_fixed, origin_premium, \
         pm_keys, signed, btc_usd, btc_usd_source, btc_usd_at, btc_usd_ref FROM orders",
    )
    .fetch_all(pool)
    .await
}

/// The signed event of the rate (kind 30078, d = tasak): tags only to filter (currency, nodes), all the
/// rest in the content (relays limit the number of tags)
pub fn event(keys: &nostr_sdk::prelude::Keys, rate: &Rate, t: i64) -> Result<nostr_sdk::prelude::Event, String> {
    use nostr_sdk::prelude::*;
    let mut tags = vec![
        Tag::identifier(D_TAG),
        Tag::parse(["f", rate.fiat.as_str()]).map_err(|e| e.to_string())?,
        Tag::expiration(Timestamp::from_secs((t + EXPIRES) as u64)),
    ];
    tags.extend(
        rate.nodes
            .iter()
            .filter_map(|n| PublicKey::parse(n).ok())
            .map(Tag::public_key),
    );
    EventBuilder::new(Kind::from_u16(30078), content(rate).to_string())
        .tags(tags)
        .custom_created_at(Timestamp::from_secs(t as u64))
        .finalize(keys)
        .map_err(|e| format!("cannot sign: {e}"))
}

/// Signs and sends the rate to the client's relays; the event, if at least one relay took it
pub async fn send(
    client: &nostr_sdk::prelude::Client,
    keys: &nostr_sdk::prelude::Keys,
    rate: &Rate,
    t: i64,
) -> Result<nostr_sdk::prelude::Event, String> {
    let ev = event(keys, rate, t)?;
    let out = client.send_event(&ev).await.map_err(|e| e.to_string())?;
    if out.success.is_empty() {
        return Err("no relay took the rate".into());
    }
    if !out.failed.is_empty() {
        tracing::warn!("publish: {} relays refused the rate", out.failed.len());
    }
    Ok(ev)
}

/// Writes `path` whole or not at all (a reader never sees half a file)
fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(tmp, path)
}

/// Every 5 minutes: computes the rate, publishes the event (with `keys`) and writes `tasa.json` and
/// `snapshot.json` into `api_dir`. Runs until the task is dropped
pub async fn run(
    pool: SqlitePool,
    rules: Rules,
    relays: Vec<String>,
    keys: Option<nostr_sdk::prelude::Keys>,
    api_dir: PathBuf,
) {
    use nostr_sdk::prelude::*;
    let client = Client::default();
    if keys.is_some() {
        for r in &relays {
            if let Err(e) = client.add_relay(r.as_str()).await {
                tracing::warn!("publish: {r}: {e}");
            }
        }
        client.connect().await;
    }
    let pubkey = keys.as_ref().and_then(|k| k.public_key().to_bech32().ok());
    // The newest signed rate, for the snapshot
    let mut last_event: Option<serde_json::Value> = None;
    // Let the first sync and pricing of `orders` run first
    tokio::time::sleep(Duration::from_secs(30)).await;
    loop {
        let t = now();
        match load_rows(&pool).await {
            Ok(rows) => match compute(&rows, &rules, t) {
                Some(rate) => {
                    let mut event_id = None;
                    if let Some(keys) = &keys {
                        match send(&client, keys, &rate, t).await {
                            Ok(ev) => {
                                event_id = Some(ev.id.to_hex());
                                last_event = serde_json::from_str(&ev.as_json()).ok();
                            }
                            Err(e) => tracing::warn!("publish: {e}"),
                        }
                    }
                    let text =
                        serde_json::to_string_pretty(&api(&rate, t, event_id, pubkey.clone())).expect("serializable");
                    write(&api_dir.join("tasa.json"), &text);
                }
                None => tracing::info!("publish: no completed orders yet"),
            },
            Err(e) => tracing::warn!("publish: {e}"),
        }
        match crate::snapshot::build(&pool, last_event.clone(), t).await {
            Ok(snapshot) => write(
                &api_dir.join("snapshot.json"),
                &serde_json::to_string(&snapshot).expect("serializable"),
            ),
            Err(e) => tracing::warn!("publish: snapshot: {e}"),
        }
        tokio::time::sleep(EVERY).await;
    }
}

fn write(path: &Path, text: &str) {
    if let Err(e) = write_atomic(path, text) {
        tracing::warn!("publish: cannot write {}: {e}", path.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(key: &str, ts: i64, fa: f64, amt: f64, btc_usd: Option<f64>, signed: bool, pm: &str) -> Row {
        Row {
            key: format!("n1:{key}"),
            node: "n1".into(),
            id: format!("ev-{key}"),
            ts,
            taken_at: None,
            priced_at: ts,
            side: "sell".into(),
            fiat: "CUP".into(),
            fa,
            amt,
            premium: 0.0,
            origin_fixed: None,
            origin_premium: None,
            pm_keys: format!(r#"["{pm}"]"#),
            signed,
            btc_usd,
            btc_usd_source: btc_usd.map(|_| "coinbase".into()),
            btc_usd_at: btc_usd.map(|_| ts),
            btc_usd_ref: None,
        }
    }

    fn rules() -> Rules {
        Rules {
            nodes: vec!["n1".into()],
            fiat: String::new(),
            hidden: vec!["Saldo móvil".into()],
            decimals: 2,
        }
    }

    const NOW: i64 = 1_000_000;

    #[tokio::test]
    async fn the_signed_event_reaches_a_relay_and_verifies() {
        use nostr_sdk::local_relay::LocalRelayBuilder;
        use nostr_sdk::prelude::*;
        let relay = LocalRelayBuilder::default().build();
        relay.run().await.unwrap();
        let url = relay.url().await;
        let keys = Keys::generate();
        let node = Keys::generate().public_key().to_hex();
        let mut r = rules();
        r.nodes = vec![node.clone()];
        // Now, not 1970: a relay refuses an event that has already expired (NIP-40)
        let t = now();
        let mut a = row("a", t - 100, 1000.0, 100_000.0, Some(100_000.0), true, "EnZona");
        a.node = node.clone();
        let rate = compute(&[a], &r, t).unwrap();
        let client = Client::default();
        client.add_relay(&url).await.unwrap();
        client.connect().and_wait(Duration::from_secs(5)).await;
        let id = send(&client, &keys, &rate, t).await.unwrap().id.to_hex();
        let got = client
            .fetch_events(
                Filter::new()
                    .kind(Kind::from_u16(30078))
                    .author(keys.public_key())
                    .identifier(D_TAG),
            )
            .await
            .unwrap();
        let ev = got.into_iter().next().unwrap();
        assert_eq!(ev.id.to_hex(), id);
        assert!(ev.verify().is_ok());
        let c: serde_json::Value = serde_json::from_str(&ev.content).unwrap();
        assert_eq!(c["BTC"]["CUP"], 1_000_000.0);
        assert_eq!(c["tasak"]["orders"][0]["id"], "ev-a");
        let tag = |name: &str| {
            ev.tags
                .iter()
                .find(|t| t.as_slice()[0] == name)
                .map(|t| t.as_slice()[1].clone())
        };
        assert_eq!(tag("f").as_deref(), Some("CUP"));
        assert_eq!(tag("p").as_deref(), Some(node.as_str()));
        assert_eq!(tag("expiration").as_deref(), Some((t + EXPIRES).to_string().as_str()));
        client.shutdown().await;
    }

    #[test]
    fn the_rate_of_the_24h_up_to_the_last_order_with_the_site_rules() {
        let rows = vec![
            // 1000 CUP for 100 000 sats = 1 000 000 CUP/BTC; at 100 000 USD/BTC, 10 CUP/USD
            row("a", NOW - 100, 1000.0, 100_000.0, Some(100_000.0), true, "EnZona"),
            // 3000 for 100 000 sats = 3 000 000 CUP/BTC; still without USD price; node data
            row("b", NOW - 50, 3000.0, 100_000.0, None, false, "EnZona"),
            // A hidden method: doesn't count
            row("c", NOW - 40, 9000.0, 100_000.0, Some(100_000.0), true, "Saldo móvil"),
            // The previous 24 h
            row("d", NOW - 90_000, 2000.0, 100_000.0, Some(80_000.0), true, "EnZona"),
        ];
        let rate = compute(&rows, &rules(), NOW).unwrap();
        assert_eq!(rate.fiat, "CUP");
        // The window ends at the last order that counts («b»; «c» is a hidden method), not now
        assert_eq!(
            (rate.from, rate.to, rate.empty_since),
            (NOW - 50 - 86_400, NOW - 50, None)
        );
        // Weighted by currency: (1e6×1000 + 3e6×3000) ÷ 4000 = 2 500 000; in USD only «a»: 10
        assert_eq!(
            rate.rate,
            Pair {
                btc: Some(2_500_000.0),
                usd: Some(10.0)
            }
        );
        assert_eq!(
            rate.previous,
            Pair {
                btc: Some(2_000_000.0),
                usd: Some(25.0)
            }
        );
        assert_eq!(
            (rate.count, rate.volume, rate.without_usd, rate.unsigned),
            (2, 4000.0, 1, 1)
        );
        let ids: Vec<&str> = rate.orders.iter().map(|o| o.id.as_str()).collect();
        assert_eq!(ids, ["ev-a", "ev-b"]);
        let c = content(&rate);
        assert_eq!(c["BTC"]["CUP"], 2_500_000.0);
        assert_eq!(c["tasak"]["orders"][1]["signed"], false);
        assert_eq!(c["tasak"]["decimals"], 2);
    }

    #[test]
    fn without_orders_in_24h_the_last_rate_stays_marked() {
        let rows = vec![row(
            "a",
            NOW - 200_000,
            1000.0,
            100_000.0,
            Some(100_000.0),
            true,
            "EnZona",
        )];
        let rate = compute(&rows, &rules(), NOW).unwrap();
        // The window that ends at the last order, marked as empty since 24 h after it
        assert_eq!(
            (rate.to, rate.empty_since),
            (NOW - 200_000, Some(NOW - 200_000 + 86_400))
        );
        assert_eq!(rate.rate.btc, Some(1_000_000.0));
        assert_eq!(rate.count, 1);
        // The same result whatever the moment: nothing kept between runs
        assert_eq!(compute(&rows, &rules(), NOW + 3600).unwrap().rate, rate.rate);
    }

    #[test]
    fn no_orders_no_rate_and_rounding_like_javascript() {
        assert!(compute(&[], &rules(), NOW).is_none());
        // 763.125 → 763.13 (toFixed rounds ties up)
        let mut r = rules();
        r.decimals = 2;
        let rows = vec![row("a", NOW - 1, 763.125, 1e8, Some(1.0), true, "EnZona")];
        let rate = compute(&rows, &r, NOW).unwrap();
        assert_eq!(
            rate.rate,
            Pair {
                btc: Some(763.13),
                usd: Some(763.13)
            }
        );
        let a = api(&rate, NOW, None, None);
        assert_eq!(a.sat, Some(0.0000076313));
        r.decimals = 0;
        assert_eq!(compute(&rows, &r, NOW).unwrap().rate.btc, Some(763.0));
    }
}
