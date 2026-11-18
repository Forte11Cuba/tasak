// Dialog with the signed Nostr event of an order: its data, the JSON and a link to check it.
import { state, nodeName, publisherName } from './state.js';
import { fmtPrice, fmtAmt } from './format.js';

const evDlg = document.getElementById('evDlg');
const FINAL_STATUS = ['success', 'canceled', 'expired'];

export function openEvent(o) {
  if (o.unsigned) return openUnsigned(o);
  if (CONFIG.platform) return openP2P(o);
  const ev = o.ev;
  if (!ev) return;
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  const STATUS = { pending: 'abierta, esperando a que alguien la tome', success: 'completada', canceled: 'cancelada', expired: 'caducada' };
  const statusName = s => STATUS[s] ? t(STATUS[s]) : s;
  const amount = o.fa.length > 1 ? `${fmtInt(o.fa[0])}–${fmtInt(o.fa[1])} ${esc(o.fiat)}` : `${fmtInt(o.fa[0])} ${esc(o.fiat)}`;
  // In an open order, amt = 0 means market price (Yadio + premium); with sats, the price is fixed
  const pricing = o.status !== 'pending' ? `${fmtInt(o.amt)} sats`
    : o.amt > 0 ? t('precio fijo: {n} sats', { n: fmtInt(o.amt) })
    : t('precio de mercado (Yadio) {p} % de prima', { p: `${o.premium >= 0 ? '+' : ''}${o.premium}` });
  document.getElementById('evMeta').innerHTML =
    row(t('Estado'), `${esc(statusName(o.status))} <span class="muted">(${esc(o.status)})</span>`) +
    row(t('Nodo'), esc(nodeName(ev.pubkey))) +
    row(t('Fecha'), esc(fmtTime(ev.created_at))) +
    row(t('Orden'), `${t(o.side === 'buy' ? 'compra de BTC' : 'venta de BTC')} · ${amount} · ${pricing}`) +
    row(t('Métodos de pago'), esc(o.pm.join(', ') || '—')) +
    (o.status === 'pending' && o.expiresAt ? row(t('Caduca'), esc(fmtTime(o.expiresAt))) : '') +
    row(t('Id del evento'), `<span class="num">${esc(ev.id)}</span>`) +
    row(t('Firma'), state.sigs === 'ok' ? `<span class="up">${t('verificada en este navegador')}</span>` : `<span class="muted">${t('sin verificar (no cargó nostr-tools)')}</span>`);
  document.getElementById('evJson').textContent = JSON.stringify(ev, null, 2);
  const link = document.getElementById('evLink');
  link.hidden = true;
  evDlg.showModal();
  const nip19 = window.NostrTools?.nip19;
  if (nip19) {
    // A final state doesn't change: link the exact version, the one the rate used. An open order gets
    // replaced and relays drop the old version: link its address, which always shows the latest one
    const relays = CONFIG.relays.slice(0, 2);
    link.href = FINAL_STATUS.includes(o.status)
      ? 'https://nostrinspect.com/e/' + nip19.neventEncode({ id: ev.id, author: ev.pubkey, kind: ev.kind, relays })
      : 'https://nostrinspect.com/a/' + nip19.naddrEncode({ kind: ev.kind, pubkey: ev.pubkey, identifier: ev.tags.find(t => t[0] === 'd')[1], relays });
    link.hidden = false;
  }
}
// An order or trade of a P2P platform (kind 35353). A trade doesn't change: its exact version is linked.
// An open order gets replaced: its address, which always shows the latest one
function openP2P(o) {
  const ev = o.ev;
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  const C = o.c.toUpperCase();
  const MAKER = { platform: 'la propia plataforma', user: 'un usuario', bot: 'un bot de un usuario', 'market-maker': 'un creador de mercado' };
  const amount = o.fa.length > 1 ? `${fmtInt(o.fa[0])}–${fmtInt(o.fa[1])} ${esc(o.fiat)}` : `${fmtInt(o.fa[0])} ${esc(o.fiat)}`;
  const side = t(o.side === 'buy' ? 'compra de {a}' : 'venta de {a}', { a: esc(C) });
  const isTrade = o.doc === 'trade';
  const pricing = isTrade ? `${fmtAmt(o.amt)} ${esc(C)} · ${t('precio {p}', { p: fmtPrice(o.fa[0] / o.amt) })}`
    : o.price != null ? t('precio fijo {p}', { p: fmtPrice(o.price) })
    : t('prima {p} % sobre un precio de mercado de la plataforma', { p: `${o.premium >= 0 ? '+' : ''}${o.premium}` });
  document.getElementById('evMeta').innerHTML =
    row(t('Tipo'), isTrade ? t('operación: ejecución de una orden') : `${t('orden abierta')} <span class="muted">(pending)</span>`) +
    row(t('Plataforma'), esc(CONFIG.platform.name) + (publisherName(ev.pubkey) === CONFIG.platform.name ? '' : ` · ${esc(publisherName(ev.pubkey))}`)) +
    row(t('Fecha'), esc(fmtTime(isTrade ? o.executedAt : ev.created_at)) + (isTrade ? ` <span class="muted">(${t('publicada {d}', { d: esc(fmtTime(ev.created_at)) })})</span>` : '')) +
    row(t('Orden'), `${side} · ${amount} · ${pricing}`) +
    row(t('Activo'), `${esc(C)} · ${esc(o.layer)} · ${esc(o.network)}${o.contract ? ` · <span class="num">${esc(o.contract)}</span>` : ''}`) +
    (o.maker ? row(t('Publicada por'), esc(MAKER[o.maker] ? t(MAKER[o.maker]) : o.maker)) : '') +
    row(t('Métodos de pago'), esc(o.pm.join(', ') || '—')) +
    (!isTrade && o.expiresAt ? row(t('Caduca'), esc(fmtTime(o.expiresAt))) : '') +
    row(t('Id del evento'), `<span class="num">${esc(ev.id)}</span>`) +
    row(t('Firma'), state.sigs === 'ok' ? `<span class="up">${t('verificada en este navegador')}</span>` : `<span class="muted">${t('sin verificar (no cargó nostr-tools)')}</span>`);
  document.getElementById('evJson').textContent = JSON.stringify(ev, null, 2);
  const link = document.getElementById('evLink');
  link.hidden = true;
  evDlg.showModal();
  const nip19 = window.NostrTools?.nip19;
  if (nip19) {
    const relays = CONFIG.relays.slice(0, 2);
    link.href = isTrade
      ? 'https://nostrinspect.com/e/' + nip19.neventEncode({ id: ev.id, author: ev.pubkey, kind: ev.kind, relays })
      : 'https://nostrinspect.com/a/' + nip19.naddrEncode({ kind: ev.kind, pubkey: ev.pubkey, identifier: o.key.slice(ev.pubkey.length + 1), relays });
    link.hidden = false;
  }
}

