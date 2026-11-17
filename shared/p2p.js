// Orders and trades of other P2P platforms: kind 35353, the proposed NIP «Peer-to-peer Order and Trade
// events for non-Bitcoin assets» (nostr-protocol/nips#2541, revision c76c5c6). Parsing and checking,
// asset identity, deletions (NIP-09), trades as the rate functions take them and the order book.
// Pure: no network, DOM or global state. Signatures are verified before, in the data layer.
// Only the browser uses it for now: the server archives these events but computes nothing with them,
// so there is no Rust version yet (see CLAUDE.md).
import { isTestPm, orderMatchesPm, TESTS, NO_METHOD } from './payment-methods.js';

export const P2P_KIND = 35353;

// The tags the NIP defines: each one at most once and never with an empty value. Others are ignored
const NIP_TAGS = new Set(['d', 'a', 'k', 'c', 'layer', 'network', 'contract', 'f', 's', 'amt', 'fa', 'price',
  'premium', 'pm', 'source', 'rating', 'name', 'maker', 'g', 'bond', 'expires_at', 'executed_at', 'expiration', 'y', 'z']);
const STATUSES = ['pending', 'paused', 'canceled', 'in-progress', 'success', 'expired'];
const DECIMAL = /^[0-9]+(\.[0-9]+)?$/;
const SIGNED = /^-?[0-9]+(\.[0-9]+)?$/;
const UNIX = /^[0-9]+$/;
// Layers whose contract addresses must be lowercase (EVM chains of the NIP's table)
const EVM = ['eth', 'bsc', 'pol', 'arb', 'op', 'base', 'rsk'];
const lower = s => s === s.toLowerCase();

// Tags of the NIP as name -> values, or null if one is repeated or has an empty value
function nipTags(ev) {
  const t = Object.create(null);
  for (const tag of ev.tags || []) {
    if (!Array.isArray(tag) || !NIP_TAGS.has(tag[0])) continue;
    const values = tag.slice(1);
    if (tag[0] in t || !values.length || values.some(v => typeof v !== 'string' || v === '')) return null;
    t[tag[0]] = values;
  }
  return t;
}

// Asset identity: tokens by layer, network and contract; native assets by layer, network and ticker;
// balances on the platform's own ledger (internal) by the platform's pubkey, network and ticker
export const assetId = d => d.layer === 'internal' ? `internal:${d.pubkey}:${d.network}:${d.c}`
  : d.contract ? `${d.layer}:${d.network}:${d.contract}` : `${d.layer}:${d.network}:${d.c}`;

// Payment methods as the platform publishes them, each value one method; «Pruebas» if the text says
// it is a test, as in Mostro
export function p2pPmKeys(pm) {
  const keys = [...new Set(pm.map(p => isTestPm(p) ? TESTS : p.trim()).filter(Boolean))];
  return keys.length ? keys : [NO_METHOD];
}

// The fields shared by orders and trades, or null if a mandatory one is missing or wrong
function common(ev, t) {
  for (const k of ['d', 'k', 'c', 'layer', 'network', 'f', 'y']) if (!t[k]) return null;
  const [side, c, layer, network] = [t.k[0], t.c[0], t.layer[0], t.network[0]];
  if (side !== 'buy' && side !== 'sell') return null;
  if (!lower(c) || !lower(layer) || !lower(network)) return null;
  const contract = t.contract?.[0] ?? null;
  if (layer === 'internal' && contract) return null;
  if (contract && EVM.includes(layer) && !lower(contract)) return null;
  const pm = t.pm || [];
  const d = {
    key: ev.pubkey + ':' + t.d[0],
    pubkey: ev.pubkey,
    ts: ev.created_at,
    side, c, layer, network, contract,
    fiat: t.f[0].toUpperCase(),
    maker: t.maker?.[0] ?? null,
    pm,
    pmKeys: p2pPmKeys(pm),
    ev,   // the original signed event, to show it and verify it
  };
  d.asset = assetId(d);
  return d;
}

