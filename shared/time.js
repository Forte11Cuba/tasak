// Time zones and chart periods. Charts work in UTC: times are shifted to the configured zone and
// then treated as UTC ("chart time").

export const HOUR = 3600;
export const DAY = 86400;
export const WEEK = 7 * DAY;
export const MONTH = 30 * DAY;   // identifiers only: months and years follow the calendar, not a duration
export const YEAR = 365 * DAY;
export const TIMEFRAMES = [HOUR, 4 * HOUR, DAY, WEEK, MONTH, YEAR];
const MONDAY = 4 * DAY;   // 1/1/1970 was a Thursday: weeks start on Monday 5/1/1970

const formatters = new Map();
// Offset of a time zone at a moment, in seconds (−14400 for UTC−4). Read from the zone's calendar
// fields with formatToParts, so it does not depend on the zone of the process running it
export function tzOffset(ts, tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric',
      day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(tz, f);
  }
  const s = Math.floor(ts);
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(s * 1000))) p[type] = Number(value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - s;
}
export const toChartTime = (ts, tz) => ts + tzOffset(ts, tz);

// Start of the period that contains a chart time
export function periodStart(time, tf) {
  if (tf === MONTH || tf === YEAR) {
    const d = new Date(time * 1000);
    return Date.UTC(d.getUTCFullYear(), tf === MONTH ? d.getUTCMonth() : 0, 1) / 1000;
  }
  if (tf === WEEK) return Math.floor((time - MONDAY) / WEEK) * WEEK + MONDAY;
  return Math.floor(time / tf) * tf;
}

// Start of the next period
export function nextPeriod(start, tf) {
  if (tf === MONTH || tf === YEAR) {
    const d = new Date(start * 1000);
    return Date.UTC(d.getUTCFullYear() + (tf === YEAR), d.getUTCMonth() + (tf === MONTH), 1) / 1000;
  }
  return start + tf;
}

// Periods without orders between consecutive period starts
export function emptyPeriods(starts, tf) {
  const out = [];
  for (let i = 1; i < starts.length; i++) {
    for (let t = nextPeriod(starts[i - 1], tf); t < starts[i]; t = nextPeriod(t, tf)) out.push(t);
  }
  return out;
}
