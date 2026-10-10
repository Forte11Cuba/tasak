// Panels: connection status, header (Tasa K, Yadio reference, volume, last order), executed orders,
// order book, filters and the names of the currency and the node.
import { isHidden, pmStats, defaultPmSelection } from '../shared/payment-methods.js';
import { mostUsedFiat } from '../shared/orders.js';
import { UNITS } from '../shared/units.js';
import { WEEK, MONTH, YEAR } from '../shared/time.js';
import { WINDOW, tasaK, lastTasaK, rateBreakdown } from '../shared/rate.js';
import { state, HIDDEN_PM, nodeName, nodePicture } from './state.js';
import { fmtPrice, fmtPct, fmtAgo } from './format.js';
import { btcSpot, yadioFiatPerUsd, unitName, currentPrices } from './prices.js';
import { isYadioOnly } from '../shared/rates.js';

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
  if (state.snapshotAt) {
    const ago = fmtAgo(Date.now() / 1000 - state.snapshotAt);
    short.push(`<span class="muted">· ${esc(ago)}</span>`);
    full.push(t('Datos del servidor de hace {t}: órdenes completadas, precios y {rate} firmada; lo nuevo llega de los relays', { t: ago, rate: CONFIG.rateName }));
  }
  if (state.snapshotMissing) {
    short.push(`<span class="warn">${t('⚠ faltan {n}', { n: state.snapshotMissing })}</span>`);
    full.push(t('El servidor no tiene {n} órdenes completadas de los últimos días que sí están en los relays: se muestran igualmente', { n: state.snapshotMissing }));
  }
  const rejected = state.rejected + state.snapshotRejected;
  if (rejected) { short.push(`<span class="warn">${t('⚠ {n} rechazados', { n: rejected })}</span>`); full.push(t('{n} eventos rechazados por firma no válida', { n: rejected })); }
  if (state.btcApprox && state.unit === 'usd') { short.push(`<span class="warn">${t('⚠ USD aprox.')}</span>`); full.push(t('USD aproximado: sin precio histórico de Coinbase, se usa el BTC/USD actual de Yadio')); }
  document.getElementById('status').innerHTML = short.join(' ');
  box.title = full.join('\n');
}

