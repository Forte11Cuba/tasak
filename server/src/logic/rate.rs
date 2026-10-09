//! Tasa K, candles and chart points (shared/rate.js). Trades are sorted oldest first.

use super::js;
use super::orders::Trade;
use super::time::{empty_periods, next_period, period_start, to_chart_time};
use chrono_tz::Tz;
use serde::Serialize;
use std::collections::HashMap;

/// The Tasa K always covers the last 24 hours
pub const WINDOW: f64 = 24.0 * 3600.0;

/// Volume-weighted price: each order weighs by the amount of currency it moved
pub fn weighted_price<'a>(trades: impl IntoIterator<Item = &'a Trade>) -> Option<f64> {
    let (mut vol, mut pv) = (0.0, 0.0);
    for t in trades {
        vol += t.size;
        pv += t.price * t.size;
    }
    js::truthy(vol).then(|| pv / vol)
}

fn in_window(trades: &[Trade], now: f64) -> Vec<&Trade> {
    trades
        .iter()
        .filter(|t| t.ts as f64 > now - WINDOW && t.ts as f64 <= now)
        .collect()
}

fn volume(trades: &[&Trade]) -> f64 {
    trades.iter().fold(0.0, |a, t| a + t.size)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TasaK {
    pub rate: Option<f64>,
    /// The previous 24 h, to compare
    pub previous: Option<f64>,
    pub volume: f64,
    pub count: usize,
    /// Ids of the orders used, so anyone can recompute it
    pub ids: Vec<String>,
}

/// Tasa K at `now`: orders in (now − 24 h, now]
pub fn tasa_k(trades: &[Trade], now: f64) -> TasaK {
    let inside = in_window(trades, now);
    let before = trades
        .iter()
        .filter(|t| t.ts as f64 > now - 2.0 * WINDOW && t.ts as f64 <= now - WINDOW);
    TasaK {
        rate: weighted_price(inside.iter().copied()),
        previous: weighted_price(before),
        volume: volume(&inside),
        count: inside.len(),
        ids: inside.iter().map(|t| t.id.clone()).collect(),
    }
}

/// How an order was priced: "market", "fixed" or None if unknown. The pending version says it;
/// without it, a premium other than 0 means market price (Mostro rejects a premium with fixed sats)
pub fn price_kind(t: &Trade) -> Option<&'static str> {
    match t.origin {
        Some(o) => Some(if o.fixed { "fixed" } else { "market" }),
        None => js::truthy(t.premium).then_some("market"),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Side {
    pub rate: Option<f64>,
    pub count: usize,
    pub volume: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Breakdown {
    pub buy: Side,
    pub sell: Side,
    pub market: usize,
    pub fixed: usize,
    pub unknown: usize,
    /// Volume-weighted premium of the market orders
    pub premium: Option<f64>,
}

/// Breakdown of the Tasa K's window, only as information (the rate doesn't change)
pub fn rate_breakdown(trades: &[Trade], now: f64) -> Breakdown {
    let inside = in_window(trades, now);
    let side = |s: &str| {
        let of: Vec<&Trade> = inside.iter().copied().filter(|t| t.side == s).collect();
        Side {
            rate: weighted_price(of.iter().copied()),
            count: of.len(),
            volume: volume(&of),
        }
    };
    let kinds: Vec<Option<&str>> = inside.iter().map(|t| price_kind(t)).collect();
    let market: Vec<&Trade> = inside
        .iter()
        .zip(&kinds)
        .filter(|(_, k)| **k == Some("market"))
        .map(|(t, _)| *t)
        .collect();
    let vol = volume(&market);
    let premium = js::truthy(vol).then(|| {
        market
            .iter()
            .fold(0.0, |a, t| a + t.origin.map_or(t.premium, |o| o.premium) * t.size)
            / vol
    });
    Breakdown {
        buy: side("buy"),
        sell: side("sell"),
        market: market.len(),
        fixed: kinds.iter().filter(|k| **k == Some("fixed")).count(),
        unknown: kinds.iter().filter(|k| k.is_none()).count(),
        premium,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Candle {
    pub time: f64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub vol: f64,
    /// Price × volume
    pub pv: f64,
}

/// Groups the trades by period: OHLC candle, volume and price × volume, in the order they appear
pub fn build_candles(trades: &[Trade], tf: f64, tz: &Tz) -> Vec<Candle> {
    let mut candles: Vec<Candle> = Vec::new();
    let mut index: HashMap<u64, usize> = HashMap::new();
    for t in trades {
        let key = period_start(to_chart_time(t.ts as f64, tz), tf);
        let i = *index.entry(key.to_bits()).or_insert_with(|| {
            candles.push(Candle {
                time: key,
                open: t.price,
                high: t.price,
                low: t.price,
                close: t.price,
                vol: 0.0,
                pv: 0.0,
            });
            candles.len() - 1
        });
        let c = &mut candles[i];
        c.high = js::max(c.high, t.price);
        c.low = js::min(c.low, t.price);
        c.close = t.price;
        c.vol += t.size;
        c.pv += t.price * t.size;
    }
    candles
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Moving {
    pub avg: f64,
    pub n: usize,
    pub vol: f64,
}

/// Weighted price of the 24 h before each end (chart times, ascending), or None when there are no
/// orders in that window
pub fn moving_weighted(ends: &[f64], trades: &[Trade], tz: &Tz) -> Vec<Option<Moving>> {
    let times: Vec<f64> = trades.iter().map(|t| to_chart_time(t.ts as f64, tz)).collect();
    let (mut i, mut j, mut vol, mut pv) = (0, 0, 0.0, 0.0);
    let mut out = Vec::with_capacity(ends.len());
    for &end in ends {
        while i < trades.len() && times[i] <= end {
            vol += trades[i].size;
            pv += trades[i].price * trades[i].size;
            i += 1;
        }
        while j < i && times[j] <= end - WINDOW {
            vol -= trades[j].size;
            pv -= trades[j].price * trades[j].size;
            j += 1;
        }
        out.push((j < i).then(|| Moving {
            avg: pv / vol,
            n: i - j,
            vol,
        }));
    }
    out
}

/// A point of the chart: one order or one period
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub time: f64,
    pub value: Option<f64>,
    pub vol: f64,
    pub n: usize,
    pub avg: Option<f64>,
    pub avg_n: Option<usize>,
    pub avg_vol: Option<f64>,
    /// A period without orders (its previous 24 h may still have an average)
    pub empty: bool,
    /// The order of the point (one per order)
    pub key: Option<String>,
    pub candle: Option<Candle>,
}

/// Points of the chart: one per order (tf = 0) or one per period, with the weighted average of the
/// 24 h before each one (after each order, or at the close of each period, never after `now`).
/// `with_empty` adds the periods without orders
pub fn chart_points(trades: &[Trade], tf: f64, tz: &Tz, now: f64, with_empty: bool) -> Vec<Point> {
    let blank = |time: f64| Point {
        time,
        value: None,
        vol: 0.0,
        n: 0,
        avg: None,
        avg_n: None,
        avg_vol: None,
        empty: false,
        key: None,
        candle: None,
    };
    let mut points: Vec<Point>;
    if tf != 0.0 {
        points = build_candles(trades, tf, tz)
            .into_iter()
            .map(|c| Point {
                value: Some(c.pv / c.vol),
                vol: c.vol,
                candle: Some(c.clone()),
                ..blank(c.time)
            })
            .collect();
        for t in trades {
            let time = period_start(to_chart_time(t.ts as f64, tz), tf);
            if let Some(p) = points.iter_mut().find(|p| p.time == time) {
                p.n += 1;
            }
        }
        if with_empty {
            let starts: Vec<f64> = points.iter().map(|p| p.time).collect();
            for time in empty_periods(&starts, tf) {
                points.push(Point {
                    empty: true,
                    ..blank(time)
                });
            }
            points.sort_by(|a, b| a.time.total_cmp(&b.time));
        }
    } else {
        // The chart needs unique, increasing times
        let mut last = 0.0;
        points = trades
            .iter()
            .map(|t| {
                let time = js::max(to_chart_time(t.ts as f64, tz), last + 1.0);
                last = time;
                Point {
                    value: Some(t.price),
                    vol: t.size,
                    n: 1,
                    key: Some(t.key.clone()),
                    ..blank(time)
                }
            })
            .collect();
    }
    let now_chart = to_chart_time(now, tz);
    let ends: Vec<f64> = points
        .iter()
        .map(|p| {
            if tf != 0.0 {
                js::min(next_period(p.time, tf), now_chart)
            } else {
                p.time
            }
        })
        .collect();
    for (p, w) in points.iter_mut().zip(moving_weighted(&ends, trades, tz)) {
        if let Some(w) = w {
            p.avg = Some(w.avg);
            p.avg_n = Some(w.n);
            p.avg_vol = Some(w.vol);
        }
    }
    points
}
