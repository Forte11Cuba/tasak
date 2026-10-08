// The logic of the rate comes from shared/ (pure, tested with node --test); this script holds the
// data (relays, signatures, external prices), the chart and the interface.
import { pmListFor, hiddenSet, isHidden, pmStats, defaultPmSelection } from '../shared/payment-methods.js';
import { parseOrder, nextVersion, getTrades as tradesOf, getBook as bookOf, mostUsedFiat } from '../shared/orders.js';
import { UNITS, toUnit, hourlyClose } from '../shared/units.js';
import { WEEK, MONTH, YEAR } from '../shared/time.js';
import { WINDOW, tasaK, chartPoints } from '../shared/rate.js';

// ---------- Configuration: .env (config.js) with the URL on top ----------

const MOSTROS = new Set(CONFIG.mostros);
// Methods that don't count by default (HIDDEN_PAYMENT_METHODS in .env)
const HIDDEN_PM = hiddenSet(CONFIG.hiddenPaymentMethods);

const state = {
  orders: new Map(),   // pubkey:d -> newest version of the order
  seen: new Set(),     // ids of events already processed (they arrive repeated from several relays)
  nodeNames: new Map(),
  nodeMeta: new Map(),   // pubkey -> { profile, info, relays } read from its Nostr events
  newest: 0,
  rejected: 0,
  btcusd: new Map(),   // unix hour -> BTC/USD
  btcLoadedFrom: Infinity,
  btcRetryAt: 0,       // after a Coinbase failure, don't retry before this time (ms)
  btcApprox: false,
  yadio: null,         // { BTC, USD: { CUP, ... } }
  fiat: CONFIG.fiat,
  fiatAuto: !CONFIG.fiat,   // no FIAT in .env or URL: the most used currency on the node
  unit: 'usd',
  // 'line' = price, 'candles' = candles, 'avg' = weighted; by default the price of each order,
  // or the last view chosen in this browser
  mode: 'line',
  tf: 0,               // chart period in seconds; 0 = one point per order
  pmSel: null,         // Set of active methods; null = defaults
  nodeSel: new Set(CONFIG.mostros),
  live: 0,
  sigs: 'cargando',
};

// Last chart view chosen (mode and timeframe)
try {
  const v = JSON.parse(localStorage.getItem('tasak.view'));
  if (['line', 'candles', 'avg'].includes(v?.mode)) state.mode = v.mode;
  if ([0, 3600, 14400, 86400, 604800, 2592000, 31536000].includes(v?.tf)) state.tf = v.tf;
} catch {}
const saveView = () => { try { localStorage.setItem('tasak.view', JSON.stringify({ mode: state.mode, tf: state.tf })); } catch {} };

const shortKey = k => k.slice(0, 8) + '…';
const nodeName = k => state.nodeNames.get(k) || shortKey(k);

// ---------- Signature verification ----------
// Without it, a relay could inject fake events with the node's pubkey.
// nostr-tools comes in vendor/; if it still didn't load, we go on unverified and say so.
const verifyEvent = window.NostrTools?.verifyEvent ?? null;
state.sigs = verifyEvent ? 'ok' : 'off';

// ---------- Payment methods ----------
// Makers type the method by hand; it is matched against the Mostro app's list for that currency
// (vendor/mostro-payment-methods.js) and whatever doesn't match goes to «Otros»
const PM_LISTS = window.MOSTRO_PAYMENT_METHODS || {};
const pmList = fiat => pmListFor(PM_LISTS, fiat);

// ---------- Nostr ----------
// Returns true if the event changed the state
function handleEvent(ev) {
  if (!ev || state.seen.has(ev.id)) return false;
  if (!MOSTROS.has(ev.pubkey) || (ev.kind !== 38383 && !META_KINDS.includes(ev.kind))) return false;
  if (verifyEvent && !verifyEvent(ev)) { state.rejected++; return false; }
  state.seen.add(ev.id);
  if (ev.kind !== 38383) {
    if (!applyMeta(state.nodeMeta, ev)) return false;
    const name = state.nodeMeta.get(ev.pubkey).profile?.name;
    if (name) state.nodeNames.set(ev.pubkey, name);
    return true;
  }
  state.newest = Math.max(state.newest, ev.created_at);

  const o = parseOrder(ev, pmList);
  if (!o) return false;
  if (o.nodeName) state.nodeNames.set(ev.pubkey, o.nodeName);
  // The newest version wins; the pending one, if seen, is kept as its origin (market or fixed price)
  const next = nextVersion(state.orders.get(o.key), o);
  if (!next) return false;
  state.orders.set(o.key, next);
  return true;
}

