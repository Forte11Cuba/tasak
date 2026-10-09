// Panels: connection status, header (Tasa K, Yadio reference, volume, last order), executed orders,
// order book, filters and the names of the currency and the node.
import { isHidden, pmStats, defaultPmSelection } from '../shared/payment-methods.js';
import { mostUsedFiat } from '../shared/orders.js';
import { UNITS } from '../shared/units.js';
import { WEEK, MONTH, YEAR } from '../shared/time.js';
import { WINDOW, tasaK, rateBreakdown } from '../shared/rate.js';
import { state, HIDDEN_PM, nodeName } from './state.js';
import { fmtPrice, fmtPct } from './format.js';
import { btcSpot, yadioFiatPerUsd, unitName, currentPrices } from './prices.js';

export function setStatus(error) {
  const box = document.getElementById('statusBox');
  box.classList.toggle('error', !!error);
  document.getElementById('dot').classList.toggle('live', !error && state.live > 0);
  if (error) { document.getElementById('status').textContent = error; return; }
  // Shown: the essentials; on hover: the full detail
  const live = state.live > 0;
  const short = [live ? `${state.live}/${CONFIG.relays.length}` : t('Conectando…')];
  const full = [live ? t('En vivo: {live} de {total} relays conectados', { live: state.live, total: CONFIG.relays.length }) : t('Conectando con los relays…')];
  if (state.sigs === 'ok') { short.push('<span class="ok">✓</span>'); full.push(t('Firmas de los eventos verificadas en este navegador')); }
  if (state.sigs === 'off') { short.push(`<span class="warn">${t('⚠ sin verificar')}</span>`); full.push(t('Firmas sin verificar: no cargó nostr-tools')); }
  if (state.rejected) { short.push(`<span class="warn">${t('⚠ {n} rechazados', { n: state.rejected })}</span>`); full.push(t('{n} eventos rechazados por firma no válida', { n: state.rejected })); }
  if (state.btcApprox && state.unit === 'usd') { short.push(`<span class="warn">${t('⚠ USD aprox.')}</span>`); full.push(t('USD aproximado: sin precio histórico de Coinbase, se usa el BTC/USD actual de Yadio')); }
  document.getElementById('status').innerHTML = short.join(' ');
  box.title = full.join('\n');
}

export function renderStats(trades) {
  const now = Date.now() / 1000;
  const { rate: tasa, previous: prev, volume: vol, count } = tasaK(trades, now);

  const unit = `<span class="unit">${esc(unitName())}</span>`;
  const sTasa = document.getElementById('sTasa');
  sTasa.innerHTML = tasa == null ? '—' : fmtPrice(tasa) + unit;
  // Blink only if the rate changed with the same view (currency, unit, nodes and methods): that
  // way changing a filter doesn't look like a market move
  const viewKey = [state.fiat, state.unit, [...state.nodeSel], [...(state.pmSel || [])].sort()].join('|');
  const prevTasa = state.tick?.key === viewKey ? state.tick.value : null;
  if (tasa != null && prevTasa != null && Math.abs(tasa / prevTasa - 1) > 1e-9) {
    sTasa.classList.remove('tick-up', 'tick-down');
    void sTasa.offsetWidth;   // restarts the animation if it was running
    sTasa.classList.add(tasa > prevTasa ? 'tick-up' : 'tick-down');
  }
  state.tick = { key: viewKey, value: tasa };
  document.getElementById('sTasaSub').textContent = count
    ? `${nOrders(count)} · ${fmtInt(vol)} ${state.fiat}`
    : t('sin órdenes en las últimas 24h');
  renderBreakdown(trades, now);
  const lastT = trades.at(-1);
  document.getElementById('sLast').innerHTML = lastT ? fmtPrice(lastT.price) + unit : '—';
  document.getElementById('sLastSub').textContent = lastT
    ? `${fmtTime(lastT.ts)} · ${t(lastT.side === 'buy' ? 'compra de BTC' : 'venta de BTC')}` : ' ';

  // Volume of what the table shows: everything in Order mode, or the timeframe's range
  const shown = state.tf ? trades.filter(t => t.ts > now - state.tf) : trades;
  const shownVol = shown.reduce((a, t) => a + t.size, 0);
  document.getElementById('lblVol').textContent = state.tf ? t('Volumen · {range}', { range: rangeTitle(state.tf) }) : t('Volumen total');
  document.getElementById('sVol').textContent = `${fmtInt(shownVol)} ${state.fiat}`;
  const first = shown[0] && new Date(shown[0].ts * 1000).toLocaleDateString(LOCALE, { timeZone: CONFIG.tz, day: 'numeric', month: 'numeric' });
  document.getElementById('sVolSub').textContent =
    nOrders(shown.length) + (!state.tf && first ? ' · ' + t('desde {d}', { d: first }) : '');

  const chg = document.getElementById('sChg');
  if (tasa != null && prev != null) {
    const pct = (tasa / prev - 1) * 100;
    chg.textContent = `${pct >= 0 ? '▲' : '▼'} ${fmtPct(Math.abs(pct)).slice(1)}`;
    chg.className = 'chg num ' + (pct >= 0 ? 'up' : 'down');
    chg.hidden = false;
  } else { chg.hidden = true; }

  const ref = yadioFiatPerUsd();
  const refVal = ref == null ? null : state.unit === 'usd' ? ref : ref * (btcSpot() || NaN) / (state.unit === 'sat' ? 1e8 : 1);
  document.getElementById('sYadio').innerHTML = refVal == null || isNaN(refVal) ? '—' : fmtPrice(refVal) + unit;
  // How far the Tasa K is from the reference
  const diff = tasa != null && refVal ? (tasa / refVal - 1) * 100 : null;
  document.getElementById('sYadioSub').innerHTML = diff == null ? '&nbsp;'
    : `${esc(CONFIG.rateName)} <span class="${diff >= 0 ? 'up' : 'down'}">${fmtPct(diff, 1)}</span> ${t(diff >= 0 ? 'sobre Yadio' : 'bajo Yadio')}`;
  document.getElementById('statYadio').title = [
    t('Tasa de referencia de Yadio, la que usa Mostro para las órdenes a precio de mercado'), priceSource()].join('\n');
  return tasa;
}

