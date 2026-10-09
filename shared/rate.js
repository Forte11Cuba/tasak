// Tasa K, candles and chart points. Trades are { ts, price, size, ev } sorted oldest first.
import { toChartTime, periodStart, nextPeriod, emptyPeriods } from './time.js';

// The Tasa K always covers the last 24 hours
export const WINDOW = 24 * 3600;

// Volume-weighted price: each order weighs by the amount of currency it moved
export function weightedPrice(trades) {
  let vol = 0, pv = 0;
  for (const t of trades) { vol += t.size; pv += t.price * t.size; }
  return vol ? pv / vol : null;
}

const inWindow24h = (trades, now) => trades.filter(t => t.ts > now - WINDOW && t.ts <= now);

// Tasa K at `now`: orders in (now − 24 h, now], the previous 24 h to compare, and the ids of the
// orders used, so anyone can recompute it
export function tasaK(trades, now) {
  const inWindow = inWindow24h(trades, now);
  const before = trades.filter(t => t.ts > now - 2 * WINDOW && t.ts <= now - WINDOW);
  return {
    rate: weightedPrice(inWindow),
    previous: weightedPrice(before),
    volume: inWindow.reduce((a, t) => a + t.size, 0),
    count: inWindow.length,
    ids: inWindow.map(t => t.ev.id),
  };
}

// The Tasa K to show at `now`: that of the last 24 h or, without orders in them, the last one there was
// (the window that ends at the last order), so the rate stays until there is a new order. Adds `to`,
// the end of its window, and `emptySince`: when the 24 h became empty (null while they have orders)
export function lastTasaK(trades, now) {
  const k = tasaK(trades, now);
  const last = trades.at(-1);
  if (k.count || !last || last.ts > now) return { ...k, to: now, emptySince: null };
  return { ...tasaK(trades, last.ts), to: last.ts, emptySince: last.ts + WINDOW };
}

// How an order was priced: 'market', 'fixed' or null if unknown. The pending version says it; without
// it, a premium other than 0 means market price, because Mostro rejects a premium with fixed sats.
export const priceKind = o => o.origin ? (o.origin.fixed ? 'fixed' : 'market') : o.premium ? 'market' : null;

// Breakdown of the Tasa K's window, only as information (the rate doesn't change): weighted price of
// the buy and sell orders, how many were at market or fixed price, and the volume-weighted premium of
// the market ones
export function rateBreakdown(trades, now) {
  const inWindow = inWindow24h(trades, now);
  const side = s => {
    const of = inWindow.filter(t => t.side === s);
    return { rate: weightedPrice(of), count: of.length, volume: of.reduce((a, t) => a + t.size, 0) };
  };
  const kinds = inWindow.map(priceKind);
  const market = inWindow.filter((t, i) => kinds[i] === 'market');
  const vol = market.reduce((a, t) => a + t.size, 0);
  return {
    buy: side('buy'),
    sell: side('sell'),
    market: market.length,
    fixed: kinds.filter(k => k === 'fixed').length,
    unknown: kinds.filter(k => k === null).length,
    premium: vol ? market.reduce((a, t) => a + (t.origin?.premium ?? t.premium) * t.size, 0) / vol : null,
  };
}

// Groups the trades by period: OHLC candle, volume and price × volume, in the order they appear
export function buildCandles(trades, tf, tz) {
  const buckets = new Map();
  for (const t of trades) {
    const key = periodStart(toChartTime(t.ts, tz), tf);
    let c = buckets.get(key);
    if (!c) buckets.set(key, c = { time: key, open: t.price, high: t.price, low: t.price, close: t.price, vol: 0, pv: 0 });
    c.high = Math.max(c.high, t.price);
    c.low = Math.min(c.low, t.price);
    c.close = t.price;
    c.vol += t.size;
    c.pv += t.price * t.size;
  }
  return [...buckets.values()];
}

// Weighted price of the 24 h before each end (chart times, ascending): { avg, n, vol } or null when
// there are no orders in that window
export function movingWeighted(ends, trades, tz) {
  const times = trades.map(t => toChartTime(t.ts, tz));
  const out = [];
  let i = 0, j = 0, vol = 0, pv = 0;
  for (const end of ends) {
    for (; i < trades.length && times[i] <= end; i++) { vol += trades[i].size; pv += trades[i].price * trades[i].size; }
    for (; j < i && times[j] <= end - WINDOW; j++) { vol -= trades[j].size; pv -= trades[j].price * trades[j].size; }
    out.push(j < i ? { avg: pv / vol, n: i - j, vol } : null);
  }
  return out;
}

// Points of the chart: one per order (tf = 0) or one per period, with the weighted average of the
// 24 h before each one (after each order, or at the close of each period, never after `now`).
// `withEmpty` adds the periods without orders: their previous 24 h may still have an average.
export function chartPoints(trades, { tf, tz, now, withEmpty = false }) {
  let points;
  if (tf) {
    points = buildCandles(trades, tf, tz).map(c => ({ ...c, value: c.pv / c.vol, n: 0 }));
    const byTime = new Map(points.map(p => [p.time, p]));
    for (const t of trades) byTime.get(periodStart(toChartTime(t.ts, tz), tf)).n++;
    if (withEmpty) {
      for (const time of emptyPeriods(points.map(p => p.time), tf)) points.push({ time, vol: 0, n: 0, empty: true });
      points.sort((a, b) => a.time - b.time);
    }
  } else {
    // The chart needs unique, increasing times
    let last = 0;
    points = trades.map(t => {
      const time = Math.max(toChartTime(t.ts, tz), last + 1);
      last = time;
      return { time, value: t.price, vol: t.size, n: 1, order: t };
    });
  }
  const nowChart = toChartTime(now, tz);
  const ends = points.map(p => tf ? Math.min(nextPeriod(p.time, tf), nowChart) : p.time);
  movingWeighted(ends, trades, tz).forEach((w, k) => {
    if (w) Object.assign(points[k], { avg: w.avg, avgN: w.n, avgVol: w.vol });
  });
  return points;
}