// Relays limit the events per query: we page backwards with `until` until a page comes back
// empty, and then open the live subscription.
const PAGE = 300;

function connect(url, attempt = 0) {
  let ws;
  try { ws = new WebSocket(url); } catch { return; }
  const base = { kinds: [38383], authors: CONFIG.mostros };
  // On reconnect we only ask for what is new
  const since = state.newest ? { since: state.newest - 3600 } : {};
  let page = 0, count = 0, oldest = Infinity, prevOldest = Infinity;
  let isLive = false, opened = false, startedAt = 0, changed = false;
  const req = (id, extra) => ws.send(JSON.stringify(['REQ', id, { ...base, ...since, ...extra }]));

  ws.onopen = () => {
    opened = true;
    startedAt = Math.floor(Date.now() / 1000);
    req('hist0', { limit: PAGE });
    // Profile, information and relays of the node
    ws.send(JSON.stringify(['REQ', 'meta', { kinds: META_KINDS, authors: CONFIG.mostros }]));
  };
  ws.onmessage = onMessage;

  function onMessage(msg) {
    let d;
    try { d = JSON.parse(msg.data); } catch { return; }
    if (d[0] === 'EVENT') {
      if (d[1].startsWith('hist')) { count++; oldest = Math.min(oldest, d[2]?.created_at ?? Infinity); }
      if (handleEvent(d[2])) {
        if (isLive) { if (d[2].tags.some(t => t[0] === 's' && t[1] === 'success')) markFresh(d[2]); scheduleRender(); }
        else changed = true;
      }
    } else if (d[0] === 'EOSE' && d[1] === 'meta') {
      ws.send(JSON.stringify(['CLOSE', 'meta']));
      if (isLive && changed) scheduleRender();
    } else if (d[0] === 'EOSE' && d[1] === 'hist' + page) {
      ws.send(JSON.stringify(['CLOSE', d[1]]));
      if (count > 0 && oldest < prevOldest) {
        prevOldest = oldest;
        page++; count = 0;
        req('hist' + page, { limit: PAGE, until: oldest - 1 });
        return;
      }
      // Since we started asking for history, so nothing is lost if paging was slow
      ws.send(JSON.stringify(['REQ', 'live', { ...base, since: startedAt - 60 }, { kinds: META_KINDS, authors: CONFIG.mostros, since: startedAt }]));
      isLive = true;
      state.live++;
      setStatus();
      if (changed) scheduleRender();
    }
  }

  ws.onclose = () => {
    if (isLive) state.live--;
    setStatus();
    const next = opened ? 0 : attempt + 1;
    setTimeout(() => connect(url, next), Math.min(60000, 5000 * 2 ** next));
  };
  ws.onerror = () => ws.close();
}

function markFresh(ev) {
  const d = ev.tags.find(t => t[0] === 'd')?.[1];
  const o = state.orders.get(ev.pubkey + ':' + d);
  if (o) o.fresh = true;
}