// Buy and sell orders, market and fixed price, in the Tasa K's window: only as information, on hover
// over the Tasa K and in the FAQ
function renderBreakdown(trades, now) {
  const b = rateBreakdown(trades, now);
  const side = (s, text) => s.count && t(text, { n: nOrders(s.count), p: fmtPrice(s.rate), u: unitName() });
  const kinds = [
    t('{n} a precio de mercado', { n: b.market }) + (b.premium == null ? '' : ` (${t('prima media {p}', { p: fmtPct(b.premium, 1) })})`),
    t('{n} a precio fijo', { n: b.fixed }),
    b.unknown && t('{n} sin saber (prima 0)', { n: b.unknown }),
  ].filter(Boolean).join(' · ');
  const lines = b.buy.count + b.sell.count ? [
    side(b.buy, 'Compras de BTC: {n}, media {p} {u}'),
    side(b.sell, 'Ventas de BTC: {n}, media {p} {u}'),
    kinds,
  ].filter(Boolean) : [t('Sin órdenes en las últimas 24 horas')];
  document.getElementById('statTasa').title = [
    t('{rate}: precio ponderado de las órdenes completadas en las últimas 24 horas', { rate: CONFIG.rateName }), '', ...lines,
    t('Solo información: la {rate} pondera todas juntas', { rate: CONFIG.rateName })].join('\n');
  const html = lines.map(l => `<li>${esc(l)}</li>`).join('');
  for (const el of document.querySelectorAll('.rate-breakdown')) el.innerHTML = html;
}

// Where the current prices come from, for the tooltip of the reference
function priceSource() {
  const p = currentPrices();
  if (!p) return t('Sin precio: el nodo no publica mostro-rates válidos y la API de Yadio no respondió');
  if (p.from === 'api') return t('Consultada a la API de Yadio: el nodo no publica mostro-rates válidos');
  const r = p.rates;
  const min = Math.max(0, Math.round((Date.now() / 1000 - r.ts) / 60));
  return t('Publicada por el nodo {node} hace {m} min en un evento firmado (mostro-rates)', { node: nodeName(r.node), m: min })
    + (r.source && r.source !== 'yadio' ? ` · ${t('fuente: {s}', { s: r.source })}` : '');
}

function pmCell(o) {
  const s = o.pm.join(', ');
  return `<span class="pm" title="${esc(s)}">${esc(s)}</span>`;
}

function tradeTitle(o) {
  const parts = [t(o.side === 'buy' ? 'Orden de compra de BTC' : 'Orden de venta de BTC')];
  parts.push(o.origin ? (o.origin.fixed ? t('precio fijo') : t('precio de mercado, prima {p}%', { p: o.origin.premium })) : t('prima {p}%', { p: o.premium }));
  if (CONFIG.mostros.length > 1) parts.push(nodeName(o.node));
  return parts.join(' · ');
}

