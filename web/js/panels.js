// Panels: connection status, header (Tasa K, Yadio reference, volume, last order), executed orders,
// order book, filters and the names of the currency and the node.
import { isHidden, pmStats, defaultPmSelection } from '../shared/payment-methods.js';
import { mostUsedFiat } from '../shared/orders.js';
import { UNITS } from '../shared/units.js';
import { WEEK, MONTH, YEAR } from '../shared/time.js';
import { WINDOW, tasaK, lastTasaK, rateBreakdown } from '../shared/rate.js';
import { state, HIDDEN_PM, nodeName, nodePicture, assetTicker, publisherName } from './state.js';
import { fmtPrice, fmtPct, fmtAgo, fmtAmt } from './format.js';
import { P, P_HIDDEN, p2p, syncPlatformFilters, platformUrl, platformMethod } from './platform.js';
import { btcSpot, yadioFiatPerUsd, unitName, currentPrices } from './prices.js';
import { isYadioOnly } from '../shared/rates.js';

export function setStatus(error) {
  const box = document.getElementById('statusBox');
  box.classList.toggle('error', !!error);
  document.getElementById('dot').classList.toggle('live', !error && state.live > 0);
  if (error) { document.getElementById('status').textContent = error; return; }
  // Shown: the essentials; on hover: the full detail. On a platform's page, the relays that refuse its
  // events (kind 35353) don't count: they aren't down
  const live = state.live > 0;
  const total = CONFIG.relays.length - (state.refused || 0);
  const short = [live ? `${state.live}/${total}` : t('Conectando…')];
  const full = [live ? t('En vivo: {live} de {total} relays conectados', { live: state.live, total }) : t('Conectando con los relays…')];
  if (state.refused) full.push(t(state.refused === 1 ? '1 relay no acepta los eventos de otras plataformas (kind 35353)'
    : '{n} relays no aceptan los eventos de otras plataformas (kind 35353)', { n: state.refused }));
  if (P) {
    full.push(t('Operaciones y órdenes que guardan los relays, leídas en este navegador'));
    if (p2p.ignored.size) full.push(t('{n} eventos ignorados por no seguir el formato del NIP', { n: p2p.ignored.size }));
  }
  if (state.sigs === 'ok') { short.push('<span class="ok">✓</span>'); full.push(t('Firmas de los eventos verificadas en este navegador')); }
  if (state.sigs === 'off') { short.push(`<span class="warn">${t('⚠ sin verificar')}</span>`); full.push(t('Firmas sin verificar: no cargó nostr-tools')); }
  if (state.snapshotAt) {
    const age = Date.now() / 1000 - state.snapshotAt;
    const ago = fmtAgo(age);
    // Only on hover while it is recent: in the header, as a warning, once the server is 10 min late
    if (age > 600) short.push(`<span class="warn">· ${esc(ago)}</span>`);
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
  const signed = P ? null : signedRate(official, now);
  // Without orders in the last 24 h, the last one there was (as the server publishes it)
  const local = lastTasaK(official, now);
  // The signed Tasa K when the server publishes it (checked against this browser's), else this one
  const head = signed || local;
  const { previous: prev, volume: vol, count } = head;
  // While the history loads, an old order alone (the newest ones may not have come yet) isn't the rate
  const waiting = state.loading && !!head.emptySince;
  const tasa = waiting ? null : head.rate;

  const unit = `<span class="unit">${esc(unitName())}</span>`;
  const sTasa = document.getElementById('sTasa');
  sTasa.innerHTML = tasa == null ? '—' : fmtPrice(tasa) + unit;
  // Blink only if the rate changed with the same currency and unit: that way changing them doesn't
  // look like a market move (the filters don't change the official rate)
  const viewKey = [state.fiat, state.unit, state.asset, P ? [...state.pmSel] : ''].join('|');
  const prevTasa = state.tick?.key === viewKey ? state.tick.value : null;
  if (tasa != null && prevTasa != null && Math.abs(tasa / prevTasa - 1) > 1e-9) {
    sTasa.classList.remove('tick-up', 'tick-down');
    void sTasa.offsetWidth;   // restarts the animation if it was running
    sTasa.classList.add(tasa > prevTasa ? 'tick-up' : 'tick-down');
  }
  state.tick = { key: viewKey, value: tasa };
  const sub = document.getElementById('sTasaSub');
  // Short, as the header has to fit in one line; the whole explanation on hover
  sub.textContent = waiting ? t('cargando…') : head.emptySince
    ? t('sin órdenes 24h · de hace {t}', { t: fmtAgo(now - head.to) })
    : count ? `${nOrders(count)} · ${fmtInt(vol)} ${state.fiat}` : t(state.loading ? 'cargando…' : 'sin órdenes en las últimas 24h');
  sub.title = head.emptySince && !waiting
    ? t('Sin órdenes completadas en las últimas 24 horas: es la última {rate}, la de las 24 horas anteriores a la última orden, de hace {t}', { rate: CONFIG.rateName, t: fmtAgo(now - head.to) })
    : '';
  if (signed?.mismatch) {
    sub.insertAdjacentHTML('beforeend', ` <span class="warn" title="${esc(t('La {rate} firmada por el servidor ({s}) no coincide con la calculada en este navegador con los mismos datos ({l})', { rate: CONFIG.rateName, s: fmtPrice(signed.rate), l: fmtPrice(signed.local) }))}">⚠</span>`);
  }
  // The breakdown of the same window as the rate shown
  renderBreakdown(official, head.to);
  const lastT = trades.at(-1);
  document.getElementById('sLast').innerHTML = lastT ? fmtPrice(lastT.price) + unit : '—';
  // Buy or sell alone, as the pair already says of what; whole on hover
  const lastSub = document.getElementById('sLastSub');
  lastSub.textContent = lastT ? `${fmtTime(lastT.ts)} · ${t(lastT.side === 'buy' ? 'compra' : 'venta')}` : ' ';
  lastSub.title = lastT ? `${sideName(lastT.side)}\n${tzNote(lastT.ts)}` : '';

  // Volume of what the table shows: everything in Order mode, or the timeframe's range
  const shown = state.tf ? trades.filter(t => t.ts > now - state.tf) : trades;
  const shownVol = shown.reduce((a, t) => a + t.size, 0);
  // And in sats (on a platform, in the asset), straight from the events (amt): the same for every currency
  const shownSats = shown.reduce((a, t) => a + t.amt, 0);
  document.getElementById('lblVol').textContent = state.tf ? t('Volumen · {range}', { range: rangeTitle(state.tf) }) : t('Volumen total');
  // Both compact from a million (1,74 M), so that the header still fits in one line; exact on hover
  const compact = (n, fmt) => n >= 1e6 ? new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 2 }).format(n) : fmt(n);
  const sats = compact(shownSats, P ? fmtAmt : fmtInt);
  const amtUnit = P ? assetTicker() : 'sats';
  const sVol = document.getElementById('sVol');
  sVol.innerHTML = `${compact(shownVol, fmtInt)} ${esc(state.fiat)}<span class="vol-sats"> / ${sats} ${esc(amtUnit)}</span>`;
  sVol.title = `${fmtInt(shownVol)} ${state.fiat} / ${P ? fmtAmt(shownSats) : fmtInt(shownSats)} ${amtUnit}`;
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

  // A platform has no reference price: its premiums are over a market price of its own, not published
  document.getElementById('statYadio').hidden = !!P;
  if (P) return tasa;
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
  // Short (the sign and the colour say above or below); the sentence on hover
  document.getElementById('sYadioSub').innerHTML = diff == null ? '&nbsp;'
    : `${esc(CONFIG.rateName)} <span class="${diff >= 0 ? 'up' : 'down'}">${fmtPct(diff, 1)}</span>`;
  document.getElementById('statYadio').title = [
    diff != null && `${CONFIG.rateName} ${fmtPct(diff, 1)} ${above}`,
    t(name === 'Yadio' ? 'Tasa de referencia de Yadio, la que usa Mostro para las órdenes a precio de mercado'
      : 'Precio de referencia del nodo, el que usa para las órdenes a precio de mercado'), priceSource()].filter(Boolean).join('\n');
  return tasa;
}

