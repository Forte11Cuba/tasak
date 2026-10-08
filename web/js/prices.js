// External prices: Yadio (current BTC/USD and currency per USD) and Coinbase (hourly BTC/USD), and
// the conversion of each price to the chosen unit.
import { UNITS, toUnit, hourlyClose } from '../shared/units.js';
import { state } from './state.js';

export async function loadYadio() {
  try {
    state.yadio = await (await fetch('https://api.yadio.io/exrates/USD')).json();
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

export const btcSpot = () => state.yadio?.BTC ?? null;
// BTC/USD of a moment: the Coinbase hourly close; without it, the current price (approximate)
export function btcAt(ts) {
  const p = hourlyClose(state.btcusd, ts);
  if (p != null) return p;
  if (ts < Date.now() / 1000 - 3 * 3600) state.btcApprox = true;
  return btcSpot();
}
export const yadioFiatPerUsd = () => state.yadio?.USD?.[state.fiat] ?? (state.fiat === 'USD' ? 1 : null);

// Name of the chosen unit: CUP/USD, CUP/BTC or CUP/sat
export const unitName = () => `${state.fiat}/${UNITS[state.unit]}`;

// Converts currency per BTC to the chosen unit; in USD with the BTC/USD of `ts` (or the current one)
export const unitPrice = (fiatPerBtc, ts) => state.unit === 'usd'
  ? toUnit(fiatPerBtc, 'usd', ts ? btcAt(ts) : btcSpot())
  : toUnit(fiatPerBtc, state.unit);