// Order or trade of an event: { doc: 'order' | 'trade', … }, or null if it doesn't follow the NIP (the
// clients SHOULD ignore those). Strict with trades, which give the prices, and with the open orders,
// which go to the order book. Of the other orders only `d` and `s` are read: they replace an open order,
// and nothing else is taken from them, so a deviation there doesn't matter
export function parseP2P(ev) {
  if (ev?.kind !== P2P_KIND || typeof ev.created_at !== 'number') return null;
  const z = ev.tags?.find(tag => tag[0] === 'z')?.[1];
  if (z === 'order') {
    const s = ev.tags.find(tag => tag[0] === 's')?.[1];
    const d = ev.tags.find(tag => tag[0] === 'd')?.[1];
    if (!d || !STATUSES.includes(s)) return null;
    if (s !== 'pending') return { doc: 'order', key: ev.pubkey + ':' + d, pubkey: ev.pubkey, ts: ev.created_at, status: s, ev };
  } else if (z !== 'trade') return null;
  const t = nipTags(ev);
  const base = t && common(ev, t);
  if (!base) return null;
  return z === 'trade' ? trade(ev, t, base) : order(t, base);
}

function trade(ev, t, base) {
  if (!t.amt || !t.fa || !t.executed_at || t.expiration) return null;
  const [amt, fa, at] = [t.amt[0], t.fa, t.executed_at[0]];
  if (t.amt.length !== 1 || !DECIMAL.test(amt) || !(Number(amt) > 0)) return null;
  if (fa.length !== 1 || !DECIMAL.test(fa[0]) || !(Number(fa[0]) > 0)) return null;
  if (!UNIX.test(at) || Number(at) > ev.created_at) return null;
  // The order it fills, of the same platform
  if (t.a && !t.a[0].startsWith(`${P2P_KIND}:${ev.pubkey}:`)) return null;
  return { ...base, doc: 'trade', amt: Number(amt), fa: [Number(fa[0])], executedAt: Number(at), order: t.a?.[0] ?? null };
}

function order(t, base) {
  if (!t.amt || !t.fa || !t.pm || !t.s) return null;
  if (t.amt.length !== 1 || !DECIMAL.test(t.amt[0])) return null;
  if (t.fa.length > 2 || !t.fa.every(v => DECIMAL.test(v))) return null;
  const fa = t.fa.map(Number);
  if (fa.length === 2 && fa[0] > fa[1]) return null;
  // Exactly one of price and premium
  if (!t.price === !t.premium) return null;
  const price = t.price ? Number(t.price[0]) : null;
  if (t.price && (!DECIMAL.test(t.price[0]) || !(price > 0))) return null;
  const premium = t.premium ? Number(t.premium[0]) : null;
  if (t.premium && (!SIGNED.test(t.premium[0]) || !(premium > -100))) return null;
  for (const k of ['expires_at', 'expiration']) if (t[k] && !UNIX.test(t[k][0])) return null;
  return {
    ...base, doc: 'order', status: 'pending', amt: Number(t.amt[0]), fa, price, premium,
    expiresAt: Number(t.expires_at?.[0] || 0), expiration: Number(t.expiration?.[0] || 0),
    name: t.name?.[0] ?? null,
  };
}

// Which version of an order or trade wins: the latest created_at, then the greatest event id, so that
// every visitor keeps the same one
export const newerDoc = (a, b) => a.ts !== b.ts ? a.ts > b.ts : a.ev.id > b.ev.id;

// Deletion request (NIP-09, kind 5) of a platform's orders or trades: the addresses it deletes
// (pubkey:d) with its created_at, or [] if it isn't one. Only its own (`a` = 35353:<its pubkey>:<d>)
// and with `k` = 35353, as the NIP asks
export function parseDeletion(ev) {
  if (ev?.kind !== 5 || !ev.tags?.some(t => t[0] === 'k' && t[1] === String(P2P_KIND))) return [];
  const prefix = `${P2P_KIND}:${ev.pubkey}:`;
  return ev.tags.filter(t => t[0] === 'a' && typeof t[1] === 'string' && t[1].startsWith(prefix) && t[1].length > prefix.length)
    .map(t => ({ key: ev.pubkey + ':' + t[1].slice(prefix.length), ts: ev.created_at }));
}

// Whether a version is withdrawn: a deletion of its address deletes the versions up to its created_at
// (`deletions`: Map pubkey:d -> newest deletion's created_at)
export const isDeleted = (d, deletions) => (deletions.get(d.key) ?? -1) >= d.ts;

// Whether a document passes the filters: asset, currency and methods (a Set, or null for all). The orders
// made by the platform itself (maker = platform) count as any other
function matches(d, { asset, fiat, pmSel }) {
  return d.asset === asset && d.fiat === fiat && (!pmSel || orderMatchesPm(d, pmSel));
}

