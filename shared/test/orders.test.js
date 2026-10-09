import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrder, newerVersion, currentOrder, mostUsedFiat, getBook, getTrades, pricedAt } from '../orders.js';
import { expected, cases, pmList, loadOrders, viewOf } from './data.js';

test('chosen version and fields of every order', () => {
  const orders = loadOrders().sort((a, b) => a.key < b.key ? -1 : 1);
  const fields = ({ key, ev, ts, status, side, fiat, fa, amt, premium, expiresAt, pm, pmKeys, origin }) =>
    ({ key, id: ev.id, ts, status, side, fiat, fa, amt, premium, expiresAt, pm, pmKeys, origin: origin ?? null });
  assert.deepEqual(orders.map(fields), expected.orders);
});

test('parsing an order event (cases.json)', () => {
  const fields = ({ key, node, nodeName, ev, ts, status, side, fiat, fa, amt, premium, expiresAt, pm, pmKeys }) =>
    ({ key, node, nodeName, id: ev.id, ts, status, side, fiat, fa, amt, premium, expiresAt, pm, pmKeys });
  for (const { note, event, expected: want } of cases.parseOrder) {
    const o = parseOrder(event, pmList);
    assert.deepEqual(o && fields(o), want, note);
  }
});

test('tie-break between versions of an order (expected.json)', () => {
  for (const { a, b, wins } of expected.cases.versions) {
    const v = ([ts, status, id]) => ({ ts, status, ev: { id } });
    assert.equal(newerVersion(v(a), v(b)), wins, JSON.stringify({ a, b }));
  }
});

// Every order of the arrays, for the arrival orders of the versions
const permutations = a => a.length < 2 ? [a] : a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map(p => [x, ...p]));

test('current state of an order from its versions, in any arrival order (cases.json)', () => {
  for (const { note, versions, expected: want } of cases.orderVersions) {
    const parsed = versions.map(([ts, status, id, amt, premium]) => ({ ts, status, amt, premium, ev: { id } }));
    for (const arrival of permutations(parsed)) {
      const o = currentOrder(arrival);
      assert.deepEqual({ id: o.ev.id, origin: o.origin, takenAt: o.takenAt }, want, `${note}: ${arrival.map(v => v.ev.id)}`);
    }
  }
});

test('USD at the moment each order was taken, or completed (cases.json)', () => {
  const { note, orders, btcUsd, expected: want } = cases.usdPerOrder;
  const os = orders.map(({ id, ...o }) => ({ ...o, key: id, ev: { id }, node: 'n1', status: 'success', fiat: 'CUP', pmKeys: ['X'] }));
  const trades = getTrades(os, { fiat: 'CUP', nodes: new Set(['n1']), pmSel: new Set(['X']) }, (p, o) => {
    const b = btcUsd[pricedAt(o)];
    return b ? p / b : null;
  });
  assert.deepEqual(trades.map(t => [t.key, t.price]), want, note);
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

test('order book with the market price of each node (cases.json)', () => {
  const { note, market, orders, expected: want } = cases.bookPerNode;
  const os = orders.map(({ id, ...o }) => ({ ...o, key: id, ev: { id }, status: 'pending', fiat: 'CUP', expiresAt: 0, pmKeys: ['X'] }));
  const book = getBook(os, { fiat: 'CUP', nodes: new Set(['n1', 'n2', 'n3']), pmSel: new Set(['X']) },
    { now: 100, market: node => market[node], toPrice: p => p });
  const row = o => [o.key, o.price, o.market?.from ?? null];
  assert.deepEqual({ asks: book.asks.map(row), bids: book.bids.map(row) }, want, note);
});
