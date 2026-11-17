// Page of a P2P platform (?platform=, PLATFORMS and OTHER_PLATFORMS of .env): its orders and trades of
// other assets (kind 35353), read from the relays in this browser. The logic comes from shared/p2p.js;
// this module keeps the platform's events and gives the trades and the book with the page's filters.
// Its rate is per asset, currency and payment method, from its trades only, and this site doesn't sign it.
import { parseP2P, parseDeletion, newerDoc, p2pTrades, p2pBook, p2pAssets, p2pMostUsedFiat, p2pPmStats, defaultP2PMethod } from '../shared/p2p.js';
import { hiddenSet, isHidden, TESTS } from '../shared/payment-methods.js';
import { createPlatformPool } from './nostr-client.js';
import { state } from './state.js';

export const P = CONFIG.platform;
// The methods that are never chosen by default (PLATFORM_HIDDEN_PAYMENT_METHODS, and always the test
// orders); the visitor can still choose them
export const P_HIDDEN = hiddenSet([...(P?.hiddenPaymentMethods || []), TESTS]);

export const p2p = {
  docs: new Map(),        // pubkey:d -> newest valid version of the order or trade
  deletions: new Map(),   // pubkey:d -> newest deletion request's created_at (NIP-09)
  ignored: new Set(),     // ids of the events that don't follow the NIP
};

// Returns true if the event changed what can be shown
function add(ev) {
  if (ev.kind === 0) {
    let c;
    try { c = JSON.parse(ev.content); } catch { return false; }
    const prev = state.profiles.get(ev.pubkey);
    if (prev?.ts >= ev.created_at) return false;
    state.profiles.set(ev.pubkey, {
      ts: ev.created_at,
      name: typeof c?.name === 'string' ? c.name : '',
      picture: typeof c?.picture === 'string' ? c.picture : '',
      nip05: typeof c?.nip05 === 'string' ? c.nip05 : '',
    });
    return true;
  }
  if (ev.kind === 5) {
    let changed = false;
    for (const { key, ts } of parseDeletion(ev)) {
      if ((p2p.deletions.get(key) ?? -1) >= ts) continue;
      p2p.deletions.set(key, ts);
      changed = true;
    }
    return changed;
  }
  const d = parseP2P(ev);
  if (!d) { p2p.ignored.add(ev.id); return false; }
  const prev = p2p.docs.get(d.key);
  if (prev && !newerDoc(d, prev)) return false;
  p2p.docs.set(d.key, d);
  return true;
}

export function startPlatform({ verify, onUpdate, onStatus }) {
  const pool = createPlatformPool({
    urls: CONFIG.relays, author: P.key, verify, onEvent: ev => add(ev), onUpdate, onStatus,
  });
  pool.start();
  return pool;
}

const docs = () => [...p2p.docs.values()];
const now = () => Date.now() / 1000;

const filters = () => ({ asset: state.asset, fiat: state.fiat, pmSel: state.pmSel });
// Trades of the chosen currency, asset and method (one only: each method is a market with its own price)
export const platformTrades = () => p2pTrades(docs(), p2p.deletions, filters());
export const platformBook = () => p2pBook(docs(), p2p.deletions, filters(), now());

// The filters' choices: the currency (the most traded one unless chosen), the asset (the most traded one
// in that currency) and one payment method (the most traded one that isn't hidden, unless chosen).
// Returns the methods' stats ({ key, done, open }) and the currencies, for the bar
export function syncPlatformFilters() {
  const all = docs();
  const fiats = [...new Set(all.filter(d => d.fiat).map(d => d.fiat))].sort();
  if (state.fiatAuto && fiats.length) {
    const best = p2pMostUsedFiat(all, p2p.deletions, now());
    if (best && best !== state.fiat) { state.fiat = best; state.pmSel = null; state.pmKnown = null; state.assetAuto = true; }
  }
  if (state.fiat && !fiats.includes(state.fiat)) fiats.unshift(state.fiat);
  const prevAsset = state.asset;
  state.assets = p2pAssets(all, p2p.deletions, state.fiat, now());
  if (state.assets.length && (state.assetAuto || !state.assets.some(a => a.id === state.asset))) {
    state.asset = state.assets[0].id;
  }
  if (state.asset !== prevAsset) state.pmChosen = false;
  // The methods by their trades and open orders, the hidden ones last
  const stats = p2pPmStats(all, p2p.deletions, { asset: state.asset, fiat: state.fiat }, now())
    .sort((a, b) => isHidden(a.key, P_HIDDEN) - isHidden(b.key, P_HIDDEN));
  const chosen = state.pmChosen && [...(state.pmSel || [])][0];
  const method = chosen && stats.some(s => s.key === chosen) ? chosen : defaultP2PMethod(stats, k => isHidden(k, P_HIDDEN));
  if (!chosen || method !== chosen) state.pmChosen = false;
  state.pmSel = new Set(method ? [method] : []);
  return { stats, fiats };
}

// The chosen method, or null
export const platformMethod = () => [...(state.pmSel || [])][0] ?? null;

// The page of a platform's pubkey, keeping only the language of the URL
export function platformUrl(name, key) {
  const q = new URLSearchParams({ platform: name });
  if (key) q.set('key', window.NostrTools?.nip19?.npubEncode(key) || key);
  const lang = new URLSearchParams(location.search).get('lang');
  if (lang) q.set('lang', lang);
  return location.pathname + '?' + q;
}