// Order still available: pending and neither expires_at nor expiration elapsed
export const isAvailable = (d, now) => d.doc === 'order' && d.status === 'pending'
  && !(d.expiresAt && d.expiresAt <= now) && !(d.expiration && d.expiration <= now);

// Trades as the rate functions take them ({ ts, price, size, ev }), oldest first (ties by event id):
// the time of the execution, the price fa ÷ amt (never the order's price or premium) and the fiat
// amount as the weight. `docs`: the current version of each address
export function p2pTrades(docs, deletions, filters) {
  return docs.filter(d => d.doc === 'trade' && !isDeleted(d, deletions) && matches(d, filters))
    .map(d => ({ ...d, ts: d.executedAt, publishedAt: d.ts, price: d.fa[0] / d.amt, size: d.fa[0] }))
    .sort((a, b) => a.ts - b.ts || (a.ev.id < b.ev.id ? -1 : a.ev.id > b.ev.id));
}

// Available orders: sells (asks) from the cheapest, buys (bids) from the dearest. The price is the
// order's `price`; with a premium the NIP gives no market price, so it has none and goes last. Same
// price: the newest first and then by event id. The depth is the largest fiat amount
export function p2pBook(docs, deletions, filters, now) {
  const out = docs.filter(d => isAvailable(d, now) && !isDeleted(d, deletions) && matches(d, filters))
    .map(d => ({ ...d, fixed: d.price != null, size: d.fa.at(-1) }));
  const tie = (a, b) => b.ts - a.ts || (a.ev.id < b.ev.id ? -1 : a.ev.id > b.ev.id);
  const by = dir => (a, b) => (a.price == null) - (b.price == null) || dir * (a.price - b.price) || tie(a, b);
  return {
    asks: out.filter(d => d.side === 'sell').sort(by(1)),
    bids: out.filter(d => d.side === 'buy').sort(by(-1)),
  };
}

// The assets traded, most trades first: { id, c, layer, network, contract, trades, orders }, of a
// currency (or all with fiat = null). Trades that a deletion withdrew don't count
export function p2pAssets(docs, deletions, fiat, now) {
  const assets = new Map();
  for (const d of docs) {
    if (!d.asset || (fiat && d.fiat !== fiat) || isDeleted(d, deletions)) continue;
    const isTrade = d.doc === 'trade';
    if (!isTrade && !isAvailable(d, now)) continue;
    const a = assets.get(d.asset) || { id: d.asset, c: d.c, layer: d.layer, network: d.network, contract: d.contract, trades: 0, orders: 0 };
    isTrade ? a.trades++ : a.orders++;
    assets.set(d.asset, a);
  }
  return [...assets.values()].sort((a, b) => b.trades - a.trades || b.orders - a.orders || (a.id < b.id ? -1 : a.id > b.id));
}

// Currency with most trades (or, without trades, with most available orders); null without either
export function p2pMostUsedFiat(docs, deletions, now) {
  const score = new Map();
  for (const d of docs) {
    if (!d.fiat || isDeleted(d, deletions) || (d.doc !== 'trade' && !isAvailable(d, now))) continue;
    score.set(d.fiat, (score.get(d.fiat) || 0) + (d.doc === 'trade' ? 1000 : 1));
  }
  return [...score].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;
}

// Methods of an asset and currency with the trades and available orders of each, in the filter's
// order: most trades, most orders and by name
export function p2pPmStats(docs, deletions, { asset, fiat }, now) {
  const counts = new Map();
  for (const d of docs) {
    if (isDeleted(d, deletions) || !(d.doc === 'trade' || isAvailable(d, now))) continue;
    if (!matches(d, { asset, fiat, pmSel: null })) continue;
    for (const k of d.pmKeys) {
      const c = counts.get(k) || { done: 0, open: 0 };
      d.doc === 'trade' ? c.done++ : c.open++;
      counts.set(k, c);
    }
  }
  return [...counts].map(([key, c]) => ({ key, ...c }))
    .sort((a, b) => b.done - a.done || b.open - a.open || a.key.localeCompare(b.key));
}

// The method chosen by default, since a platform's rate is of one method only (each one is a market with
// its own price, and averaging two would mix them): of `stats` (as p2pPmStats orders them), the first one
// that isn't hidden (`isHidden(key)`), or the first one if all are; null without methods
export const defaultP2PMethod = (stats, isHidden) => (stats.find(s => !isHidden(s.key)) ?? stats[0])?.key ?? null;
