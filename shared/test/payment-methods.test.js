import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pmKey, normPm, pmStats, hiddenSet, defaultPmSelection, orderMatchesPm } from '../payment-methods.js';
import { expected, config, nodes, now, pmList, loadOrders } from './data.js';

test('pmKey: the cases of expected.json', () => {
  for (const { text, fiat, method } of expected.cases.pmKey) {
    assert.equal(pmKey(text, pmList(fiat)), method, `${text} (${fiat})`);
  }
});

test('pmKey: Cash ≠ Cash App, and the longest method contained wins', () => {
  assert.equal(pmKey('Cash', ['Cash', 'Cash App']), 'Cash');
  assert.equal(pmKey('cash app', ['Cash', 'Cash App']), 'Cash App');
  assert.equal(pmKey('360 CUP de saldo móvil 📲', pmList('CUP')), 'Saldo móvil');
});

test('normPm ignores accents, case, emojis, flags and extra spaces', () => {
  assert.equal(normPm('  Saldo  MÓVIL 📲 🇨🇺 '), 'saldo movil');
});

test('payment methods of every order', () => {
  const byKey = new Map(loadOrders().map(o => [o.key, o]));
  for (const e of expected.orders) assert.deepEqual(byKey.get(e.key).pmKeys, e.pmKeys, e.key);
});

test('methods selected by default, per currency', () => {
  const orders = loadOrders();
  const hidden = hiddenSet(config.metodosOcultos);
  for (const [fiat, c] of Object.entries(expected.currencies)) {
    const keys = pmStats(orders, { fiat, nodes, now }).map(s => s.key);
    assert.deepEqual([...defaultPmSelection(keys, hidden)].sort(), c.activePaymentMethods, fiat);
  }
});

test('test orders only pass with «Pruebas» selected', () => {
  const o = { pmKeys: ['Pruebas', 'Efectivo'] };
  assert.equal(orderMatchesPm(o, new Set(['Efectivo'])), false);
  assert.equal(orderMatchesPm(o, new Set(['Pruebas'])), true);
});
