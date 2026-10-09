//! Time zones and chart periods (shared/time.js). Charts work in UTC: times are shifted to the
//! configured zone and then treated as UTC ("chart time"). Times are f64 seconds, like JavaScript's.

use chrono::{DateTime, Datelike, NaiveDate, Offset, TimeZone};
use chrono_tz::Tz;

pub const HOUR: f64 = 3600.0;
pub const DAY: f64 = 86400.0;
pub const WEEK: f64 = 7.0 * DAY;
/// Identifiers only: months and years follow the calendar, not a duration
pub const MONTH: f64 = 30.0 * DAY;
pub const YEAR: f64 = 365.0 * DAY;
pub const TIMEFRAMES: [f64; 6] = [HOUR, 4.0 * HOUR, DAY, WEEK, MONTH, YEAR];
/// 1/1/1970 was a Thursday: weeks start on Monday 5/1/1970
const MONDAY: f64 = 4.0 * DAY;

/// Offset of a time zone at a moment, in seconds (−14400 for UTC−4), with the IANA database (the
/// browser's Intl uses the same one)
pub fn tz_offset(ts: f64, tz: &Tz) -> f64 {
    let Some(utc) = DateTime::from_timestamp(ts.floor() as i64, 0) else {
        return 0.0;
    };
    tz.offset_from_utc_datetime(&utc.naive_utc()).fix().local_minus_utc() as f64
}

pub fn to_chart_time(ts: f64, tz: &Tz) -> f64 {
    ts + tz_offset(ts, tz)
}

/// `Date.UTC(year, month, 1) / 1000`, with JavaScript's month overflow (month 12 = January next year)
fn utc_month_start(year: i32, month: i32) -> f64 {
    let (y, m) = (year + month.div_euclid(12), month.rem_euclid(12) as u32 + 1);
    NaiveDate::from_ymd_opt(y, m, 1).map_or(f64::NAN, |d| {
        d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp() as f64
    })
}

/// UTC year and month (0-based) of a time, as `new Date(time * 1000)` (milliseconds truncated)
fn utc_year_month(time: f64) -> (i32, i32) {
    match DateTime::from_timestamp_millis((time * 1000.0).trunc() as i64) {
        Some(d) => (d.year(), d.month0() as i32),
        None => (1970, 0),
    }
}

/// Start of the period that contains a chart time
pub fn period_start(time: f64, tf: f64) -> f64 {
    if tf == MONTH || tf == YEAR {
        let (y, m) = utc_year_month(time);
        return utc_month_start(y, if tf == MONTH { m } else { 0 });
    }
    if tf == WEEK {
        return ((time - MONDAY) / WEEK).floor() * WEEK + MONDAY;
    }
    (time / tf).floor() * tf
}

/// Start of the next period
pub fn next_period(start: f64, tf: f64) -> f64 {
    if tf == MONTH || tf == YEAR {
        let (y, m) = utc_year_month(start);
        return utc_month_start(y + i32::from(tf == YEAR), m + i32::from(tf == MONTH));
    }
    start + tf
}

/// Periods without orders between consecutive period starts
pub fn empty_periods(starts: &[f64], tf: f64) -> Vec<f64> {
    let mut out = Vec::new();
    for pair in starts.windows(2) {
        let mut t = next_period(pair[0], tf);
        while t < pair[1] {
            out.push(t);
            t = next_period(t, tf);
        }
    }
    out
}