// The header: the official Tasa K (`official`, the site's rules) and, of what the visitor selected
// (`trades`), the volume and the last order, as the tables
export function renderStats(official, trades) {
  const now = Date.now() / 1000;
  const signed = signedRate(official, now);
  // Without orders in the last 24 h, the last one there was (as the server publishes it)
  const local = lastTasaK(official, now);
  // The signed Tasa K when the server publishes it (checked against this browser's), else this one
  const head = signed || local;
  const { rate: tasa, previous: prev, volume: vol, count } = head;

  const unit = `<span class="unit">${esc(unitName())}</span>`;
  const sTasa = document.getElementById('sTasa');
  sTasa.innerHTML = tasa == null ? '—' : fmtPrice(tasa) + unit;
  // Blink only if the rate changed with the same currency and unit: that way changing them doesn't
  // look like a market move (the filters don't change the official rate)
  const viewKey = [state.fiat, state.unit].join('|');
  const prevTasa = state.tick?.key === viewKey ? state.tick.value : null;
  if (tasa != null && prevTasa != null && Math.abs(tasa / prevTasa - 1) > 1e-9) {
    sTasa.classList.remove('tick-up', 'tick-down');
    void sTasa.offsetWidth;   // restarts the animation if it was running
    sTasa.classList.add(tasa > prevTasa ? 'tick-up' : 'tick-down');
  }
  state.tick = { key: viewKey, value: tasa };
  const sub = document.getElementById('sTasaSub');
  // Short, as the header has to fit in one line; the whole explanation on hover
  sub.textContent = head.emptySince
    ? t('sin órdenes 24h · de hace {t}', { t: fmtAgo(now - head.to) })
    : count ? `${nOrders(count)} · ${fmtInt(vol)} ${state.fiat}` : t('sin órdenes en las últimas 24h');
  sub.title = head.emptySince
    ? t('Sin órdenes completadas en las últimas 24 horas: es la última {rate}, la de las 24 horas anteriores a la última orden, de hace {t}', { rate: CONFIG.rateName, t: fmtAgo(now - head.to) })
    : '';
  if (signed?.mismatch) {
    sub.insertAdjacentHTML('beforeend', ` <span class="warn" title="${esc(t('La {rate} firmada por el servidor ({s}) no coincide con la calculada en este navegador con los mismos datos ({l})', { rate: CONFIG.rateName, s: fmtPrice(signed.rate), l: fmtPrice(signed.local) }))}">⚠</span>`);
  }
  // The breakdown of the same window as the rate shown
  renderBreakdown(official, head.to);
  const lastT = trades.at(-1);
  document.getElementById('sLast').innerHTML = lastT ? fmtPrice(lastT.price) + unit : '—';
  document.getElementById('sLastSub').textContent = lastT
    ? `${fmtTime(lastT.ts)} · ${t(lastT.side === 'buy' ? 'compra de BTC' : 'venta de BTC')}` : ' ';

  // Volume of what the table shows: everything in Order mode, or the timeframe's range
  const shown = state.tf ? trades.filter(t => t.ts > now - state.tf) : trades;
  const shownVol = shown.reduce((a, t) => a + t.size, 0);
  // And in sats, straight from the events (amt): the same for every currency
  const shownSats = shown.reduce((a, t) => a + t.amt, 0);
  document.getElementById('lblVol').textContent = state.tf ? t('Volumen · {range}', { range: rangeTitle(state.tf) }) : t('Volumen total');
  // Compact from a million (1,96 M), so that the header still fits in one line; exact on hover
  const sats = shownSats >= 1e6
    ? new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 2 }).format(shownSats) : fmtInt(shownSats);
  const sVol = document.getElementById('sVol');
  sVol.innerHTML = `${fmtInt(shownVol)} ${esc(state.fiat)}<span class="vol-sats"> / ${sats} sats</span>`;
  sVol.title = `${fmtInt(shownVol)} ${state.fiat} / ${fmtInt(shownSats)} sats`;
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
  // The reference is named after the node's provider when it uses one; with several, it is «the
  // node's» (its `source` tag joins the providers of every currency, not of this one)
  const p = currentPrices();
  const sources = p?.from === 'node' && p.rates.source ? p.rates.source.split(',') : ['yadio'];
  const name = sources.length === 1 ? providerName(sources[0]) : null;
  document.getElementById('lblRef').textContent = name ? t('Referencia {s}', { s: name }) : t('Referencia del nodo');
  // How far the Tasa K is from the reference
  const diff = tasa != null && refVal ? (tasa / refVal - 1) * 100 : null;
  const above = name ? t(diff >= 0 ? 'sobre {s}' : 'bajo {s}', { s: name }) : t(diff >= 0 ? 'sobre la referencia' : 'bajo la referencia');
  document.getElementById('sYadioSub').innerHTML = diff == null ? '&nbsp;'
    : `${esc(CONFIG.rateName)} <span class="${diff >= 0 ? 'up' : 'down'}">${fmtPct(diff, 1)}</span> ${esc(above)}`;
  document.getElementById('statYadio').title = [
    t(name === 'Yadio' ? 'Tasa de referencia de Yadio, la que usa Mostro para las órdenes a precio de mercado'
      : 'Precio de referencia del nodo, el que usa para las órdenes a precio de mercado'), priceSource()].join('\n');
  return tasa;
}

