import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newerVersion, nextVersion, mostUsedFiat } from '../orders.js';
import { expected, loadOrders, viewOf } from './data.js';

test('chosen version and fields of every order', () => {
  const orders = loadOrders().sort((a, b) => a.key < b.key ? -1 : 1);
  const fields = ({ key, ev, ts, status, side, fiat, fa, amt, premium, expiresAt, pm, pmKeys, origin }) =>
    ({ key, id: ev.id, ts, status, side, fiat, fa, amt, premium, expiresAt, pm, pmKeys, origin: origin ?? null });
  assert.deepEqual(orders.map(fields), expected.orders);
});

test('tie-break between versions of an order (expected.json)', () => {
  for (const { a, b, wins } of expected.cases.versions) {
    const v = ([ts, status, id]) => ({ ts, status, ev: { id } });
    assert.equal(newerVersion(v(a), v(b)), wins, JSON.stringify({ a, b }));
  }
});

test('the pending version is kept as the origin of the order', () => {
  const pending = { ts: 1, status: 'pending', amt: 0, premium: 3, ev: { id: 'a' } };
  const taken = nextVersion(pending, { ts: 2, status: 'in-progress', amt: 5000, premium: 3, ev: { id: 'b' } });
  assert.deepEqual(taken.origin, { fixed: false, premium: 3 });
  const done = nextVersion(taken, { ts: 3, status: 'success', amt: 5000, premium: 3, ev: { id: 'c' } });
  assert.deepEqual(done.origin, { fixed: false, premium: 3 });
  assert.equal(nextVersion(done, pending), null);
});

test('currency chosen without FIAT: the one with most completed orders', () => {
  assert.equal(mostUsedFiat(loadOrders()), expected.view.fiat);
  assert.equal(mostUsedFiat([]), null);
});

test('order book per currency and unit', () => {
  const orders = loadOrders();
  const row = o => ({ key: o.key, price: o.price, size: o.size, fixed: o.fixed });
  for (const [fiat, c] of Object.entries(expected.currencies)) {
    for (const [unit, u] of Object.entries(c.units)) {
      const { book } = viewOf(orders, fiat, unit);
      assert.deepEqual({ asks: book.asks.map(row), bids: book.bids.map(row) }, u.book, `${fiat}/${unit}`);
    }
  }
});
