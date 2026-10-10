import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weightedPrice, tasaK, lastTasaK, rateBreakdown, buildCandles, chartPoints, movingWeighted } from '../rate.js';
import { emptyPeriods, toChartTime, TIMEFRAMES } from '../time.js';
import { expected, cases, now, tz, loadOrders, viewOf } from './data.js';

const views = () => {
  const orders = loadOrders();
  return Object.entries(expected.currencies).flatMap(([fiat, c]) =>
    Object.entries(c.units).map(([unit, u]) => ({ name: `${fiat}/${unit}`, u, ...viewOf(orders, fiat, unit) })));
};

test('the FAQ example: 763,13', () => {
  const t = (price, size) => ({ price, size });
  assert.equal(weightedPrice([t(785, 1000), t(785, 1000), t(785, 1000), t(750, 5000)]), expected.cases.faqExample);
  assert.equal(expected.cases.faqExample.toFixed(2), '763.13');
});

test('tasaK: 24 h border and empty window', () => {
  for (const { now, trades, expected, note } of cases.tasaK) {
    const ts = trades.map(({ id, ...t }) => ({ ...t, ev: { id } }));
    assert.deepEqual(tasaK(ts, now), expected, note);
  }
});

test('lastTasaK: the rate of now or, with an empty window, the last one (cases.json)', () => {
  for (const { now, trades, expected, note } of cases.lastTasaK) {
    const ts = trades.map(({ id, ...t }) => ({ ...t, ev: { id } }));
    assert.deepEqual(lastTasaK(ts, now), expected, note);
  }
});

test('rateBreakdown: buy and sell, market and fixed', () => {
  for (const { now, trades, expected, note } of cases.rateBreakdown) {
    const ts = trades.map(({ id, ...t }) => ({ ...t, ev: { id } }));
    assert.deepEqual(rateBreakdown(ts, now), expected, note);
  }
});

test('rateBreakdown adds up to the Tasa K window', () => {
  for (const { name, trades } of views()) {
    const k = tasaK(trades, now), b = rateBreakdown(trades, now);
    assert.equal(b.buy.count + b.sell.count, k.count, name);
    assert.equal(b.market + b.fixed + b.unknown, k.count, name);
    assert.equal(b.buy.volume + b.sell.volume, k.volume, name);
  }
});

test('trades, Tasa K (24 h up to the last order) and the previous 24 h per currency and unit', () => {
  for (const { name, u, trades, approx } of views()) {
    assert.equal(approx, u.approximateUsd, name + ' approximate USD');
    assert.deepEqual(trades.map(t => ({ key: t.key, ts: t.ts, size: t.size, price: t.price, chartTime: toChartTime(t.ts, tz) })),
      u.trades, name + ' trades');
    const k = lastTasaK(trades, now);
    assert.deepEqual([k.to, k.rate, k.previous, k.count, k.volume], [u.rateTo, u.rate, u.previousRate, u.orders24h, u.volume24h], name);
    assert.equal(k.ids.length, k.count);
  }
});

test('candles and empty periods of every timeframe', () => {
  for (const { name, u, trades } of views()) {
    for (const tf of TIMEFRAMES) {
      const candles = buildCandles(trades, tf, tz).sort((a, b) => a.time - b.time);
      assert.deepEqual({ candles, emptyPeriods: emptyPeriods(candles.map(c => c.time), tf) }, u.candles[tf], `${name} ${tf}`);
    }
  }
});

test('chart points with the moving 24 h weighted average', () => {
  for (const { name, u, trades } of views()) {
    for (const tf of [0, ...TIMEFRAMES]) {
      const points = chartPoints(trades, { tf, tz, now, withEmpty: true }).map(p => ({ time: p.time, value: p.value ?? null,
        vol: p.vol, n: p.n, avg: p.avg ?? null, avgN: p.avgN ?? null, avgVol: p.avgVol ?? null, empty: !!p.empty,
        key: p.order?.key ?? null }));
      assert.deepEqual(points, u.points[tf], `${name} ${tf}`);
    }
  }
});

test('moving weighted average: 24 h border', () => {
  for (const { tz, trades, ends, expected, note } of cases.movingWeighted) {
    assert.deepEqual(movingWeighted(ends, trades.map(({ id, ...t }) => ({ ...t, ev: { id } })), tz), expected, note);
  }
});
