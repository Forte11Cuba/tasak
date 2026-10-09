// Store of the node's events, whatever their source (relays now; the snapshot in step 3). Events
// arrive already checked (author, kind and signature), are deduplicated by id and every version of
// each order is kept, so the current order (with its origin and take time) doesn't depend on the
// order in which they arrive.
import { parseOrder, currentOrder } from '../shared/orders.js';
import { parseRates, newerRates } from '../shared/rates.js';

// `pmList(fiat)`: list of payment methods of a currency, to classify those of each order
export function createStore(pmList) {
  const store = {
    seen: new Set(),       // ids of the events already stored (they arrive repeated from several relays)
    versions: new Map(),   // pubkey:d -> every version of the order
    orders: new Map(),     // pubkey:d -> current state of the order
    meta: new Map(),       // pubkey -> { profile, info, relays } read from its Nostr events
    rates: new Map(),      // pubkey -> newest mostro-rates of the node (prices it uses for market orders)
    nodeNames: new Map(),
    has: id => store.seen.has(id),
    // Returns true if the event changed what can be shown
    add(ev) {
      if (store.seen.has(ev.id)) return false;
      store.seen.add(ev.id);
      if (ev.kind === 30078) {
        const r = parseRates(ev);
        const prev = r && store.rates.get(r.node);
        if (!r || (prev && !newerRates(r, prev))) return false;
        store.rates.set(r.node, r);
        return true;
      }
      if (ev.kind !== 38383) {
        if (!applyMeta(store.meta, ev)) return false;
        const name = store.meta.get(ev.pubkey).profile?.name;
        if (name) store.nodeNames.set(ev.pubkey, name);
        return true;
      }
      const o = parseOrder(ev, pmList);
      if (!o) return false;
      if (o.nodeName) store.nodeNames.set(ev.pubkey, o.nodeName);
      const versions = store.versions.get(o.key) || [];
      versions.push(o);
      store.versions.set(o.key, versions);
      const prev = store.orders.get(o.key);
      const next = currentOrder(versions);
      if (prev && prev.ev === next.ev && prev.takenAt === next.takenAt
        && JSON.stringify(prev.origin) === JSON.stringify(next.origin)) return false;
      store.orders.set(o.key, next);
      return true;
    },
  };
  return store;
}