// Range of the table for the timeframe (until now); with «Orden», everything
const RANGE_NAMES = {
  3600: 'la última hora', 14400: 'las últimas 4 horas', 86400: 'las últimas 24 horas',
  [WEEK]: 'los últimos 7 días', [MONTH]: 'los últimos 30 días', [YEAR]: 'el último año',
};
const rangeName = tf => t(RANGE_NAMES[tf]);
const rangeTitle = tf => rangeName(tf).replace(/^\S+ /, '');   // without the article

export function renderTrades(trades) {
  const now = Date.now() / 1000;
  const shown = state.tf ? trades.filter(o => o.ts > now - state.tf) : trades;
  const n = nOrders(shown.length);
  document.getElementById('tradesTitle').textContent =
    state.tf ? `${t('Órdenes ejecutadas')} · ${rangeTitle(state.tf)}` : t('Órdenes ejecutadas');
  document.getElementById('tradesHint').textContent =
    state.tf ? n : `${n} · ${t('atenuadas: más de 24h')}`;
  document.getElementById('tradesHead').innerHTML =
    `<tr><th>${t('Hora')}</th><th>${t('Precio')}</th><th>${esc(state.fiat)}</th><th class="hide-sm">Sats</th><th>${t('Método')}</th></tr>`;
  const from = now - WINDOW;
  document.getElementById('trades').innerHTML = shown.slice().reverse().map(o => `
    <tr class="${o.fresh ? 'new' : ''} ${state.tf || o.ts > from ? '' : 'out'}" data-key="${esc(o.key)}" title="${t('Ver el evento Nostr de esta orden')}">
      <td class="num">${fmtTime(o.ts)}</td>
      <td class="num ${o.side === 'buy' ? 'up' : 'down'}" title="${esc(tradeTitle(o))}">${fmtPrice(o.price)}</td>
      <td class="num">${fmtInt(o.size)}</td>
      <td class="num hide-sm">${fmtInt(o.amt)}</td>
      <td>${pmCell(o)}</td>
    </tr>`).join('') || `<tr class="none"><td colspan="5">${
      state.tf ? t('Sin órdenes completadas en {range}', { range: rangeName(state.tf) }) : t('Sin órdenes completadas')}</td></tr>`;
  for (const o of state.orders.values()) o.fresh = false;
}

export function renderBook(tasa, { asks, bids }) {
  const max = Math.max(1, ...asks.map(o => o.size), ...bids.map(o => o.size));
  const row = (o, cls) => `
    <tr class="${cls}" data-d="${(o.size / max * 100).toFixed(1)}" data-key="${esc(o.key)}" title="${t('Ver el evento Nostr de esta orden abierta')}">
      <td class="num" title="${t(o.fixed ? 'Precio fijo' : 'Precio de mercado + prima')}">${fmtPrice(o.price)}${o.fixed ? ' 🔒' : ''}</td>
      <td class="num">${o.fa.length > 1 ? fmtInt(o.fa[0]) + '–' + fmtInt(o.fa[1]) : fmtInt(o.fa[0])}</td>
      <td class="num muted">${o.fixed ? '—' : (o.premium > 0 ? '+' : '') + o.premium + '%'}</td>
      <td>${pmCell(o)}</td>
    </tr>`;
  const none = txt => `<tr class="none"><td colspan="4">${txt}</td></tr>`;

  let mid = '';
  if (asks.length && bids.length) {
    const spread = asks[0].price - bids[0].price;
    mid = spread < 0
      ? `${t('Libro cruzado')} <span class="muted">${t('(hay compradores por encima de vendedores)')}</span>`
      : `${t('Diferencial')} <strong class="num">${fmtPrice(spread)}</strong> <span class="muted num">(${(spread / asks[0].price * 100).toFixed(1)}%)</span>`;
  }
  if (tasa != null) mid += `${mid ? ' · ' : ''}${esc(CONFIG.rateName)} <strong class="num">${fmtPrice(tasa)}</strong>`;

  const book = document.getElementById('book');
  book.innerHTML =
    (asks.length ? asks.slice().reverse().map(o => row(o, 'ask')).join('') : none(t('Nadie vendiendo BTC ahora'))) +
    `<tr class="mid"><td colspan="4">${mid || '&nbsp;'}</td></tr>` +
    (bids.length ? bids.map(o => row(o, 'bid')).join('') : none(t('Nadie comprando BTC ahora')));
  // Depth bar of each row (its size against the largest): set from JS, not with style="", which a
  // Content Security Policy blocks
  for (const tr of book.querySelectorAll('tr[data-d]')) tr.style.setProperty('--d', tr.dataset.d + '%');
}