function setStatus(error) {
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

// ---------- External prices ----------
async function loadYadio() {
  try {
    state.yadio = await (await fetch('https://api.yadio.io/exrates/USD')).json();
  } catch (e) { console.warn('Yadio', e); }
}

// Coinbase hourly candles (at most 300 per request) to convert each trade to USD.
// If a request fails, that stretch is not marked as loaded: it is retried on the next render,
// at most once a minute so as not to insist against a blocked service
async function loadBtcHistory(fromTs) {
  if (fromTs >= state.btcLoadedFrom || Date.now() < state.btcRetryAt) return;
  const until = Math.min(state.btcLoadedFrom, Math.floor(Date.now() / 1000));
  const step = 300 * 3600;
  // From newest to oldest: what is loaded always stays contiguous up to `until`
  for (let end = until; end > fromTs - 3600; end -= step) {
    const start = Math.max(end - step, fromTs - 3600);
    const url = 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600' +
      `&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      for (const [time, , , , close] of await res.json()) state.btcusd.set(time, close);
      state.btcLoadedFrom = Math.max(start + 3600, fromTs);
    } catch (e) {
      console.warn('Coinbase', e);
      state.btcRetryAt = Date.now() + 60 * 1000;
      return;
    }
  }
  state.btcLoadedFrom = fromTs;
}

const btcSpot = () => state.yadio?.BTC ?? null;
// BTC/USD of a moment: the Coinbase hourly close; without it, the current price (approximate)
function btcAt(ts) {
  const p = hourlyClose(state.btcusd, ts);
  if (p != null) return p;
  if (ts < Date.now() / 1000 - 3 * 3600) state.btcApprox = true;
  return btcSpot();
}
const yadioFiatPerUsd = () => state.yadio?.USD?.[state.fiat] ?? (state.fiat === 'USD' ? 1 : null);

// Name of the chosen unit: CUP/USD, CUP/BTC or CUP/sat
const unitName = () => `${state.fiat}/${UNITS[state.unit]}`;

// Converts currency per BTC to the chosen unit; in USD with the BTC/USD of `ts` (or the current one)
const unitPrice = (fiatPerBtc, ts) => state.unit === 'usd'
  ? toUnit(fiatPerBtc, 'usd', ts ? btcAt(ts) : btcSpot())
  : toUnit(fiatPerBtc, state.unit);

// ---------- Derived data ----------
const filters = () => ({ fiat: state.fiat, nodes: state.nodeSel, pmSel: state.pmSel });

function getTrades() {
  state.btcApprox = false;
  return tradesOf([...state.orders.values()], filters(), unitPrice);
}

function getBook() {
  const ref = yadioFiatPerUsd(), btc = btcSpot();
  return bookOf([...state.orders.values()], filters(), {
    now: Date.now() / 1000, market: ref && btc ? ref * btc : null, toPrice: p => unitPrice(p),
  });
}

// ---------- Formatting ----------
const fmtPrice = p => p == null ? '—' : p === 0 ? '0' : p >= 1e6 ? (p / 1e6).toFixed(2) + 'M'
  : p >= 100 ? p.toLocaleString(LOCALE, { maximumFractionDigits: 2 })
  : p.toLocaleString(LOCALE, { minimumFractionDigits: p >= 10 ? 2 : 4, maximumFractionDigits: p >= 10 ? 2 : 4 });

// ---------- Charts ----------
const css = getComputedStyle(document.documentElement);
const C = n => css.getPropertyValue(n).trim();

function makeChart(el) {
  const chart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: {
      background: { color: C('--bg') }, textColor: C('--muted'), fontSize: 11,
      // Panes resizable by dragging the separator, as in TradingView
      panes: { enableResize: true, separatorColor: C('--line'), separatorHoverColor: C('--avg-soft') },
    },
    grid: { vertLines: { color: C('--grid') }, horzLines: { color: C('--grid') } },
    rightPriceScale: { borderColor: C('--line'), minimumWidth: 80 },
    timeScale: { borderColor: C('--line'), timeVisible: true, secondsVisible: false },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    localization: { locale: LOCALE, priceFormatter: fmtPrice },
  });
  return { chart, el };
}

const { LineSeries, CandlestickSeries, HistogramSeries } = LightweightCharts;

const chartC = makeChart(document.getElementById('chart'));
chartC.line = chartC.chart.addSeries(LineSeries, { color: C('--accent'), lineWidth: 1, pointMarkersVisible: true });
chartC.candles = chartC.chart.addSeries(CandlestickSeries, {
  upColor: C('--up'), downColor: C('--down'), borderVisible: false,
  wickUpColor: C('--up'), wickDownColor: C('--down'), visible: false,
});
// Weighted: volume-weighted price of the 24 h before each point (the Tasa K at that moment)
chartC.avg = chartC.chart.addSeries(LineSeries, { color: C('--avg'), lineWidth: 2, visible: false });
chartC.line.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.08 } });
// Fine precision so that CUP/sat (≈ 0.9) is not rounded to 2 decimals
for (const s of [chartC.line, chartC.candles, chartC.avg]) {
  s.applyOptions({ priceFormat: { type: 'custom', formatter: fmtPrice, minMove: 0.0001 } });
}
// Volume in its own pane, below the price and with its own axis
chartC.vol = chartC.chart.addSeries(HistogramSeries, {
  priceFormat: { type: 'custom', formatter: fmtInt }, priceLineVisible: false,
}, 1);
chartC.vol.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0 } });

// Size of the volume pane (fraction of the height) and whether it is shown. Remembered in this
// browser; if storage fails, the defaults are used.
const volPref = (() => {
  try { return JSON.parse(localStorage.getItem('tasak.vol')) || {}; } catch { return {}; }
})();
let volFrac = Math.min(0.7, Math.max(0.1, Number(volPref.frac) || 0.25));
let volOn = volPref.on !== false;
const saveVolPref = () => { try { localStorage.setItem('tasak.vol', JSON.stringify({ frac: volFrac, on: volOn })); } catch {} };

const EYE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7c2.2 0 4.1.7 5.7 1.7M23 12s-4 7-11 7c-2.2 0-4.1-.7-5.7-1.7"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/></svg>';
const volTag = document.getElementById('volTag');
const volEye = document.getElementById('volEye');

// When hidden, the volume moves invisibly to the price pane and its own pane disappears
function applyVolLayout() {
  chartC.vol.applyOptions({ visible: volOn });
  chartC.vol.moveToPane(volOn ? 1 : 0);
  const panes = chartC.chart.panes();
  if (volOn && panes[1]) {
    panes[0].setStretchFactor(1 - volFrac);
    panes[1].setStretchFactor(volFrac);
  }
  volEye.innerHTML = volOn ? EYE : EYE_OFF;
  volEye.title = volEye.ariaLabel = t(volOn ? 'Ocultar volumen' : 'Mostrar volumen');
  requestAnimationFrame(positionVolTag);
}

// The tag goes in the corner of the volume pane, or at the bottom of the price pane if hidden
function positionVolTag() {
  const panes = chartC.chart.panes();
  const h0 = panes[0].getHeight();
  volTag.style.top = (volOn && panes[1] ? h0 + 8 : h0 - 30) + 'px';
}

// After dragging the native separator, save the new size
chartC.el.addEventListener('pointerup', e => requestAnimationFrame(() => {
  const panes = chartC.chart.panes();
  if (!volOn || !panes[1] || volTag.contains(e.target)) return;
  const h0 = panes[0].getHeight(), h1 = panes[1].getHeight();
  if (!h0 || !h1) return;
  const frac = h1 / (h0 + h1);
  if (Math.abs(frac - volFrac) > 0.005) { volFrac = frac; saveVolPref(); }
  positionVolTag();
}));
chartC.el.addEventListener('pointermove', e => { if (e.buttons) positionVolTag(); });
new ResizeObserver(() => requestAnimationFrame(positionVolTag)).observe(chartC.el);

volEye.onclick = () => { volOn = !volOn; applyVolLayout(); saveVolPref(); };

// On a theme change the chart takes the new colours (it doesn't use CSS: they must be given)
document.addEventListener('themechange', () => {
  chartC.chart.applyOptions({
    layout: {
      background: { color: C('--bg') }, textColor: C('--muted'),
      panes: { separatorColor: C('--line'), separatorHoverColor: C('--avg-soft') },
    },
    grid: { vertLines: { color: C('--grid') }, horzLines: { color: C('--grid') } },
    rightPriceScale: { borderColor: C('--line') },
    timeScale: { borderColor: C('--line') },
  });
  chartC.line.applyOptions({ color: C('--accent') });
  chartC.candles.applyOptions({ upColor: C('--up'), downColor: C('--down'), wickUpColor: C('--up'), wickDownColor: C('--down') });
  chartC.avg.applyOptions({ color: C('--avg') });
  scheduleRender();   // the volume is coloured when drawing
});
applyVolLayout();

function setEmpty(c, show, text) {
  const e = c.el.querySelector('.empty');
  e.style.display = show ? 'flex' : 'none';
  if (text) e.textContent = text;
}

// What the chart shows, for the legend: time -> data of the point
let view = { info: new Map(), last: null, tf: 0 };

// Date of a chart time (already in local time, hence formatted as UTC)
function fmtWhen(time, tf) {
  const d = new Date(time * 1000);
  const opts = { timeZone: 'UTC', day: '2-digit', month: '2-digit' };
  if (tf === YEAR) return String(d.getUTCFullYear());
  if (tf === MONTH) return d.toLocaleDateString(LOCALE, { timeZone: 'UTC', month: 'long', year: 'numeric' });
  if (tf === WEEK) return t('semana del {d}', { d: d.toLocaleDateString(LOCALE, opts) });
  if (tf === 86400) return d.toLocaleDateString(LOCALE, { ...opts, weekday: 'short' });
  return d.toLocaleString(LOCALE, { ...opts, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}
// Percentage in the language's format: +6,00 % (es), +6.00% (en)
const fmtPct = (c, digits = 2) =>
  `${c >= 0 ? '+' : '−'}${Math.abs(c).toLocaleString(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits })}${LANG === 'en' ? '' : ' '}%`;
const fmtChg = c => c == null ? '' : `<span class="${c >= 0 ? 'up' : 'down'}">${fmtPct(c)}</span>`;
const kv = (k, v, cls = '') => `<span><span class="k">${k}</span><span class="${cls}">${v}</span></span>`;

// Nostr event of an order, in the legend
const evRow = o => o.ev ? `<div class="row">${kv(t('Evento'), esc(o.ev.id.slice(0, 8) + '…' + o.ev.id.slice(-8)))}<span class="muted">${t('clic para ver el evento firmado')}</span></div>` : '';

function renderLegend(time) {
  const el = document.getElementById('legend');
  const tm = time ?? view.last;
  const p = view.info.get(tm);
  if (tm == null) { el.innerHTML = ''; return; }
  const when = `<span class="when">${fmtWhen(tm, view.tf)}</span>`;
  if (!p) { el.innerHTML = `<div class="row">${when}<span class="muted">${t('sin órdenes')}</span></div>`; return; }
  const cls = p.up ? 'up' : 'down';
  const n = nOrders(p.n);
  if (state.mode === 'avg') {
    el.innerHTML = p.avg == null
      ? `<div class="row">${when}<span class="muted">${t('sin órdenes en las 24h anteriores')}</span></div>`
      : `<div class="row">${when}${kv(t('Ponderado'), fmtPrice(p.avg), cls)}${fmtChg(p.chg)}</div>
      <div class="row"><span class="muted">${t(p.avgN === 1 ? '{n} orden · {vol} en las 24h anteriores' : '{n} órdenes · {vol} en las 24h anteriores', { n: p.avgN, vol: `${fmtInt(p.avgVol)} ${state.fiat}` })}</span></div>
      ${p.order ? evRow(p.order) : ''}`;
  } else if (p.order) {
    const o = p.order;
    el.innerHTML = `
      <div class="row">${when}${kv(t('Precio'), fmtPrice(o.price), cls)}${fmtChg(p.chg)}<span class="muted">${t(o.side === 'buy' ? 'compra de BTC' : 'venta de BTC')}</span></div>
      <div class="row">${kv('Vol', fmtInt(o.size) + ' ' + state.fiat)}${kv('Sats', fmtInt(o.amt))}<span class="muted">${esc(o.pm.join(', '))}</span></div>
      ${evRow(o)}`;
  } else if (state.mode === 'candles') {
    el.innerHTML = `
      <div class="row">${when}${kv(t('A'), fmtPrice(p.open), cls)}${kv(t('Máx'), fmtPrice(p.high), cls)}${kv(t('Mín'), fmtPrice(p.low), cls)}${kv(t('C'), fmtPrice(p.close), cls)}${fmtChg(p.chg)}</div>
      <div class="row">${kv('Vol', fmtInt(p.vol) + ' ' + state.fiat)}<span class="muted">${n}</span></div>`;
  } else {
    el.innerHTML = `
      <div class="row">${when}${kv(t('Precio'), fmtPrice(p.value), cls)}${fmtChg(p.chg)}</div>
      <div class="row">${kv('Vol', fmtInt(p.vol) + ' ' + state.fiat)}<span class="muted">${n}</span></div>`;
  }
}

const TF_SHORT = { 0: 'Orden', 3600: '1h', 14400: '4h', 86400: '1D', 604800: '1W', 2592000: '1M', 31536000: '1Y' };

function renderChart(trades) {
  setEmpty(chartC, !trades.length, state.live ? t('No hay órdenes completadas con estos filtros') : null);
  const mode = state.mode;
  if (mode === 'candles' && !state.tf) state.tf = 86400;   // candles need a period
  chartC.line.applyOptions({ visible: mode === 'line' });
  chartC.candles.applyOptions({ visible: mode === 'candles' });
  chartC.avg.applyOptions({ visible: mode === 'avg' });
  document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  document.querySelectorAll('[data-tf]').forEach(b => {
    b.classList.toggle('on', Number(b.dataset.tf) === state.tf);
    b.hidden = mode === 'candles' && b.dataset.tf === '0';
  });
  document.getElementById('tfOrders').hidden = mode === 'candles';
  document.getElementById('tfSummary').textContent = `${t(TF_SHORT[state.tf])} ▾`;

  // Points: one per period or one per order, each with the weighted price of its previous 24 h.
  // In Weighted mode the periods without orders count too: their previous 24 h may have an average
  const points = chartPoints(trades, { tf: state.tf, tz: CONFIG.tz, now: Date.now() / 1000, withEmpty: mode === 'avg' });

  // Change from the previous point: colours the volume and the legend
  const valueOf = p => mode === 'candles' ? p.close : mode === 'avg' ? p.avg : p.value;
  let prevVal = null;
  for (const p of points) {
    const v = valueOf(p);
    p.chg = v != null && prevVal != null ? (v / prevVal - 1) * 100 : null;
    // Colour: in candles, the candle's own; in the other modes, whether it rose from the previous point
    p.up = mode === 'candles' ? p.close >= p.open : p.chg == null || p.chg >= 0;
    if (v != null) prevVal = v;
  }

  chartC.line.setData(mode === 'line' ? points.map(p => ({ time: p.time, value: p.value })) : []);
  chartC.candles.setData(mode === 'candles' ? points.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })) : []);
  // Without an average in the previous 24 h the line is broken
  chartC.avg.setData(mode === 'avg' ? points.map(p => p.avg == null ? { time: p.time } : { time: p.time, value: p.avg }) : []);
  chartC.vol.setData(points.map(p => p.empty ? { time: p.time } :
    { time: p.time, value: p.vol, color: C(p.up ? '--up-vol' : '--down-vol') }));

  view = { info: new Map(points.map(p => [p.time, p])), last: points.at(-1)?.time ?? null, tf: state.tf };
  renderLegend();
  // Fit to all the data unless the visitor has moved or zoomed the chart in this view: otherwise
  // every render (a new order, the refresh every minute) would lose their zoom
  const fitKey = [state.fiat, state.unit, mode, state.tf, [...state.nodeSel], [...(state.pmSel || [])].sort()].join('|');
  if (fitKey !== chartFit.key) chartFit = { key: fitKey, moved: false };
  if (!chartFit.moved) chartC.chart.timeScale().fitContent();
  positionVolTag();
}

// The legend shows the point under the cursor; on leaving, back to the last one
chartC.chart.subscribeCrosshairMove(p => renderLegend(p.time));
chartC.chart.subscribeClick(p => { const o = view.info.get(p.time)?.order; if (o) openEvent(o); });
chartC.el.addEventListener('mouseleave', () => renderLegend());
// Zoom or scroll done by the visitor (wheel, drag, pinch)
let chartFit = { key: null, moved: false };
const userMoved = () => { chartFit.moved = true; };
chartC.el.addEventListener('wheel', userMoved, { passive: true });
// Dragging the pane separator (row-resize cursor) or the «Vol.» tag is not moving the chart
let draggingOther = false;
// (in the capture phase: the chart library stops the propagation of its events)
chartC.el.addEventListener('pointerdown', e => {
  draggingOther = getComputedStyle(e.target).cursor === 'row-resize' || volTag.contains(e.target);
}, true);
chartC.el.addEventListener('pointermove', e => { if (e.buttons && !draggingOther) userMoved(); }, true);
chartC.el.addEventListener('touchmove', userMoved, { passive: true });
// Double click: back to seeing all the data
chartC.el.addEventListener('dblclick', () => { chartFit.moved = false; chartC.chart.timeScale().fitContent(); });

// ---------- Panels ----------
function renderStats(trades) {
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
  return tasa;
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

function renderTrades(trades) {
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
    </tr>`).join('') || `<tr><td colspan="5" class="muted" style="text-align:center;padding:10px">${
      state.tf ? t('Sin órdenes completadas en {range}', { range: rangeName(state.tf) }) : t('Sin órdenes completadas')}</td></tr>`;
  for (const o of state.orders.values()) o.fresh = false;
}

