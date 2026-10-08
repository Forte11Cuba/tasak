// Dialog with the signed Nostr event of an order: its data, the JSON and a link to check it.
import { state, nodeName } from './state.js';

const evDlg = document.getElementById('evDlg');
const FINAL_STATUS = ['success', 'canceled', 'expired'];

export function openEvent(o) {
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
document.getElementById('evClose').onclick = () => evDlg.close();
evDlg.addEventListener('click', e => { if (e.target === evDlg) evDlg.close(); });
document.getElementById('evCopy').onclick = async e => {
  try {
    await navigator.clipboard.writeText(document.getElementById('evJson').textContent);
    e.target.textContent = t('Copiado ✓');
  } catch { e.target.textContent = t('No se pudo copiar'); }
  setTimeout(() => { e.target.textContent = t('Copiar JSON'); }, 1500);
};
