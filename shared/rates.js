// Current prices of BTC, from the `mostro-rates` events of the nodes (kind 30078, d = mostro-rates):
// every few minutes each node publishes the prices it uses for market orders, signed, as
// {"BTC": {"USD": 82858.34, "CUP": 63800922.56, …}}, with an expiration.

// Validity when the event has no expiration tag: Mostro's default (2 × the 5 min interval)
const DEFAULT_TTL = 600;

// The rates of a mostro-rates event, or null if it isn't one or its content is not valid:
// { node, id, ts, expiresAt, source, btc } with btc = currency -> currency per BTC
export function parseRates(ev) {
  if (ev?.kind !== 30078 || !ev.tags.some(t => t[0] === 'd' && t[1] === 'mostro-rates')) return null;
  let content;
  try { content = JSON.parse(ev.content); } catch { return null; }
  const btc = {};
  for (const [fiat, v] of Object.entries(content?.BTC ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) btc[fiat.toUpperCase()] = v;
  }
  if (!btc.USD) return null;
  const tag = k => ev.tags.find(t => t[0] === k)?.[1];
  const expiration = Number(tag('expiration'));
  return {
    node: ev.pubkey,
    id: ev.id,
    ts: ev.created_at,
    expiresAt: expiration > 0 ? expiration : ev.created_at + DEFAULT_TTL,
    source: tag('source') || null,
    btc,
  };
}

// Whether rates `a` replace `b` of the same node: the newest and, if tied, the greater id
export const newerRates = (a, b) => a.ts !== b.ts ? a.ts > b.ts : a.id > b.id;

// The rates to use at `now`: the newest published by then that haven't expired, or null
export function currentRates(list, now) {
  let best = null;
  for (const r of list) if (r.ts <= now && r.expiresAt > now && (!best || newerRates(r, best))) best = r;
  return best;
}

// Currency per USD from some rates (USD itself is 1), or null if they don't have that currency
export function fiatPerUsd(rates, fiat) {
  if (fiat === 'USD') return 1;
  const v = rates?.btc[fiat];
  return v ? v / rates.btc.USD : null;
}

// How long Mostro keeps using its last prices when it can't refresh them (max_price_staleness_seconds,
// 30 min by default): the event expires sooner, but the node still prices market orders with them
export const STALE_LIMIT = 1800;

// Market price for the orders of a node: its own newest rates `own` while the node still uses them
// (until they expire or STALE_LIMIT after publishing, whichever is later); otherwise `fallback`
// (currency per BTC from Yadio's API, an estimate) or null.
// Returns { fiatPerBtc, from: 'node' | 'api', expired, source } with `source` the node's providers.
export function marketPrice(own, fiat, now, fallback) {
  const v = own?.btc[fiat];
  if (v && now < Math.max(own.expiresAt, own.ts + STALE_LIMIT)) {
    return { fiatPerBtc: v, from: 'node', expired: now >= own.expiresAt, source: own.source };
  }
  return fallback ? { fiatPerBtc: fallback, from: 'api', expired: false, source: own?.source ?? null } : null;
}

// Whether a list of providers (the `source` tag, e.g. "coingecko,yadio") is Yadio alone
export const isYadioOnly = source => source === 'yadio';
