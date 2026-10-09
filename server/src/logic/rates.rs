//! Prices of BTC from the nodes' `mostro-rates` events (kind 30078, d = mostro-rates; shared/rates.js):
//! every few minutes each node publishes the prices it uses for market orders, signed, as
//! {"BTC": {"USD": 82858.34, "CUP": 63800922.56, …}}, with an expiration.

use super::RawEvent;
use super::js;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::BTreeMap;

/// Validity when the event has no expiration tag: Mostro's default (2 × the 5 min interval)
const DEFAULT_TTL: f64 = 600.0;

/// How long Mostro keeps using its last prices when it can't refresh them (max_price_staleness_seconds,
/// 30 min by default): the event expires sooner, but the node still prices market orders with them
pub const STALE_LIMIT: f64 = 1800.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rates {
    #[serde(default)]
    pub node: String,
    pub id: String,
    pub ts: i64,
    pub expires_at: f64,
    #[serde(default)]
    pub source: Option<String>,
    /// Currency -> currency per BTC
    #[serde(default)]
    pub btc: BTreeMap<String, f64>,
}

/// Until when the node uses some rates: their expiration or STALE_LIMIT after publishing, the later
pub fn usable_until(r: &Rates) -> f64 {
    js::max(r.expires_at, r.ts as f64 + STALE_LIMIT)
}

/// The rates of a mostro-rates event, or None if it isn't one or its content is not valid
pub fn parse_rates(ev: &RawEvent) -> Option<Rates> {
    let is_rates = ev
        .tags
        .iter()
        .any(|t| t.first().map(String::as_str) == Some("d") && t.get(1).map(String::as_str) == Some("mostro-rates"));
    if ev.kind != 30078 || !is_rates {
        return None;
    }
    let content: serde_json::Value = serde_json::from_str(&ev.content).ok()?;
    let mut btc = BTreeMap::new();
    let entries: Vec<(String, &serde_json::Value)> = match content.get("BTC") {
        Some(serde_json::Value::Object(m)) => m.iter().map(|(k, v)| (k.clone(), v)).collect(),
        Some(serde_json::Value::Array(a)) => a.iter().enumerate().map(|(i, v)| (i.to_string(), v)).collect(),
        _ => Vec::new(),
    };
    for (fiat, v) in entries {
        if let Some(v) = v.as_f64().filter(|v| v.is_finite() && *v > 0.0) {
            btc.insert(fiat.to_uppercase(), v);
        }
    }
    if !btc.get("USD").is_some_and(|&v| js::truthy(v)) {
        return None;
    }
    let tag = |k: &str| ev.tag(k).and_then(|v| v.first()).map(String::as_str);
    let expiration = js::number(tag("expiration"));
    Some(Rates {
        node: ev.pubkey.clone(),
        id: ev.id.clone(),
        ts: ev.created_at,
        expires_at: if expiration > 0.0 {
            expiration
        } else {
            ev.created_at as f64 + DEFAULT_TTL
        },
        source: tag("source").filter(|s| !s.is_empty()).map(String::from),
        btc,
    })
}

/// Whether rates `a` replace `b` of the same node: the newest and, if tied, the greater id
pub fn newer_rates(a: &Rates, b: &Rates) -> bool {
    if a.ts != b.ts {
        a.ts > b.ts
    } else {
        js::cmp(&a.id, &b.id) == Ordering::Greater
    }
}

/// The rates to use at `now`: the newest published by then that the node still uses, or None
pub fn current_rates(list: &[Rates], now: f64) -> Option<&Rates> {
    let mut best: Option<&Rates> = None;
    for r in list {
        if (r.ts as f64) <= now && now < usable_until(r) && best.is_none_or(|b| newer_rates(r, b)) {
            best = Some(r);
        }
    }
    best
}

/// Currency per USD from some rates (USD itself is 1), or None if they don't have that currency
pub fn fiat_per_usd(rates: Option<&Rates>, fiat: &str) -> Option<f64> {
    if fiat == "USD" {
        return Some(1.0);
    }
    let r = rates?;
    let v = *r.btc.get(fiat)?;
    js::truthy(v).then(|| v / r.btc.get("USD").copied().unwrap_or(f64::NAN))
}

/// The market price of a node's orders and where it comes from
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Market {
    pub fiat_per_btc: f64,
    /// "node" (its mostro-rates) or "api" (Yadio's API, an estimate)
    pub from: String,
    #[serde(default)]
    pub expired: bool,
    /// The node's providers (the `source` tag)
    #[serde(default)]
    pub source: Option<String>,
}

/// Market price for the orders of a node: its own newest rates `own` while the node still uses them
/// (usable_until); otherwise `fallback` (currency per BTC from Yadio's API) or None
pub fn market_price(own: Option<&Rates>, fiat: &str, now: f64, fallback: Option<f64>) -> Option<Market> {
    if let Some(r) = own
        && let Some(&v) = r.btc.get(fiat)
        && js::truthy(v)
        && now < usable_until(r)
    {
        return Some(Market {
            fiat_per_btc: v,
            from: "node".into(),
            expired: now >= r.expires_at,
            source: r.source.clone(),
        });
    }
    let fallback = fallback.filter(|&f| js::truthy(f))?;
    Some(Market {
        fiat_per_btc: fallback,
        from: "api".into(),
        expired: false,
        source: own.and_then(|r| r.source.clone()),
    })
}

/// Whether a list of providers (the `source` tag, e.g. "coingecko,yadio") is Yadio alone
pub fn is_yadio_only(source: Option<&str>) -> bool {
    source == Some("yadio")
}
