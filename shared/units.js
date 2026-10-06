// Units of the price: currency per USD, per BTC or per sat. Prices are kept in currency per BTC and
// converted at the end; currency/sat comes only from the event (no BTC price needed).

export const UNITS = { usd: 'USD', btc: 'BTC', sat: 'sat' };

// Converts currency per BTC to a unit; for USD it needs the BTC/USD of that moment (null if unknown)
export function toUnit(fiatPerBtc, unit, btcUsd) {
  if (unit === 'btc') return fiatPerBtc;
  if (unit === 'sat') return fiatPerBtc / 1e8;
  return btcUsd ? fiatPerBtc / btcUsd : null;
}

// BTC/USD of a moment from hourly closes (Map hour start -> close): that hour or the previous one
export function hourlyClose(closes, ts) {
  const h = Math.floor(ts / 3600) * 3600;
  return closes.get(h) ?? closes.get(h - 3600) ?? null;
}
