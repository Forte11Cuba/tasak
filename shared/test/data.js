// Test data: the fixtures, the reference values of the site before restructuring (expected.json)
// and the hand-written cases (cases.json), plus the site's state rebuilt with shared/.
import { readFileSync } from 'node:fs';
import { parseOrder, nextVersion, getTrades, getBook } from '../orders.js';
import { pmListFor, pmStats, hiddenSet, defaultPmSelection } from '../payment-methods.js';
import { toUnit, hourlyClose } from '../units.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const json = path => JSON.parse(read(path));

export const expected = json('./expected.json');
export const cases = json('./cases.json');
export const config = json('./fixtures/config.json');
export const now = expected.now;
export const tz = config.timeZone;
export const nodes = new Set(config.mostros);
const events = json('./fixtures/events.json');
const btcusd = new Map(Object.entries(json('./fixtures/btcusd.json')).map(([t, close]) => [Number(t), close]));
const yadio = json('./fixtures/yadio.json');

// Payment methods of the Mostro app: a classic script that sets window.MOSTRO_PAYMENT_METHODS
const win = {};
new Function('window', read('../../web/vendor/mostro-payment-methods.js'))(win);
export const PM_LISTS = win.MOSTRO_PAYMENT_METHODS;
export const pmList = fiat => pmListFor(PM_LISTS, fiat);

// Orders as the site keeps them, in the same order: the fake relay serves the events newest first
export function loadOrders() {
  const seen = new Set();
  const orders = new Map();
  for (const ev of [...events].sort((a, b) => b.created_at - a.created_at)) {
    if (ev.kind !== 38383 || !nodes.has(ev.pubkey) || seen.has(ev.id)) continue;
    seen.add(ev.id);
    const o = parseOrder(ev, pmList);
    if (!o) continue;
    const v = nextVersion(orders.get(o.key), o);
    if (v) orders.set(o.key, v);
  }
  return [...orders.values()];
}

// What the site shows for a currency and unit with the default payment methods
export function viewOf(orders, fiat, unit) {
  const keys = pmStats(orders, { fiat, nodes, now }).map(s => s.key);
  const pmSel = defaultPmSelection(keys, hiddenSet(config.hiddenPaymentMethods));
  const filters = { fiat, nodes, pmSel };
  // BTC/USD: the hourly Coinbase close; without it, Yadio's current price (approximate)
  let approx = false;
  const btcAt = ts => {
    const close = hourlyClose(btcusd, ts);
    if (close != null) return close;
    if (ts < now - 3 * 3600) approx = true;
    return yadio.BTC;
  };
  const trades = getTrades(orders, filters, (fiatPerBtc, ts) => toUnit(fiatPerBtc, unit, btcAt(ts)));
  const ref = yadio.USD?.[fiat] ?? (fiat === 'USD' ? 1 : null);
  const book = getBook(orders, filters, {
    now, market: ref && yadio.BTC ? ref * yadio.BTC : null, toPrice: p => toUnit(p, unit, yadio.BTC),
  });
  return { pmSel, trades, book, approx };
}
