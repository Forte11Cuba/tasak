import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tzOffset, periodStart, nextPeriod, emptyPeriods } from '../time.js';
import { expected, cases, tz } from './data.js';

test('periodStart and nextPeriod (expected.json)', () => {
  for (const { time, tf, start, next } of expected.cases.periods) {
    assert.equal(periodStart(time, tf), start, `periodStart(${time}, ${tf})`);
    assert.equal(nextPeriod(start, tf), next, `nextPeriod(${start}, ${tf})`);
  }
});

test('tzOffset: correct across DST changes, in several zones', () => {
  for (const { tz, ts, offset } of cases.tzOffset) assert.equal(tzOffset(ts, tz), offset, `${tz} ${ts}`);
});

test('tzOffset: same as the old site away from DST changes (its known bug is near them)', () => {
  const near = ts => [1772946000, 1793509200].some(c => Math.abs(ts - c) < 6 * 3600);
  for (const { ts, offset } of expected.cases.buggyOffsets.filter(o => !near(o.ts))) {
    assert.equal(tzOffset(ts, tz), offset, String(ts));
  }
});

test('emptyPeriods', () => {
  for (const { tf, starts, empty, note } of cases.emptyPeriods) assert.deepEqual(emptyPeriods(starts, tf), empty, note);
});