// «Your selection»: the weighted price of the last 24 h with the methods and nodes the visitor chose,
// only when they differ from the default ones (then it would be the Tasa K itself)
export function renderSelection(trades, official) {
  const isDefault = state.nodeSel.size === CONFIG.mostros.length
    && [...(state.pmKnown || [])].every(k => state.pmSel.has(k) === !isHidden(k, HIDDEN_PM));
  const box = document.getElementById('selection');
  box.hidden = isDefault;
  if (isDefault) return;
  // The same rule as the Tasa K: the 24 h up to its last order
  const { rate, count } = lastTasaK(trades, Date.now() / 1000);
  document.getElementById('selRate').innerHTML = rate == null ? '—'
    : fmtPrice(rate) + `<span class="unit">${esc(unitName())}</span>`;
  const diff = rate != null && official ? (rate / official - 1) * 100 : null;
  document.getElementById('selSub').textContent = count
    ? nOrders(count) + (diff == null ? '' : ' · ' + t('{p} frente a la {rate}', { p: fmtPct(diff, 1), rate: CONFIG.rateName }))
    : t('sin órdenes en las últimas 24h');
  box.title = t('Precio ponderado de las órdenes completadas en las 24 horas hasta la última, con los métodos de pago y nodos que elegiste. La {rate} usa siempre los de por defecto.', { rate: CONFIG.rateName });
}

// The Tasa K signed by the server (snapshot), in the chosen currency and unit, while its event hasn't
// expired: { rate, previous, volume, count, to, emptySince, local, mismatch }, or null. `local` is this
// browser's for the same window (ending at the event's `to`); they mismatch if they differ by more than
// one unit of the last published decimal
function signedRate(official, now) {
  const r = state.signedRate;
  if (!r || r.fiat !== state.fiat || (r.expiration && now > r.expiration)) return null;
  const inUnit = p => p?.btc == null ? null : state.unit === 'btc' ? p.btc : state.unit === 'sat' ? p.btc / 1e8 : p.usd ?? null;
  const rate = inUnit(r.rate);
  if (rate == null) return null;
  const local = tasaK(official, r.to);
  // Compared in currency/BTC for sat, whose value is currency/BTC ÷ 1e8
  const scale = state.unit === 'sat' ? 1e8 : 1;
  const mismatch = local.count > 0 && local.rate != null
    && Math.abs(local.rate * scale - rate * scale) > 10 ** -r.decimals + 1e-9;
  return {
    rate, previous: inUnit(r.previous), volume: r.volume, count: r.count, to: r.to, emptySince: r.empty_since,
    local: local.rate, mismatch,
  };
}

// Buy and sell orders, market and fixed price, in the Tasa K's window: only as information, on hover
// over the Tasa K and in the FAQ
function renderBreakdown(trades, to) {
  const b = rateBreakdown(trades, to);
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
  ].filter(Boolean) : [t('Sin órdenes completadas')];
  document.getElementById('statTasa').title = [
    t('{rate}: precio ponderado de las órdenes completadas en las 24 horas hasta la última orden ({t})', { rate: CONFIG.rateName, t: fmtTime(to) }), '', ...lines,
    t('Solo información: la {rate} pondera todas juntas', { rate: CONFIG.rateName })].join('\n');
  const html = lines.map(l => `<li>${esc(l)}</li>`).join('');
  for (const el of document.querySelectorAll('.rate-breakdown')) el.innerHTML = html;
}

// Names of Mostro's price providers (the ids of its `source` tag); others are shown as they come
const PROVIDERS = { yadio: 'Yadio', coingecko: 'CoinGecko', blockchain: 'Blockchain.com', currency_api: 'currency-api', nostr: 'Nostr' };
const providerName = id => PROVIDERS[id] || id;

