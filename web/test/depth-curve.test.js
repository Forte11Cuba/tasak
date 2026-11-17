import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depthCurve, niceStep, SPAN } from '../js/depth-curve.js';

const o = (key, price, size, fa = [size]) => ({ key, price, size, fa });
const at = (curve, x) => curve.points.find(p => Math.abs(p.x - x) < curve.step / 2);

test('niceStep rounds up to 1, 2 or 5 × 10ⁿ', () => {
  assert.deepEqual(niceStep(1.131), { m: 2, e: 0 });
  assert.deepEqual(niceStep(2), { m: 2, e: 0 });
  assert.deepEqual(niceStep(6), { m: 1, e: 1 });
  assert.deepEqual(niceStep(0.0004), { m: 5, e: -4 });
  assert.deepEqual(niceStep(40000), { m: 5, e: 4 });
});

test('without orders, or without priced ones, there are no points', () => {
  assert.deepEqual(depthCurve({ asks: [], bids: [] }).points, []);
  const c = depthCurve({ asks: [o('a', null, 100)], bids: [o('b', null, 50)] }, { center: 1000 });
  assert.equal(c.points.length, 0);
  assert.equal(c.noPrice, 2);
});

test('cumulative amounts from the best price outwards, on a uniform grid', () => {
  const asks = [o('a1', 1010, 100), o('a2', 1050, 200), o('a3', 1100, 300)];
  const bids = [o('b1', 990, 10), o('b2', 950, 20), o('b3', 900, 30)];
  const c = depthCurve({ asks, bids }, { center: 1000 });
  assert.equal(c.step, 1);
  assert.equal(c.rate, 1000);
  // Equal steps: the price axis is linear
  for (let i = 1; i < c.points.length; i++) assert.equal(c.points[i].x - c.points[i - 1].x, 1);
  assert.equal(at(c, 1009).ask, null);
  assert.deepEqual(at(c, 1010).ask, { cum: 100, n: 1, order: asks[0] });
  assert.equal(at(c, 1060).ask.cum, 300);
  assert.equal(at(c, 1060).ask.order, asks[1]);
  assert.equal(at(c, 1100).ask.cum, 600);
  assert.equal(at(c, 991).bid, null);
  assert.equal(at(c, 990).bid.cum, 10);
  assert.equal(at(c, 950).bid.cum, 30);
  assert.equal(at(c, 899).bid.cum, 60);
  // The spread: nobody
  assert.deepEqual([at(c, 1000).bid, at(c, 1000).ask], [null, null]);
  assert.deepEqual(c.totals, { bid: { cum: 60, n: 3 }, ask: { cum: 600, n: 3 } });
  // Opens at ±20 %; the grid goes 5 % beyond that, or beyond the outermost orders
  assert.deepEqual(c.view, { from: 800, to: 1200 });
  assert.equal(c.points[0].x, 750);
  assert.equal(c.points.at(-1).x, 1250);
});

test('a crossed book overlaps both sides', () => {
  const c = depthCurve({ asks: [o('a', 910, 18000)], bids: [o('b', 951, 28000)] }, { center: 1000 });
  const p = at(c, 930);
  assert.equal(p.ask.cum, 18000);
  assert.equal(p.bid.cum, 28000);
});

test('without the rate, centred on the middle of the best prices, or on the only side', () => {
  const book = { asks: [o('a', 1100, 1)], bids: [o('b', 900, 1)] };
  assert.equal(depthCurve(book).center, 1000);
  assert.equal(depthCurve(book).rate, null);
  assert.equal(depthCurve({ asks: book.asks, bids: [] }).center, 1100);
});

test('orders out of scale are left out and counted; the step does not change', () => {
  const asks = [o('a1', 1010, 100), o('a2', 1e6, 5)];
  const bids = [o('b1', 990, 10), o('b2', 1000 / SPAN - 1, 7)];
  const c = depthCurve({ asks, bids }, { center: 1000 });
  assert.equal(c.outside, 2);
  assert.equal(c.step, 1);
  assert.deepEqual(c.totals, { bid: { cum: 10, n: 1 }, ask: { cum: 100, n: 1 } });
});

test('the initial view widens to show the best prices', () => {
  const c = depthCurve({ asks: [o('a', 1500, 1)], bids: [o('b', 990, 1)] }, { center: 1000 });
  assert.equal(c.view.from, 800);
  assert.equal(c.view.to, 1525);
});

test('ranges count by their maximum and are counted', () => {
  const c = depthCurve({ asks: [o('a', 1010, 130000, [19500, 130000])], bids: [] }, { center: 1000 });
  assert.equal(c.ranges, 1);
  assert.equal(c.totals.ask.cum, 130000);
});

test('small units: an exact grid', () => {
  const c = depthCurve({ asks: [o('a', 0.4012, 100)], bids: [o('b', 0.3988, 100)] }, { center: 0.4 });
  assert.equal(c.step, 0.0005);
  assert.ok(c.points.every(p => String(p.x).length < 10));
  assert.equal(at(c, 0.4015).ask.cum, 100);
  assert.equal(at(c, 0.3985).bid.cum, 100);
});
