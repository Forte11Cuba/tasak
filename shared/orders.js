// Mostro orders (kind 38383, NIP-69): parsing, choice between versions, trades and order book.
// Pure: no network, DOM or global state. Signatures are verified before, in the data layer.
import { pmKey, orderMatchesPm, NO_METHOD } from './payment-methods.js';

// Order of an event, or null if it lacks d, s or f. `pmListFor(fiat)` gives the methods of a currency.
// `nodeName` is the node's name from the `y` tag, if any.
export function parseOrder(ev, pmListFor) {
  const t = Object.create(null);
  for (const tag of ev.tags) if (!(tag[0] in t)) t[tag[0]] = tag.slice(1);
  if (!t.d || !t.s || !t.f) return null;
  const fiat = t.f[0].toUpperCase();
  const pm = (t.pm || []).filter(Boolean);
  const pmKeys = [...new Set(pm.map(raw => pmKey(raw, pmListFor(fiat))))];
  return {
    key: ev.pubkey + ':' + t.d[0],
    node: ev.pubkey,
    nodeName: t.y?.[1] || null,
    ts: ev.created_at,
    status: t.s[0].toLowerCase(),
    side: (t.k?.[0] || '').toLowerCase(),
    fiat,
    fa: (t.fa || []).map(Number),
    amt: Number(t.amt?.[0] || 0),
    premium: Number(t.premium?.[0] || 0),
    expiresAt: Number(t.expires_at?.[0] || 0),
    pm,
    pmKeys: pmKeys.length ? pmKeys : [NO_METHOD],
    ev,   // the original signed event, to show it and verify it
  };
}

// Order of the states to break ties between events with the same created_at
const RANK = { pending: 0, success: 2, canceled: 2, expired: 2 };
const rank = s => RANK[s] ?? 1;

// Whether version `a` of an order replaces `b`: the newest; with the same created_at, the most
// advanced state and, if still tied, the greater id (so every visitor picks the same one)
export const newerVersion = (a, b) => a.ts !== b.ts ? a.ts > b.ts
  : rank(a.status) !== rank(b.status) ? rank(a.status) > rank(b.status) : a.ev.id > b.ev.id;

// Version to keep when `o` arrives and `prev` was kept, or null if `prev` stays. The pending version
// is the only one that says whether the order was at market or fixed price: it is kept in `origin`.
export function nextVersion(prev, o) {
  if (prev && !newerVersion(o, prev)) return null;
  return { ...o, origin: prev?.status === 'pending' ? { fixed: prev.amt > 0, premium: prev.premium } : prev?.origin };
}

// Orders with a status that pass the filters { fiat, nodes (Set), pmSel (Set) }
export const selectOrders = (orders, status, { fiat, nodes, pmSel }) => orders.filter(o =>
  o.status === status && o.fiat === fiat && nodes.has(o.node) && orderMatchesPm(o, pmSel));

// Price of a completed order in currency per BTC, straight from the event
export const fiatPerBtc = o => o.fa[0] / (o.amt / 1e8);
const isTrade = o => o.fa.length === 1 && o.fa[0] > 0 && o.amt > 0;

// Completed orders as trades, oldest first (ties by event id). `toPrice(fiatPerBtc, ts)` converts to
// the chosen unit; trades it cannot convert (null) are left out.
export function getTrades(orders, filters, toPrice) {
  return selectOrders(orders, 'success', filters).filter(isTrade)
    .map(o => ({ ...o, size: o.fa[0], price: toPrice(fiatPerBtc(o), o.ts) }))
    .filter(o => o.price != null)
    .sort((a, b) => a.ts - b.ts || (a.ev.id < b.ev.id ? -1 : a.ev.id > b.ev.id));
}

// Open orders not expired. Fixed price comes from the event; market price from `market` (currency
// per BTC of the reference, or null) plus the premium. `toPrice(fiatPerBtc)` converts to the unit.
export function getBook(orders, filters, { now, market, toPrice }) {
  const out = [];
  for (const o of selectOrders(orders, 'pending', filters)) {
    if (o.expiresAt && o.expiresAt < now) continue;
    if (!o.fa.length || !(o.fa.at(-1) > 0)) continue;
    let price;
    if (o.amt > 0) price = o.fa[0] / (o.amt / 1e8);
    else if (market) price = market / (1 - o.premium / 100);
    else continue;
    out.push({ ...o, fixed: o.amt > 0, price: toPrice(price), size: o.fa.at(-1) });
  }
  return {
    asks: out.filter(o => o.side === 'sell').sort((a, b) => a.price - b.price),
    bids: out.filter(o => o.side === 'buy').sort((a, b) => b.price - a.price),
  };
}

// Currency with most completed orders (or, if none, with most orders); null without orders
export function mostUsedFiat(orders) {
  const fiats = [...new Set(orders.map(o => o.fiat))].sort();
  if (!fiats.length) return null;
  const score = f => orders.reduce((a, o) => a + (o.fiat === f ? (o.status === 'success' ? 1000 : 1) : 0), 0);
  return fiats.reduce((a, b) => score(b) > score(a) ? b : a);
}