// Where the current prices come from, for the tooltip of the reference
function priceSource() {
  const p = currentPrices();
  if (!p) return t('Sin precio: el nodo no publica mostro-rates válidos y la API de Yadio no respondió');
  if (p.from === 'api') return t('Consultada a la API de Yadio: el nodo no publica mostro-rates válidos');
  const r = p.rates;
  const min = Math.max(0, Math.round((Date.now() / 1000 - r.ts) / 60));
  return t('Publicada por el nodo {node} hace {m} min en un evento firmado (mostro-rates)', { node: nodeName(r.node), m: min })
    + (r.expiresAt <= Date.now() / 1000 ? '\n' + t('Precios del nodo sin actualizar: los sigue usando hasta 30 min') : '')
    + (!r.source || r.source === 'yadio' ? ''
      : '\n' + t(r.source.includes(',') ? 'Fuentes del nodo (de todas sus monedas): {s}' : 'Fuente: {s}',
        { s: r.source.split(',').map(providerName).join(', ') }));
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
    <tr class="${o.fresh ? 'new' : ''} ${state.tf || o.ts > from ? '' : 'out'}" data-key="${esc(o.key)}" title="${o.unsigned ? t('Orden de la base de datos del nodo, sin firma: ver detalles') : t('Ver el evento Nostr de esta orden')}">
      <td class="num">${fmtTime(o.ts)}${o.unsigned ? ` <span class="unsigned" title="${t('Sin firma: de la base de datos del nodo')}">◌</span>` : ''}</td>
      <td class="num ${o.side === 'buy' ? 'up' : 'down'}" title="${esc(tradeTitle(o))}">${fmtPrice(o.price)}</td>
      <td class="num">${fmtInt(o.size)}</td>
      <td class="num hide-sm">${fmtInt(o.amt)}</td>
      <td>${pmCell(o)}</td>
    </tr>`).join('') || `<tr class="none"><td colspan="5">${
      state.tf ? t('Sin órdenes completadas en {range}', { range: rangeName(state.tf) }) : t('Sin órdenes completadas')}</td></tr>`;
  for (const o of state.orders.values()) o.fresh = false;
}

// Where the price of an order in the book comes from (its tooltip)
function bookPriceTitle(o) {
  if (o.fixed) return t('Precio fijo');
  const m = o.market;
  if (!m) return t('Sin precio: el nodo no publica el suyo y la API de Yadio no respondió');
  const node = CONFIG.mostros.length > 1 ? ` · ${nodeName(o.node)}` : '';
  if (m.from === 'api') {
    return t('Precio estimado con Yadio + prima: el nodo no publica el suyo') + node
      + (m.source && !isYadioOnly(m.source) ? '\n' + t('El nodo usa: {s}', { s: m.source.split(',').map(providerName).join(', ') }) : '');
  }
  return t('Precio de mercado del nodo + prima') + node
    + (m.expired ? '\n' + t('Precios del nodo sin actualizar: los sigue usando hasta 30 min') : '');
}

export function renderBook(tasa, { asks, bids }) {
  const max = Math.max(1, ...asks.map(o => o.size), ...bids.map(o => o.size));
  const row = (o, cls) => `
    <tr class="${cls}" data-d="${(o.size / max * 100).toFixed(1)}" data-key="${esc(o.key)}" title="${t('Ver el evento Nostr de esta orden abierta')}">
      <td class="num" title="${esc(bookPriceTitle(o))}">${o.market?.from === 'api' ? '≈ ' : ''}${fmtPrice(o.price)}${o.fixed ? ' 🔒' : ''}</td>
      <td class="num">${o.fa.length > 1 ? fmtInt(o.fa[0]) + '–' + fmtInt(o.fa[1]) : fmtInt(o.fa[0])}</td>
      <td class="num muted">${o.fixed ? '—' : (o.premium > 0 ? '+' : '') + o.premium + '%'}</td>
      <td>${pmCell(o)}</td>
    </tr>`;
  const none = txt => `<tr class="none"><td colspan="4">${txt}</td></tr>`;

  // Best prices: the orders without price go last
  const bestAsk = asks.find(o => o.price != null), bestBid = bids.find(o => o.price != null);
  let mid = '';
  if (bestAsk && bestBid) {
    const spread = bestAsk.price - bestBid.price;
    mid = spread < 0
      ? `${t('Libro cruzado')} <span class="muted">${t('(hay compradores por encima de vendedores)')}</span>`
      : `${t('Diferencial')} <strong class="num">${fmtPrice(spread)}</strong> <span class="muted num">(${(spread / bestAsk.price * 100).toFixed(1)}%)</span>`;
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

  renderNodeMenu();

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

// The page for a node of the selector: the site's own (no node in the URL) or another one, keeping only
// the language of the URL
export function nodeUrl(k) {
  const q = new URLSearchParams();
  if (k) q.set('mostro', k);
  const lang = new URLSearchParams(location.search).get('lang');
  if (lang) q.set('lang', lang);
  return location.pathname + (q.size ? '?' + q : '');
}

// The node selector, next to the Tasa K: the nodes shown (with their picture), and in its menu the
// site's nodes (.env), its guests and the node of the URL, in that order, then a field for any npub.
// With the site's nodes, those rows are the node filter (at least one stays selected); every other row
// opens that node's page
function renderNodeMenu() {
  const sel = CONFIG.mostros.filter(k => state.nodeSel.has(k));
  const pic = nodePicture(sel[0]);
  const summary = document.getElementById('nodeSummary');
  const html = (pic ? `<img alt="" src="${esc(pic)}" data-hide-broken>` : '<span class="no-pic"></span>')
    + `<span class="name">${esc(nodeName(sel[0] || ''))}</span>${sel.length > 1 ? `<span>+${sel.length - 1}</span>` : ''}<span class="caret">▾</span>`;
  if (summary.dataset.html !== html) { summary.innerHTML = html; summary.dataset.html = html; }
  summary.title = `${sel.map(nodeName).join(', ')}\n${t('Elegir nodo Mostro')}`;
  summary.classList.toggle('filtered', sel.length < CONFIG.mostros.length);

  const row = (k, { on, href }) => {
    const p = nodePicture(k);
    const inner = (p ? `<img alt="" src="${esc(p)}" data-hide-broken>` : '<span class="no-pic"></span>')
      + `<span class="name">${esc(nodeName(k))}</span>${on ? '<span class="check">✓</span>' : ''}`;
    return href
      ? `<a class="node-row${on ? ' on' : ''}" href="${esc(href)}" title="${k}">${inner}</a>`
      : `<button class="node-row${on ? ' on' : ''}" type="button" data-node="${k}" title="${k}">${inner}</button>`;
  };
  const guests = [...CONFIG.otherMostros];
  // A node of the URL that is neither the site's nor a guest (a pasted npub): with the guests, first
  if (CONFIG.urlNodes) for (const k of CONFIG.mostros) if (!CONFIG.siteMostros.includes(k) && !guests.includes(k)) guests.unshift(k);
  const groups = [
    CONFIG.siteMostros.map(k => CONFIG.urlNodes ? row(k, { href: nodeUrl('') }) : row(k, { on: state.nodeSel.has(k) })),
    guests.map(k => row(k, { on: CONFIG.urlNodes && CONFIG.mostros.includes(k), href: nodeUrl(k) })),
  ].filter(g => g.length).map(g => g.join(''));
  const list = groups.join('<hr>');
  const box = document.getElementById('nodes');
  if (box.dataset.html !== list) { box.innerHTML = list; box.dataset.html = list; }
}

export function updatePair() {
  document.querySelectorAll('[data-unit]').forEach(b => b.textContent = `${state.fiat || '…'}/${UNITS[b.dataset.unit]}`);
  // Texts that name the currency or the node (/sat help and FAQ)
  const fiat = state.fiat || t('la moneda local');
  document.querySelector('[data-unit="sat"]').title =
    t('Cuántos {f} cuesta 1 sat: {f} pagados ÷ sats de cada orden, sin conversión a USD', { f: fiat });
  for (const el of document.querySelectorAll('.fiat-name')) el.textContent = state.fiat || 'XXX';
  for (const el of document.querySelectorAll('.node-names')) el.textContent = CONFIG.mostros.map(nodeName).join(', ');
}