// «Your selection»: the weighted price of the last 24 h with the methods and nodes the visitor chose,
// only when they differ from the default ones (then it would be the Tasa K itself)
export function renderSelection(trades, official) {
  // On a platform the visitor only chooses what the rate is of (currency, asset, method): it is the rate
  const isDefault = !!P || state.nodeSel.size === CONFIG.mostros.length
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
  const side = (s, text) => s.count && t(text, { n: nOrders(s.count), p: fmtPrice(s.rate), u: unitName(), a: assetTicker() });
  if (P) return renderPlatformBreakdown(b, side, to);
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

// On a platform's page: buys and sells (its trades say nothing of market or fixed price)
function renderPlatformBreakdown(b, side, to) {
  const lines = b.buy.count + b.sell.count ? [
    side(b.buy, 'Compras de {a}: {n}, media {p} {u}'),
    side(b.sell, 'Ventas de {a}: {n}, media {p} {u}'),
  ].filter(Boolean) : [t('Sin operaciones')];
  document.getElementById('statTasa').title = [
    t('{rate} de {p} con {m}: precio ponderado de sus operaciones firmadas con ese método en las 24 horas hasta la última ({t}). Se calcula en este navegador; no es la {rate} oficial de este sitio.', { rate: CONFIG.rateName, p: P.name, m: platformMethod() ?? '—', t: fmtTime(to) }), '', ...lines].join('\n');
  const html = lines.map(l => `<li>${esc(l)}</li>`).join('');
  for (const el of document.querySelectorAll('.rate-breakdown')) el.innerHTML = html;
}

// «compra de BTC», or of the platform's asset
const sideName = side => P ? t(side === 'buy' ? 'compra de {a}' : 'venta de {a}', { a: assetTicker() })
  : t(side === 'buy' ? 'compra de BTC' : 'venta de BTC');

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
  if (P) return [t(o.side === 'buy' ? 'Orden de compra de {a}' : 'Orden de venta de {a}', { a: assetTicker() }),
    o.maker === 'platform' && t('de la propia plataforma')].filter(Boolean).join(' · ');
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
    `<tr><th title="${esc(tzNote())}">${t('Hora')}</th><th>${t('Precio')}</th><th>${esc(state.fiat)}</th><th class="hide-sm">${P ? esc(assetTicker()) : 'Sats'}</th><th>${t('Método')}</th></tr>`;
  const from = now - WINDOW;
  document.getElementById('trades').innerHTML = shown.slice().reverse().map(o => `
    <tr class="${o.fresh ? 'new' : ''} ${state.tf || o.ts > from ? '' : 'out'}" data-key="${esc(o.key)}" title="${o.unsigned ? t('Orden de la base de datos del nodo, sin firma: ver detalles') : t('Ver el evento Nostr de esta orden')}">
      <td class="num">${fmtTime(o.ts)}${o.unsigned ? ` <span class="unsigned" title="${t('Sin firma: de la base de datos del nodo')}">◌</span>` : ''}</td>
      <td class="num ${o.side === 'buy' ? 'up' : 'down'}" title="${esc(tradeTitle(o))}">${fmtPrice(o.price)}</td>
      <td class="num">${fmtInt(o.size)}</td>
      <td class="num hide-sm">${P ? fmtAmt(o.amt) : fmtInt(o.amt)}</td>
      <td>${pmCell(o)}</td>
    </tr>`).join('') || `<tr class="none"><td colspan="5">${state.loading ? t('Cargando órdenes de los relays…')
      : state.tf ? t('Sin órdenes completadas en {range}', { range: rangeName(state.tf) }) : t('Sin órdenes completadas')}</td></tr>`;
  for (const o of (P ? p2p.docs : state.orders).values()) o.fresh = false;
}

