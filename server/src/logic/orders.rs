//! Mostro orders (kind 38383, NIP-69; shared/orders.js): parsing, choice between versions, trades and
//! order book. Signatures are verified before, when the events are stored.

use super::RawEvent;
use super::js;
use super::payment_methods::{NO_METHOD, PmLists, order_matches_pm, pm_key, pm_list_for};
use super::rates::Market;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashSet;

/// How the order was priced, from its newest pending version: the only one that says it
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Origin {
    pub fixed: bool,
    pub premium: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    /// node:d, the same order across its versions
    pub key: String,
    pub node: String,
    /// The node's name from the `y` tag, if any
    pub node_name: Option<String>,
    /// Id of the event of this version
    pub id: String,
    pub ts: i64,
    pub status: String,
    pub side: String,
    pub fiat: String,
    pub fa: Vec<f64>,
    pub amt: f64,
    pub premium: f64,
    pub expires_at: f64,
    pub pm: Vec<String>,
    pub pm_keys: Vec<String>,
    /// Set by `current_order`
    pub origin: Option<Origin>,
    pub taken_at: Option<i64>,
}

/// Order of an event, or None if it lacks d, s or f, or their value is empty
pub fn parse_order(ev: &RawEvent, lists: &PmLists) -> Option<Order> {
    let first = |name: &str| ev.tag(name).and_then(|v| v.first()).map(String::as_str);
    let required = |name: &str| first(name).filter(|v| !v.is_empty());
    let (d, s, f) = (required("d")?, required("s")?, required("f")?);
    let fiat = f.to_uppercase();
    let pm: Vec<String> = ev
        .tag("pm")
        .unwrap_or_default()
        .iter()
        .filter(|m| !m.is_empty())
        .cloned()
        .collect();
    let list = pm_list_for(lists, &fiat);
    let mut pm_keys: Vec<String> = Vec::new();
    for raw in &pm {
        let k = pm_key(raw, &list);
        if !pm_keys.contains(&k) {
            pm_keys.push(k);
        }
    }
    if pm_keys.is_empty() {
        pm_keys.push(NO_METHOD.to_string());
    }
    // `Number(x || 0)`: a missing or empty value is 0
    let number = |name: &str| js::number(Some(first(name).filter(|v| !v.is_empty()).unwrap_or("0")));
    Some(Order {
        key: format!("{}:{d}", ev.pubkey),
        node: ev.pubkey.clone(),
        node_name: ev.tag("y").and_then(|v| v.get(1)).filter(|n| !n.is_empty()).cloned(),
        id: ev.id.clone(),
        ts: ev.created_at,
        status: s.to_lowercase(),
        side: first("k").unwrap_or("").to_lowercase(),
        fiat,
        fa: ev
            .tag("fa")
            .unwrap_or_default()
            .iter()
            .map(|v| js::number(Some(v)))
            .collect(),
        amt: number("amt"),
        premium: number("premium"),
        expires_at: number("expires_at"),
        pm,
        pm_keys,
        origin: None,
        taken_at: None,
    })
}

/// Order of the states to break ties between events with the same created_at
fn rank(status: &str) -> u8 {
    match status {
        "pending" => 0,
        "success" | "canceled" | "expired" => 2,
        _ => 1,
    }
}

/// Whether version `a` of an order replaces `b`: the newest; with the same created_at, the most
/// advanced state and, if still tied, the greater id (so every visitor picks the same one)
pub fn newer_version(a: &Order, b: &Order) -> bool {
    if a.ts != b.ts {
        a.ts > b.ts
    } else if rank(&a.status) != rank(&b.status) {
        rank(&a.status) > rank(&b.status)
    } else {
        js::cmp(&a.id, &b.id) == Ordering::Greater
    }
}

/// Current state of an order from every version seen, whatever order they arrived in: the newest
/// version, with `origin` from the newest pending version before it, and `taken_at`, the time of its
/// first in-progress version. None without versions
pub fn current_order(versions: &[Order]) -> Option<Order> {
    let mut cur = 0;
    for (i, v) in versions.iter().enumerate().skip(1) {
        if newer_version(v, &versions[cur]) {
            cur = i;
        }
    }
    let current = versions.get(cur)?;
    let mut pending: Option<&Order> = None;
    let mut taken_at: Option<i64> = None;
    for (i, v) in versions.iter().enumerate() {
        if i != cur && v.status == "pending" && newer_version(current, v) && pending.is_none_or(|p| newer_version(v, p))
        {
            pending = Some(v);
        }
        if v.status == "in-progress" && taken_at.is_none_or(|t| v.ts < t) {
            taken_at = Some(v.ts);
        }
    }
    Some(Order {
        origin: pending.map(|p| Origin {
            fixed: p.amt > 0.0,
            premium: p.premium,
        }),
        taken_at,
        ..current.clone()
    })
}

/// What the visitor selected: a currency, some nodes and some payment methods
#[derive(Debug, Clone, Default)]
pub struct Filters {
    pub fiat: String,
    pub nodes: HashSet<String>,
    pub pm_sel: HashSet<String>,
}

/// Orders with a status that pass the filters
pub fn select_orders<'a>(orders: &'a [Order], status: &str, f: &Filters) -> impl Iterator<Item = &'a Order> {
    let status = status.to_string();
    let f = f.clone();
    orders.iter().filter(move |o| {
        o.status == status && o.fiat == f.fiat && f.nodes.contains(&o.node) && order_matches_pm(o, &f.pm_sel)
    })
}