export function renderFilters() {
  const orders = [...state.orders.values()];
  // Currencies present on the nodes
  const fiats = [...new Set(orders.map(o => o.fiat))].sort();
  if (state.fiatAuto && fiats.length) {
    // The currency with most completed orders (or, if none, with most orders)
    const best = mostUsedFiat(orders);
    if (best !== state.fiat) { state.fiat = best; state.pmSel = null; state.pmKnown = null; }
  }
  if (state.fiat && !fiats.includes(state.fiat)) fiats.unshift(state.fiat);
  const sel = document.getElementById('fiat');
  const html = fiats.map(f => `<option${f === state.fiat ? ' selected' : ''}>${esc(f)}</option>`).join('');
  if (sel.innerHTML !== html) sel.innerHTML = html;

  // Nodes (only if there is more than one)
  document.getElementById('nodesBox').hidden = CONFIG.mostros.length < 2;
  document.getElementById('nodes').innerHTML = CONFIG.mostros.map(k =>
    `<button class="chip${state.nodeSel.has(k) ? ' on' : ''}" data-node="${k}" title="${k}">${esc(nodeName(k))}</button>`
  ).join(' ');

  // Payment methods of that currency, with its completed and open orders (pending and not
  // expired, those in the order book); new methods that aren't hidden join the selection
  const stats = pmStats(orders, { fiat: state.fiat, nodes: state.nodeSel, now: Date.now() / 1000 });
  const keys = stats.map(s => s.key);
  const counts = new Map(stats.map(s => [s.key, s]));
  if (!state.pmSel) state.pmSel = defaultPmSelection(keys, HIDDEN_PM);
  else for (const k of keys) if (!state.pmKnown?.has(k) && !isHidden(k, HIDDEN_PM)) state.pmSel.add(k);
  state.pmKnown = new Set(keys);

  const isDefault = keys.every(k => state.pmSel.has(k) === !isHidden(k, HIDDEN_PM));
  const summary = document.getElementById('pmSummary');
  summary.classList.toggle('filtered', !isDefault);
  summary.textContent = isDefault ? `${t('Método de pago')} ▾` : `${t('Método de pago')} (${keys.filter(k => state.pmSel.has(k)).length}/${keys.length}) ▾`;

  document.getElementById('pms').innerHTML = keys.map(k =>
    `<button class="chip${state.pmSel.has(k) ? ' on' : ''}" data-pm="${esc(k)}" title="${t('{d} completadas · {o} abiertas', { d: counts.get(k).done, o: counts.get(k).open })}">${esc(t(k))}<span class="c">${counts.get(k).done} · ${counts.get(k).open}</span></button>`
  ).join(' ');
}

export function updatePair() {
  const nodes = CONFIG.mostros.length === 1 ? nodeName(CONFIG.mostros[0]) : t('{n} nodos Mostro', { n: CONFIG.mostros.length });
  const pic = CONFIG.mostros.length === 1 && state.nodeMeta.get(CONFIG.mostros[0])?.profile?.picture;
  const btn = document.getElementById('nodeBtn');
  const img = btn.querySelector('img');
  if (pic && /^https:\/\//.test(pic)) {
    if (!img) btn.insertAdjacentHTML('afterbegin', `<img alt="" src="${esc(pic)}" data-hide-broken>`);
  } else img?.remove();
  document.getElementById('pair').textContent = nodes;
  document.querySelectorAll('[data-unit]').forEach(b => b.textContent = `${state.fiat || '…'}/${UNITS[b.dataset.unit]}`);
  // Texts that name the currency or the node (/sat help and FAQ)
  const fiat = state.fiat || t('la moneda local');
  document.querySelector('[data-unit="sat"]').title =
    t('Cuántos {f} cuesta 1 sat: {f} pagados ÷ sats de cada orden, sin conversión a USD', { f: fiat });
  for (const el of document.querySelectorAll('.fiat-name')) el.textContent = state.fiat || 'XXX';
  for (const el of document.querySelectorAll('.node-names')) el.textContent = CONFIG.mostros.map(nodeName).join(', ');
}