// Where the price of an order in the book comes from (its tooltip)
function bookPriceTitle(o) {
  if (P) return o.fixed ? t('Precio fijo de la orden')
    : t('Sin precio: prima sobre un precio de mercado de la plataforma, que no se publica');
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
      <td class="num" title="${esc(bookPriceTitle(o))}">${o.market?.from === 'api' ? '≈ ' : ''}${fmtPrice(o.price)}${o.fixed && !P ? ' 🔒' : ''}</td>
      <td class="num">${o.fa.length > 1 ? fmtInt(o.fa[0]) + '–' + fmtInt(o.fa[1]) : fmtInt(o.fa[0])}</td>
      <td class="num muted">${o.premium == null || (o.fixed && !P) ? '—' : (o.premium > 0 ? '+' : '') + o.premium + '%'}</td>
      <td>${pmCell(o)}</td>
    </tr>`;
  // Open orders come only from the relays (the server's snapshot doesn't carry them)
  const none = txt => `<tr class="none"><td colspan="4">${state.loading || !state.live ? t('Cargando…') : txt}</td></tr>`;

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
    (asks.length ? asks.slice().reverse().map(o => row(o, 'ask')).join('') : none(P ? t('Nadie vendiendo {a} ahora', { a: esc(assetTicker()) }) : t('Nadie vendiendo BTC ahora'))) +
    `<tr class="mid"><td colspan="4">${mid || '&nbsp;'}</td></tr>` +
    (bids.length ? bids.map(o => row(o, 'bid')).join('') : none(P ? t('Nadie comprando {a} ahora', { a: esc(assetTicker()) }) : t('Nadie comprando BTC ahora')));
  // Depth bar of each row (its size against the largest): set from JS, not with style="", which a
  // Content Security Policy blocks
  for (const tr of book.querySelectorAll('tr[data-d]')) tr.style.setProperty('--d', tr.dataset.d + '%');
  centerBook(book);
}

// The order book opens centred on its middle row (spread and rate), between the best sells and buys, as
// in an exchange; once the visitor scrolls it, it stays where they leave it until the view changes
let bookView = { key: null, moved: false };
const bookBox = document.getElementById('book').closest('.scroll');
for (const ev of ['wheel', 'touchmove', 'keydown']) bookBox.addEventListener(ev, () => { bookView.moved = true; }, { passive: true });
// Dragging its scrollbar (a click on a row opens the order)
bookBox.addEventListener('pointerdown', e => { if (!e.target.closest('tr')) bookView.moved = true; });
function centerBook(book) {
  const key = [state.fiat, state.unit, state.asset, [...(state.pmSel || [])].sort(), [...state.nodeSel]].join('|');
  if (key !== bookView.key) bookView = { key, moved: false };
  const mid = book.querySelector('tr.mid');
  if (bookView.moved || !mid) return;
  const head = bookBox.querySelector('thead')?.offsetHeight || 0;
  const box = bookBox.getBoundingClientRect(), row = mid.getBoundingClientRect();
  bookBox.scrollTop += row.top - box.top - head - (bookBox.clientHeight - head - row.height) / 2;
}

export function renderFilters() {
  if (P) return renderPlatformFilters();
  const orders = [...state.orders.values()];
  // Currencies present on the nodes
  const fiats = [...new Set(orders.map(o => o.fiat))].sort();
  if (state.fiatAuto && fiats.length) {
    // The currency with most completed orders (or, if none, with most orders)
    const best = mostUsedFiat(orders);
    if (best !== state.fiat) { state.fiat = best; state.pmSel = null; state.pmKnown = null; }
  }
  if (state.fiat && !fiats.includes(state.fiat)) fiats.unshift(state.fiat);
  renderFiats(fiats);

  renderNodeMenu();

  // Payment methods of that currency, with its completed and open orders (pending and not
  // expired, those in the order book); new methods that aren't hidden join the selection
  const stats = pmStats(orders, { fiat: state.fiat, nodes: state.nodeSel, now: Date.now() / 1000 });
  const keys = stats.map(s => s.key);
  if (!state.pmSel) state.pmSel = defaultPmSelection(keys, HIDDEN_PM);
  else for (const k of keys) if (!state.pmKnown?.has(k) && !isHidden(k, HIDDEN_PM)) state.pmSel.add(k);
  state.pmKnown = new Set(keys);
  renderPms(stats, HIDDEN_PM);
}

// The currencies of the bar's selector
function renderFiats(fiats) {
  const sel = document.getElementById('fiat');
  const html = fiats.map(f => `<option${f === state.fiat ? ' selected' : ''}>${esc(f)}</option>`).join('');
  if (sel.innerHTML !== html) sel.innerHTML = html;
}

// The payment methods' menu: each with its completed and open orders. A platform's methods are shown as
// it publishes them (only «Pruebas» and «Sin método» are translated)
function renderPms(stats, hidden) {
  const keys = stats.map(s => s.key);
  const counts = new Map(stats.map(s => [s.key, s]));
  const name = k => !P || k === 'Pruebas' || k === 'Sin método' ? t(k) : k;
  if (P) return renderPlatformPms(keys, counts, name, hidden);
  const isDefault = keys.every(k => state.pmSel.has(k) === !isHidden(k, hidden));
  const summary = document.getElementById('pmSummary');
  summary.classList.toggle('filtered', !isDefault);
  summary.textContent = isDefault ? `${t('Método de pago')} ▾` : `${t('Método de pago')} (${keys.filter(k => state.pmSel.has(k)).length}/${keys.length}) ▾`;

  document.getElementById('pms').innerHTML = keys.map(k =>
    `<button class="chip${state.pmSel.has(k) ? ' on' : ''}" data-pm="${esc(k)}" title="${t('{d} completadas · {o} abiertas', { d: counts.get(k).done, o: counts.get(k).open })}">${esc(name(k))}<span class="c">${counts.get(k).done} · ${counts.get(k).open}</span></button>`
  ).join(' ');
}

// A platform's methods: a selector next to the currency and the asset, one at a time, since each one is a
// market with its own price (an average of two would mix them). With its trades; the hidden ones last,
// never chosen by default
function renderPlatformPms(keys, counts, name, hidden) {
  const m = [...state.pmSel][0];
  const sel = document.getElementById('pmSelect');
  const html = keys.map(k => {
    const title = t('{d} operaciones · {o} abiertas', { d: counts.get(k).done, o: counts.get(k).open })
      + (isHidden(k, hidden) ? ' · ' + t('No se elige por defecto') : '');
    return `<option value="${esc(k)}"${k === m ? ' selected' : ''} title="${esc(title)}">${esc(name(k))} (${counts.get(k).done})</option>`;
  }).join('') || '<option>—</option>';
  if (sel.innerHTML !== html) sel.innerHTML = html;
  sel.title = m ? t('{rate} de las operaciones con {m}: cada método es un mercado con su propio precio', { rate: CONFIG.rateName, m: name(m) }) : '';
}

// A platform's bar: currency, asset (instead of the unit) and payment method
function renderPlatformFilters() {
  const { stats, fiats } = syncPlatformFilters();
  renderFiats(fiats);
  renderNodeMenu();
  const sel = document.getElementById('asset');
  // The ticker alone, unless two assets share it (USDT on two layers); what it is, on hover
  const same = c => state.assets.filter(a => a.c === c).length > 1;
  const label = a => a.c.toUpperCase() + (same(a.c) ? ` · ${a.layer}` : '') + (a.network !== 'mainnet' ? ` · ${a.network}` : '');
  const html = state.assets.map(a => `<option value="${esc(a.id)}"${a.id === state.asset ? ' selected' : ''}>${esc(label(a))}</option>`).join('')
    || '<option>—</option>';
  if (sel.innerHTML !== html) sel.innerHTML = html;
  const a = state.assets.find(x => x.id === state.asset);
  sel.title = !a ? '' : a.layer === 'internal'
    ? t('Saldo en una cuenta de {p}, no en una cadena de bloques: solo vale dentro de la plataforma', { p: P.name })
    : t('Activo en {l} ({n}){c}', { l: a.layer, n: a.network, c: a.contract ? ' · ' + a.contract : '' });
  renderPms(stats, P_HIDDEN);
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
  renderPlatformSelector();
  if (P) return renderPlatformMenu();
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
  setMenu(groups.join('<hr>'));
}

const setMenu = html => {
  const box = document.getElementById('nodes');
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
};
const picHtml = k => {
  const p = nodePicture(k);
  return p ? `<img alt="" src="${esc(p)}" data-hide-broken>` : '<span class="no-pic"></span>';
};

const MOSTRO_LOGO = '<img alt="" src="vendor/mostro-logo.png">';

// The platform selector, before the node's: Mostro and each platform of .env, each one opening its page.
// Only with other platforms in .env
function renderPlatformSelector() {
  const box = document.getElementById('platformStat');
  box.hidden = !CONFIG.platforms.length;
  if (box.hidden) return;
  const summary = document.getElementById('platformSummary');
  const html = (P ? picHtml(P.keys[0]) : MOSTRO_LOGO) + `<span class="name">${esc(P ? P.name : 'Mostro')}</span><span class="caret">▾</span>`;
  if (summary.dataset.html !== html) { summary.innerHTML = html; summary.dataset.html = html; }
  const row = (name, href, on, pic) => `<a class="node-row${on ? ' on' : ''}" href="${esc(href)}">${pic}<span class="name">${esc(name)}</span>${on ? '<span class="check">✓</span>' : ''}</a>`;
  const list = row('Mostro', nodeUrl(''), !P, MOSTRO_LOGO)
    + CONFIG.platforms.map(p => row(p.name, platformUrl(p.name, ''), P?.name === p.name, picHtml(p.keys[0]))).join('');
  const el = document.getElementById('platformList');
  if (el.dataset.html !== list) { el.innerHTML = list; el.dataset.html = list; }
}

// On a platform's page, the node selector is that of its accounts: the keys that publish for it, by their
// profile's name or NIP-05 domain. With only one, nothing to choose: no arrow and no menu
function renderPlatformMenu() {
  const summary = document.getElementById('nodeSummary');
  const many = P.keys.length > 1;
  // A single account: no block, but its place is kept, so the header doesn't move when changing platform
  document.getElementById('nodeStat').classList.toggle('slot-empty', !many);
  const html = picHtml(P.key) + `<span class="name">${esc(publisherName(P.key))}</span>${many ? '<span class="caret">▾</span>' : ''}`;
  if (summary.dataset.html !== html) { summary.innerHTML = html; summary.dataset.html = html; }
  summary.classList.toggle('single', !many);
  summary.title = `${publisherName(P.key)} · ${P.key}\n${t('Cuenta de Nostr que firma las órdenes y operaciones de {p}', { p: P.name })}`;
  setMenu(P.keys.map(k => {
    const on = k === P.key;
    return `<a class="node-row${on ? ' on' : ''}" href="${esc(platformUrl(P.name, k === P.keys[0] ? '' : k))}" title="${k}">${picHtml(k)}<span class="name">${esc(publisherName(k))}</span>${on ? '<span class="check">✓</span>' : ''}</a>`;
  }).join(''));
}

export function updatePair() {
  for (const el of document.querySelectorAll('.mostro-only')) el.hidden = !!P;
  for (const el of document.querySelectorAll('.platform-only')) el.hidden = !P;
  document.querySelectorAll('[data-unit]').forEach(b => b.textContent = `${UNITS[b.dataset.unit]}/${state.fiat || '…'}`);
  // Texts that name the currency or the node (/sat help and FAQ)
  const fiat = state.fiat || t('la moneda local');
  document.querySelector('[data-unit="sat"]').title =
    t('Cuántos {f} cuesta 1 sat: {f} pagados ÷ sats de cada orden, sin conversión a USD', { f: fiat });
  for (const el of document.querySelectorAll('.fiat-name')) el.textContent = state.fiat || 'XXX';
  for (const el of document.querySelectorAll('.node-names')) el.textContent = P ? P.name : CONFIG.mostros.map(nodeName).join(', ');
}