// An order that is only in the node's database (the server's snapshot): no event to show or verify
function openUnsigned(o) {
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  document.getElementById('evMeta').innerHTML =
    row(t('Estado'), `${esc(t('completada'))} <span class="muted">(success)</span>`) +
    row(t('Nodo'), esc(nodeName(o.node))) +
    row(t('Fecha'), esc(fmtTime(o.ts))) +
    row(t('Orden'), `${t(o.side === 'buy' ? 'compra de BTC' : 'venta de BTC')} · ${fmtInt(o.fa[0])} ${esc(o.fiat)} · ${fmtInt(o.amt)} sats`) +
    row(t('Métodos de pago'), esc(o.pm.join(', ') || '—')) +
    row(t('Id del evento'), `<span class="num">${esc(o.id || '—')}</span>`) +
    row(t('Firma'), `<span class="warn">${t('sin firma: viene de la base de datos del nodo, porque su evento ya no está en los relays. Se confía en quien publica este sitio')}</span>`);
  const { ev, unsigned, fresh, ...data } = o;
  document.getElementById('evJson').textContent = JSON.stringify(data, null, 2);
  document.getElementById('evLink').hidden = true;
  evDlg.showModal();
}

document.getElementById('evClose').onclick = () => evDlg.close();
evDlg.addEventListener('click', e => { if (e.target === evDlg) evDlg.close(); });
document.getElementById('evCopy').onclick = async e => {
  try {
    await navigator.clipboard.writeText(document.getElementById('evJson').textContent);
    e.target.textContent = t('Copiado ✓');
  } catch { e.target.textContent = t('No se pudo copiar'); }
  setTimeout(() => { e.target.textContent = t('Copiar JSON'); }, 1500);
};