/// Price of a completed order in currency per BTC, straight from the event
pub fn fiat_per_btc(o: &Order) -> f64 {
    o.fa[0] / (o.amt / 1e8)
}

/// Moment whose BTC/USD converts an order to USD: when it was taken, which is when Mostro fixes its sats
/// (its in-progress version); if that wasn't seen, when it was completed
pub fn priced_at(o: &Order) -> i64 {
    o.taken_at.unwrap_or(o.ts)
}

/// Whether a completed order is a trade the rate can use: one amount in currency and sats above zero
pub fn is_trade(o: &Order) -> bool {
    o.fa.len() == 1 && o.fa[0] > 0.0 && o.amt > 0.0
}

/// A completed order as the rate uses it
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trade {
    #[serde(default)]
    pub key: String,
    pub id: String,
    pub ts: i64,
    pub price: f64,
    /// Amount of currency it moved: its weight in the rate
    pub size: f64,
    #[serde(default)]
    pub side: String,
    #[serde(default)]
    pub premium: f64,
    #[serde(default)]
    pub origin: Option<Origin>,
}

/// Completed orders as trades, oldest first (ties by event id). `to_price(fiat_per_btc, order)`
/// converts to the chosen unit (in USD, with the BTC/USD of that order); trades it cannot convert
/// (None) are left out
pub fn get_trades(orders: &[Order], filters: &Filters, to_price: impl Fn(f64, &Order) -> Option<f64>) -> Vec<Trade> {
    let mut trades: Vec<Trade> = select_orders(orders, "success", filters)
        .filter(|o| is_trade(o))
        .filter_map(|o| {
            Some(Trade {
                key: o.key.clone(),
                id: o.id.clone(),
                ts: o.ts,
                price: to_price(fiat_per_btc(o), o)?,
                size: o.fa[0],
                side: o.side.clone(),
                premium: o.premium,
                origin: o.origin,
            })
        })
        .collect();
    trades.sort_by(|a, b| a.ts.cmp(&b.ts).then_with(|| js::cmp(&a.id, &b.id)));
    trades
}

/// An open order in the book
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookOrder {
    pub key: String,
    pub id: String,
    pub node: String,
    pub ts: i64,
    pub side: String,
    pub fixed: bool,
    pub market: Option<Market>,
    pub price: Option<f64>,
    pub size: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Book {
    pub asks: Vec<BookOrder>,
    pub bids: Vec<BookOrder>,
}

/// Open orders not expired. Fixed price comes from the event; market price from `market(node)` (the
/// node's market price, or None) plus the premium. Without it the order stays, with price None, after
/// the priced ones. `to_price(fiat_per_btc)` converts to the unit
pub fn get_book(
    orders: &[Order],
    filters: &Filters,
    now: f64,
    market: impl Fn(&str) -> Option<Market>,
    to_price: impl Fn(f64) -> Option<f64>,
) -> Book {
    let mut out = Vec::new();
    for o in select_orders(orders, "pending", filters) {
        if js::truthy(o.expires_at) && o.expires_at < now {
            continue;
        }
        let Some(&last) = o.fa.last() else { continue };
        // Not `last <= 0.0` alone: NaN doesn't pass either
        if last.is_nan() || last <= 0.0 {
            continue;
        }
        let fixed = o.amt > 0.0;
        let m = if fixed { None } else { market(&o.node) };
        let price = if fixed {
            Some(o.fa[0] / (o.amt / 1e8))
        } else {
            m.as_ref().map(|m| m.fiat_per_btc / (1.0 - o.premium / 100.0))
        };
        out.push(BookOrder {
            key: o.key.clone(),
            id: o.id.clone(),
            node: o.node.clone(),
            ts: o.ts,
            side: o.side.clone(),
            fixed,
            market: m,
            price: price.and_then(&to_price),
            size: last,
        });
    }
    // Without price last; same price: the newest first and then by event id, so it doesn't depend on
    // the arrival order
    let by = |dir: f64| {
        move |a: &BookOrder, b: &BookOrder| {
            a.price
                .is_none()
                .cmp(&b.price.is_none())
                .then_with(|| match (a.price, b.price) {
                    (Some(x), Some(y)) => (dir * (x - y)).partial_cmp(&0.0).unwrap_or(Ordering::Equal),
                    _ => Ordering::Equal,
                })
                .then_with(|| b.ts.cmp(&a.ts))
                .then_with(|| js::cmp(&a.id, &b.id))
        }
    };
    let (mut asks, mut bids): (Vec<_>, Vec<_>) = (Vec::new(), Vec::new());
    for o in out {
        match o.side.as_str() {
            "sell" => asks.push(o),
            "buy" => bids.push(o),
            _ => {}
        }
    }
    asks.sort_by(by(1.0));
    bids.sort_by(by(-1.0));
    Book { asks, bids }
}

/// Currency with most completed orders (or, if none, with most orders); None without orders
pub fn most_used_fiat(orders: &[Order]) -> Option<String> {
    let mut fiats: Vec<&str> = orders.iter().map(|o| o.fiat.as_str()).collect();
    fiats.sort_by(|a, b| js::cmp(a, b));
    fiats.dedup();
    let score = |f: &str| -> u64 {
        orders
            .iter()
            .filter(|o| o.fiat == f)
            .map(|o| if o.status == "success" { 1000 } else { 1 })
            .sum()
    };
    let mut best = *fiats.first()?;
    for f in &fiats[1..] {
        if score(f) > score(best) {
            best = f;
        }
    }
    Some(best.to_string())
}
