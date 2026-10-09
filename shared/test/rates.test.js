import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRates, currentRates, fiatPerUsd, marketPrice } from '../rates.js';
import { cases } from './data.js';

test('mostro-rates events: parsing and currency per USD (cases.json)', () => {
  for (const { note, event, expected: want, fiatPerUsd: perUsd } of cases.mostroRates.parse) {
    const r = parseRates(event);
    assert.deepEqual(r, want, note);
    for (const [fiat, v] of Object.entries(perUsd || {})) assert.equal(fiatPerUsd(r, fiat), v, `${note}: ${fiat}`);
  }
});

test('rates to use at each moment (cases.json)', () => {
  for (const { note, rates, now } of cases.mostroRates.current) {
    for (const [t, id] of now) assert.equal(currentRates(rates, t)?.id ?? null, id, `${note}: ${t}`);
  }
});

test('market price of a node: its rates, then the fallback (cases.json)', () => {
  for (const { note, own, fiat, now, fallback, expected: want } of cases.mostroRates.market) {
    assert.deepEqual(marketPrice(own, fiat, now, fallback), want, note);
  }
});