function renderBook(tasa) {
  const { asks, bids } = getBook();
  const max = Math.max(1, ...asks.map(o => o.size), ...bids.map(o => o.size));
  const row = (o, cls) => `
    <tr class="${cls}" style="--d:${(o.size / max * 100).toFixed(1)}%" data-key="${esc(o.key)}" title="${t('Ver el evento Nostr de esta orden abierta')}">
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
      : `Spread <strong class="num">${fmtPrice(spread)}</strong> <span class="muted num">(${(spread / asks[0].price * 100).toFixed(1)}%)</span>`;
  }
  if (tasa != null) mid += `${mid ? ' · ' : ''}${esc(CONFIG.rateName)} <strong class="num">${fmtPrice(tasa)}</strong>`;

  document.getElementById('book').innerHTML =
    (asks.length ? asks.slice().reverse().map(o => row(o, 'ask')).join('') : none(t('Nadie vendiendo BTC ahora'))) +
    `<tr class="mid"><td colspan="4">${mid || '&nbsp;'}</td></tr>` +
    (bids.length ? bids.map(o => row(o, 'bid')).join('') : none(t('Nadie comprando BTC ahora')));
}

function renderFilters() {
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

function updatePair() {
  const nodes = CONFIG.mostros.length === 1 ? nodeName(CONFIG.mostros[0]) : t('{n} nodos Mostro', { n: CONFIG.mostros.length });
  const pic = CONFIG.mostros.length === 1 && state.nodeMeta.get(CONFIG.mostros[0])?.profile?.picture;
  const btn = document.getElementById('nodeBtn');
  const img = btn.querySelector('img');
  if (pic && /^https:\/\//.test(pic)) {
    if (!img) btn.insertAdjacentHTML('afterbegin', `<img alt="" src="${esc(pic)}" onerror="this.remove()">`);
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

// ---------- Render ----------
// Renders are queued so they don't overlap while the Coinbase candles load
let renderQueued = false, rendering = Promise.resolve();
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  rendering = rendering
    .then(() => new Promise(r => requestAnimationFrame(r)))
    .then(async () => {
      renderQueued = false;
      renderFilters();
      updatePair();
      if (state.unit === 'usd') {
        const ts = [...state.orders.values()].filter(o => o.status === 'success').map(o => o.ts);
        if (ts.length) await loadBtcHistory(Math.min(...ts));
      }
      const trades = getTrades();
      renderChart(trades);
      const tasa = renderStats(trades);
      renderTrades(trades);
      renderBook(tasa);
      setStatus();
    })
    .catch(e => console.error(e));
}

document.getElementById('pms').onclick = e => {
  const b = e.target.closest('[data-pm]');
  if (!b) return;
  const k = b.dataset.pm;
  state.pmSel.has(k) ? state.pmSel.delete(k) : state.pmSel.add(k);
  scheduleRender();
};
document.getElementById('nodes').onclick = e => {
  const b = e.target.closest('[data-node]');
  if (!b) return;
  const k = b.dataset.node;
  // At least one node always stays selected
  if (state.nodeSel.has(k)) { if (state.nodeSel.size > 1) state.nodeSel.delete(k); }
  else state.nodeSel.add(k);
  scheduleRender();
};
document.getElementById('fiat').onchange = e => {
  state.fiat = e.target.value;
  state.fiatAuto = false;
  state.pmSel = null;
  state.pmKnown = null;
  scheduleRender();
};
document.querySelectorAll('[data-unit]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-unit]').forEach(x => x.classList.toggle('on', x === b));
  state.unit = b.dataset.unit;
  scheduleRender();
});
document.querySelectorAll('[data-tf]').forEach(b => b.onclick = () => {
  state.tf = Number(b.dataset.tf);
  document.getElementById('tfMenu').open = false;
  saveView();
  scheduleRender();
});
document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => {
  state.mode = b.dataset.mode;
  if (state.mode === 'candles' && !state.tf) state.tf = 86400;
  saveView();
  scheduleRender();
});

// Nostr event of an order
const evDlg = document.getElementById('evDlg');
const FINAL_STATUS = ['success', 'canceled', 'expired'];
function openEvent(o) {
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
// Click on an executed order or one in the order book: its Nostr event
for (const id of ['trades', 'book']) document.getElementById(id).onclick = e => {
  const tr = e.target.closest('tr[data-key]');
  const o = tr && state.orders.get(tr.dataset.key);
  if (o) openEvent(o);
};

// Splitter between the order book and the executed orders: fraction of the height of the order
// book, remembered in this browser
const rightCol = document.querySelector('.col.right');
const rightSplit = document.getElementById('rightSplit');
let bookFrac = (() => {
  try { return Number(localStorage.getItem('tasak.book')) || 0.5; } catch { return 0.5; }
})();
function applyBookFrac() {
  bookFrac = Math.min(0.85, Math.max(0.15, bookFrac));
  rightCol.style.setProperty('--book', bookFrac + 'fr');
  rightCol.style.setProperty('--trades', 1 - bookFrac + 'fr');
}
const saveBookFrac = () => { try { localStorage.setItem('tasak.book', bookFrac); } catch {} };
rightSplit.onpointerdown = e => {
  e.preventDefault();
  rightSplit.setPointerCapture(e.pointerId);
  rightSplit.classList.add('drag');
  const r = rightCol.getBoundingClientRect();
  rightSplit.onpointermove = ev => { bookFrac = (ev.clientY - r.top) / r.height; applyBookFrac(); };
  rightSplit.onpointerup = rightSplit.onpointercancel = () => {
    rightSplit.onpointermove = rightSplit.onpointerup = rightSplit.onpointercancel = null;
    rightSplit.classList.remove('drag');
    saveBookFrac();
  };
};
// Also with the keyboard (up / down arrows)
rightSplit.onkeydown = e => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  bookFrac += e.key === 'ArrowUp' ? -0.05 : 0.05;
  applyBookFrac();
  saveBookFrac();
};
applyBookFrac();


// The node page keeps the URL parameters (same node and relays)
for (const id of ['nodeBtn', 'nodeBtn2']) document.getElementById(id).href = 'node.html' + location.search;

// Frequently asked questions
const faq = document.getElementById('faq');
for (const el of document.querySelectorAll('.hidden-pms')) el.textContent = CONFIG.hiddenPaymentMethods.map(m => t(m)).join(', ') || '—';
document.getElementById('faqBtn').onclick = () => faq.showModal();
document.getElementById('faqClose').onclick = () => faq.close();
faq.addEventListener('click', e => { if (e.target === faq) faq.close(); });   // click outside the box

// Close the dropdown menus when clicking outside
document.addEventListener('click', e => {
  for (const menu of document.querySelectorAll('details.menu')) {
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  }
});

// Full screen for the chart panel (Esc to leave)
const chartPanel = document.getElementById('chartPanel');
const fsBtn = document.getElementById('fsBtn');
const isFull = () => document.fullscreenElement === chartPanel || chartPanel.classList.contains('max');
function syncFs() {
  fsBtn.title = t(isFull() ? 'Salir de pantalla completa' : 'Pantalla completa');
  fsBtn.setAttribute('aria-label', fsBtn.title);
}
fsBtn.onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (chartPanel.classList.contains('max')) chartPanel.classList.remove('max');
  else if (chartPanel.requestFullscreen) chartPanel.requestFullscreen().catch(() => { chartPanel.classList.add('max'); syncFs(); });
  else chartPanel.classList.add('max');
  syncFs();
};
document.addEventListener('fullscreenchange', syncFs);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && chartPanel.classList.contains('max')) { chartPanel.classList.remove('max'); syncFs(); }
});

// The page's state and functions, for the checks in tools/ (headless Chrome) and for debugging
// from the console: module variables are not global
window.tasak = {
  state, chartC, getTrades, getBook, renderFilters, renderChart, scheduleRender,
  get view() { return view; }, get rendering() { return rendering; }, get renderQueued() { return renderQueued; },
};

updatePair();
if (!CONFIG.mostros.length || !CONFIG.relays.length) {
  const msg = CONFIG.fromEnv
    ? t('Configuración sin nodos o sin relays válidos')
    : t('Falta config.js: ejecuta "node build.mjs" o pasa ?mostro=…&relays=… en la URL');
  setStatus(msg);
  setEmpty(chartC, true, msg);
} else {
  setStatus();
  loadYadio().then(scheduleRender);
  CONFIG.relays.forEach(url => connect(url));
  setInterval(loadYadio, 5 * 60 * 1000);
  setInterval(scheduleRender, 60 * 1000);   // expires book orders and moves the 24 h window
}
