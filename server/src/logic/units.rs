//! Units of the price (shared/units.js): currency per USD, per BTC or per sat. Prices are kept in
//! currency per BTC and converted at the end; currency/sat comes only from the event.

use super::js;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unit {
    Usd,
    Btc,
    Sat,
}

impl Unit {
    /// "usd", "btc" or "sat", as the site names them
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "usd" => Some(Self::Usd),
            "btc" => Some(Self::Btc),
            "sat" => Some(Self::Sat),
            _ => None,
        }
    }
}

/// Converts currency per BTC to a unit; for USD it needs the BTC/USD of that moment (None if unknown)
pub fn to_unit(fiat_per_btc: f64, unit: Unit, btc_usd: Option<f64>) -> Option<f64> {
    match unit {
        Unit::Btc => Some(fiat_per_btc),
        Unit::Sat => Some(fiat_per_btc / 1e8),
        Unit::Usd => btc_usd.filter(|&b| js::truthy(b)).map(|b| fiat_per_btc / b),
    }
}

/// BTC/USD of a moment from hourly closes (hour start -> close): that hour or the previous one
pub fn hourly_close(closes: &HashMap<i64, f64>, ts: i64) -> Option<f64> {
    let h = ts.div_euclid(3600) * 3600;
    closes.get(&h).or_else(|| closes.get(&(h - 3600))).copied()
}
