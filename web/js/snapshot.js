// The server's snapshot (api/snapshot.json, written by tasak every 5 minutes): what the page needs to
// draw at once instead of waiting for the relays. Nothing in it is taken on trust that can be checked:
// its events go through the same checks as those of the relays (author, kind, signature), and the Tasa K
// counts only if the key in config.js signed it. What can't be checked is marked: the orders that are
// only in the node's database (unsigned) and each order's BTC/USD (the server's sources). Without a
// server, or if it fails, the page works as before, with the relays alone.
import { pmKey, NO_METHOD } from '../shared/payment-methods.js';

export const SNAPSHOT_URL = 'api/snapshot.json';

// The snapshot, or null if there is none (static site), it doesn't answer or it isn't one we know
export async function fetchSnapshot() {
  try {
    const res = await fetch(SNAPSHOT_URL, { cache: 'no-cache', signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const snap = await res.json();
    return snap?.version === 1 && Array.isArray(snap.events) ? snap : null;
  } catch { return null; }
}

// The signed Tasa K of an event, or null if it isn't one signed by `pubkey` (config.js) or is malformed
export function readRate(ev, pubkey, verify) {
  if (!ev || !pubkey || ev.kind !== 30078 || ev.pubkey !== pubkey) return null;
  if (!ev.tags?.some(t => t[0] === 'd' && t[1] === 'tasak')) return null;
  if (!verify || !verify(ev)) return null;
  let content;
  try { content = JSON.parse(ev.content); } catch { return null; }
  const r = content?.tasak;
  if (!r || typeof r.fiat !== 'string' || !Number.isInteger(r.decimals)) return null;
  const expiration = Number(ev.tags.find(t => t[0] === 'expiration')?.[1]) || 0;
  return { ...r, id: ev.id, ts: ev.created_at, expiration };
}

// Adds the snapshot to the page. `accept(ev)` checks an event as those of the relays and `add(ev)`
// stores it; `orders` is the store's map of orders and `pmList(fiat)` the payment methods of a currency.
// Returns { btcUsd, rate, generated }: each order's BTC/USD (key -> { usd, source, at }), the signed
// rate (or null) and when the server wrote it
export function applySnapshot(snap, { accept, add, orders, pmList, ratePubkey, verify }) {
  for (const ev of snap.events) if (accept(ev)) add(ev);
  // Orders only in the node's database: unsigned, and only if no signed version of them arrived
  for (const n of snap.nodeOrders || []) {
    if (!n?.key || orders.has(n.key) || !Array.isArray(n.pm)) continue;
    const pm = n.pm.filter(Boolean);
    const keys = [...new Set(pm.map(raw => pmKey(raw, pmList(n.fiat))))];
    orders.set(n.key, {
      key: n.key, node: n.node, nodeName: null, ts: n.ts, status: 'success', side: n.side, fiat: n.fiat,
      fa: [n.fa], amt: n.amt, premium: n.premium, expiresAt: 0, pm, pmKeys: keys.length ? keys : [NO_METHOD],
      origin: n.origin ?? null, takenAt: n.takenAt ?? null, ev: null, id: n.id, unsigned: true,
    });
  }
  const btcUsd = new Map(Object.entries(snap.btcUsd || {}).filter(([, v]) => v?.usd > 0));
  return { btcUsd, rate: readRate(snap.rate, ratePubkey, verify), generated: snap.generated || 0 };
}
