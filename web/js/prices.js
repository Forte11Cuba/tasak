// Prices: the current ones (BTC/USD and currency per USD) from the nodes' mostro-rates or, as a
// fallback, Yadio's API; the hourly BTC/USD history from Coinbase; and the conversion of each price to
// the chosen unit.
import { UNITS, toUnit, hourlyClose } from '../shared/units.js';
import { currentRates, fiatPerUsd } from '../shared/rates.js';
import { state } from './state.js';

// Newest valid mostro-rates of the selected nodes: the prices each node publishes, signed, every few
// minutes, and uses for market orders. A visitor's clock may be behind the node's: «now» is never
// earlier than the newest rates.
export function nodeRates() {
  const list = [...state.nodeRates.values()].filter(r => state.nodeSel.has(r.node));
  return currentRates(list, Math.max(Date.now() / 1000, ...list.map(r => r.ts)));
}

// Current prices: { from: 'node' | 'api', rates?, btcUsd, fiatPerUsd(fiat) }, or null without either
export function currentPrices() {
  const r = nodeRates();
  if (r) return { from: 'node', rates: r, btcUsd: r.btc.USD, fiatPerUsd: f => fiatPerUsd(r, f) };
  const y = state.yadio;
  if (y?.BTC) return { from: 'api', btcUsd: y.BTC, fiatPerUsd: f => y.USD?.[f] ?? (f === 'USD' ? 1 : null) };
  return null;
}

// Yadio's API, only as a fallback: when no selected node has valid mostro-rates once a relay has
// answered (or after 15 s without any), at most every 5 minutes
const pageStart = Date.now();
let yadioAt = 0;
export async function ensurePrices() {
  if (nodeRates() || Date.now() - yadioAt < 5 * 60 * 1000) return;
  if (!state.live && Date.now() - pageStart < 15 * 1000) return;
  yadioAt = Date.now();
  try {
    // With a time limit: a blocked service must not hold the page's render
    const res = await fetch('https://api.yadio.io/exrates/USD', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    state.yadio = await res.json();
  } catch (e) { console.warn('Yadio', e); }
}

// Coinbase hourly candles (at most 300 per request) to convert each trade to USD.
// If a request fails, that stretch is not marked as loaded: it is retried on the next render,
// at most once a minute so as not to insist against a blocked service
export async function loadBtcHistory(fromTs) {
  if (fromTs >= state.btcLoadedFrom || Date.now() < state.btcRetryAt) return;
  const until = Math.min(state.btcLoadedFrom, Math.floor(Date.now() / 1000));
  const step = 300 * 3600;
  // From newest to oldest: what is loaded always stays contiguous up to `until`
  for (let end = until; end > fromTs - 3600; end -= step) {
    const start = Math.max(end - step, fromTs - 3600);
    const url = 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600' +
      `&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      for (const [time, , , , close] of await res.json()) state.btcusd.set(time, close);
      state.btcLoadedFrom = Math.max(start + 3600, fromTs);
    } catch (e) {
      console.warn('Coinbase', e);
      state.btcRetryAt = Date.now() + 60 * 1000;
      return;
    }
  }
  state.btcLoadedFrom = fromTs;
}

export const btcSpot = () => currentPrices()?.btcUsd ?? null;
// BTC/USD of a moment: the Coinbase hourly close; without it, the current price (approximate)
export function btcAt(ts) {
  const p = hourlyClose(state.btcusd, ts);
  if (p != null) return p;
  if (ts < Date.now() / 1000 - 3 * 3600) state.btcApprox = true;
  return btcSpot();
}
// Yadio's reference for the chosen currency: currency per USD
export const yadioFiatPerUsd = () => currentPrices()?.fiatPerUsd(state.fiat) ?? null;

// Name of the chosen unit: CUP/USD, CUP/BTC or CUP/sat
export const unitName = () => `${state.fiat}/${UNITS[state.unit]}`;

// Converts currency per BTC to the chosen unit; in USD with the BTC/USD of `ts` (or the current one)
export const unitPrice = (fiatPerBtc, ts) => state.unit === 'usd'
  ? toUnit(fiatPerBtc, 'usd', ts ? btcAt(ts) : btcSpot())
  : toUnit(fiatPerBtc, state.unit);
