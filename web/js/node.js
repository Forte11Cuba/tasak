// Page of the node: its profile, conditions, community and activity, read from its Nostr events with
// the same relay client and event store as the rate.
import { createStore } from './event-store.js';
import { createRelayPool } from './nostr-client.js';

const verifyEvent = window.NostrTools?.verifyEvent ?? null;
// The payment methods aren't shown here: no list, so they aren't classified
const store = createStore(() => []);
const relays = createRelayPool({
  urls: CONFIG.relays, authors: CONFIG.mostros, kinds: [38383], metaFilters: [{ kinds: META_KINDS }],
  verify: verifyEvent, has: store.has, onEvent: ev => store.add(ev), onUpdate: render, onStatus: render,
});

document.getElementById('back').href = 'index.html' + location.search;

// Summary of a node's orders for the «Actividad» section
function activity(pk) {
  const now = Date.now() / 1000;
  const mine = [...store.orders.values()].filter(o => o.node === pk);
  const done = mine.filter(o => o.status === 'success' && o.fa.length === 1 && o.fa[0] > 0);
  const open = mine.filter(o => o.status === 'pending' && !(o.expiresAt && o.expiresAt < now));
  const byFiat = new Map();
  for (const o of done) {
    const v = byFiat.get(o.fiat) || { n: 0, vol: 0 };
    v.n++; v.vol += o.fa[0];
    byFiat.set(o.fiat, v);
  }
  const first = Math.min(...done.map(o => o.ts));
  return [
    [t('Órdenes completadas'), `${done.length}${done.length ? ` · ${t('desde {d}', { d: esc(fmtTime(first).split(',')[0]) })}` : ''} <span class="muted">${t('(lo que guardan los relays, ~15 días)')}</span>`],
    ...[...byFiat].sort((a, b) => b[1].n - a[1].n)
      .map(([f, v]) => [t('Volumen en {f}', { f: esc(f) }), `${fmtInt(v.vol)} ${esc(f)} · ${nOrders(v.n)}`]),
    [t('Órdenes abiertas ahora'), String(open.length)],
  ];
}

let queued = false;
function render() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    document.getElementById('nodes').innerHTML = CONFIG.mostros.length
      ? CONFIG.mostros.map(pk => nodeCardHtml(pk, store.meta.get(pk), activity(pk))).join('')
      : `<p class="muted">${t('No hay nodos configurados: ejecuta «tasak build» o pasa ?mostro=… en la URL.')}</p>`;
    const name = store.meta.get(CONFIG.mostros[0])?.profile?.name;
    if (name) document.title = `${name} · ${t('Nodo Mostro')} · ${CONFIG.siteName}`;
    document.getElementById('dot').classList.toggle('live', relays.live > 0);
    document.getElementById('status').textContent = relays.live
      ? `${relays.live}/${CONFIG.relays.length} relays${verifyEvent ? ' · ' + t('✓ firmas') : ''}` : t('Conectando…');
  });
}

render();
relays.start();
