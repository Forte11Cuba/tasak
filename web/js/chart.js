// The chart: price, candles or weighted, with the volume in its own resizable pane, and its legend.
import { WEEK, MONTH, YEAR } from '../shared/time.js';
import { chartPoints } from '../shared/rate.js';
import { state, assetTicker } from './state.js';
import { unitName } from './prices.js';
import { fmtPrice, fmtPct, fmtAmt } from './format.js';
import { openEvent } from './event-dialog.js';

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

export const chartC = makeChart(document.getElementById('chart'));
chartC.line = chartC.chart.addSeries(LineSeries, { color: C('--accent'), lineWidth: 1, pointMarkersVisible: true });
chartC.candles = chartC.chart.addSeries(CandlestickSeries, {
  upColor: C('--up'), downColor: C('--down'), borderVisible: false,
  wickUpColor: C('--up'), wickDownColor: C('--down'), visible: false,
});
// Weighted: volume-weighted price of the 24 h before each point (the Tasa K at that moment)
chartC.avg = chartC.chart.addSeries(LineSeries, { color: C('--avg'), lineWidth: 2, visible: false });
chartC.line.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.08 } });
// When everything visible is at one price (periods without orders), ±1% around it: else the scale has no
// height and repeats that price on every label
const flatPadded = original => {
  const r = original();
  const p = r?.priceRange;
  if (p && p.minValue === p.maxValue) {
    const d = Math.abs(p.minValue) * 0.01 || 1;
    return { ...r, priceRange: { minValue: p.minValue - d, maxValue: p.maxValue + d } };
  }
  return r;
};
for (const s of [chartC.line, chartC.candles, chartC.avg]) s.applyOptions({ autoscaleInfoProvider: flatPadded });
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

// What is drawn over the chart, chosen in «View»: the legend (the data of the point) and the pair behind
// the price, big and translucent (TradingView's watermark). Remembered in this browser
const viewPref = (() => {
  try { return { legend: true, pair: true, ...JSON.parse(localStorage.getItem('tasak.chartView')) }; } catch { return { legend: true, pair: true }; }
})();
const watermark = LightweightCharts.createTextWatermark(chartC.chart.panes()[0], { horzAlign: 'center', vertAlign: 'center', lines: [] });
let pairKey = '';
function renderPair() {
  const name = state.fiat ? unitName() : '';
  const size = chartC.el.clientWidth < 600 ? 40 : 72;
  const key = [name, size, viewPref.pair, C('--watermark')].join('|');
  if (key === pairKey) return;
  pairKey = key;
  watermark.applyOptions({ visible: viewPref.pair, lines: [{ text: name, color: C('--watermark'), fontSize: size, fontStyle: 'bold' }] });
}
function applyView() {
  document.getElementById('legend').hidden = !viewPref.legend;
  document.querySelectorAll('[data-view]').forEach(b => {
    b.classList.toggle('on', !!viewPref[b.dataset.view]);
    b.setAttribute('aria-pressed', String(!!viewPref[b.dataset.view]));
  });
  document.getElementById('viewSummary').textContent = `${t('Vista')} ▾`;
  renderPair();
}
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
  viewPref[b.dataset.view] = !viewPref[b.dataset.view];
  try { localStorage.setItem('tasak.chartView', JSON.stringify(viewPref)); } catch {}
  applyView();
}));
applyView();
new ResizeObserver(() => renderPair()).observe(chartC.el);

// On a theme change the chart takes the new colours (it doesn't use CSS: they must be given); the
// volume is coloured when drawing, so the caller renders again
export function applyChartTheme() {
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
  renderPair();
}

applyVolLayout();

export function setEmpty(c, show, text) {
  const e = c.el.querySelector('.empty');
  e.style.display = show ? 'flex' : 'none';
  if (text) e.textContent = text;
}

// What the chart shows, for the legend: time -> data of the point
export let view = { info: new Map(), last: null, tf: 0 };

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

const fmtChg = c => c == null ? '' : `<span class="${c >= 0 ? 'up' : 'down'}">${fmtPct(c)}</span>`;
const kv = (k, v, cls = '') => `<span><span class="k">${k}</span><span class="${cls}">${v}</span></span>`;

// An order's payment methods: the first one and «+N», which shows them all (and «−» hides them again) for
// every order, until clicked again
let pmOpen = false;
const pmHtml = pm => pm.length < 2 ? `<span class="muted">${esc(pm.join(''))}</span>`
  : pmOpen ? `<span class="muted">${esc(pm.join(', '))}</span><button class="pm-more" type="button" title="${esc(t('Mostrar solo el primero'))}">−</button>`
  : `<span class="muted">${esc(pm[0])}</span><button class="pm-more" type="button" title="${esc(pm.join(', '))}">+${pm.length - 1}</button>`;
// The legend lets every gesture through to the chart (drag, wheel, pinch); only «+N» takes clicks. With
// the mouse over it, it stays on the point it showed (the crosshair would change it on the way to «+N»),
// and a click there opens that order's signed event
let legendTime, legendHeld = false;
const legendEl = document.getElementById('legend');
legendEl.addEventListener('click', e => {
  if (!e.target.closest('.pm-more')) return;
  pmOpen = !pmOpen;
  renderLegend(legendTime);
});
function holdLegend(on) {
  if (on === legendHeld) return;
  legendHeld = on;
  const order = on && view.info.get(legendTime ?? view.last)?.order;
  chartC.el.classList.toggle('legend-held', !!order);
  chartC.el.title = order ? t('Ver el evento Nostr de esta orden') : '';
}
// In the capture phase, before the chart moves its crosshair; not while dragging, nor with touch (a tap
// is a tap on the chart)
chartC.el.addEventListener('pointermove', e => {
  if (e.pointerType !== 'mouse') return;
  const r = legendEl.getBoundingClientRect();
  holdLegend(!e.buttons && !legendEl.hidden && !!legendEl.innerHTML
    && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom);
}, true);

function renderLegend(time) {
  legendTime = time;
  const el = legendEl;
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
      <div class="row"><span class="muted">${t(p.avgN === 1 ? '{n} orden · {vol} en las 24h anteriores' : '{n} órdenes · {vol} en las 24h anteriores', { n: p.avgN, vol: `${fmtInt(p.avgVol)} ${state.fiat}` })}</span></div>`;
  } else if (p.empty) {
    const flat = state.mode === 'candles' ? p.flatClose : p.flatValue;
    el.innerHTML = `<div class="row">${when}<span class="muted">${t('sin órdenes')}</span>${flat == null ? '' : kv(t('Precio'), fmtPrice(flat))}</div>`;
  } else if (p.order) {
    const o = p.order;
    el.innerHTML = `
      <div class="row">${when}${kv(t('Precio'), fmtPrice(o.price), cls)}${fmtChg(p.chg)}<span class="muted">${CONFIG.platform
        ? t(o.side === 'buy' ? 'compra de {a}' : 'venta de {a}', { a: esc(assetTicker()) }) : t(o.side === 'buy' ? 'compra de BTC' : 'venta de BTC')}</span></div>
      <div class="row">${kv('Vol', fmtInt(o.size) + ' ' + state.fiat)}${CONFIG.platform ? kv(esc(assetTicker()), fmtAmt(o.amt)) : kv('Sats', fmtInt(o.amt))}${pmHtml(o.pm)}</div>`;
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

export function renderChart(trades) {
  setEmpty(chartC, !trades.length, t(state.loading ? 'Cargando órdenes de los relays…' : 'No hay órdenes completadas con estos filtros'));
  const mode = state.mode;
  if (mode === 'candles' && !state.tf) state.tf = 86400;   // candles need a period
  // A marker per point only in «Each order» (each one is an order): by period, the flat stretches without
  // orders would look like trades; the volume says which periods had them
  chartC.line.applyOptions({ visible: mode === 'line', pointMarkersVisible: !state.tf });
  chartC.candles.applyOptions({ visible: mode === 'candles' });
  chartC.avg.applyOptions({ visible: mode === 'avg' });
  document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  document.querySelectorAll('[data-tf]').forEach(b => {
    b.classList.toggle('on', Number(b.dataset.tf) === state.tf);
    b.hidden = mode === 'candles' && b.dataset.tf === '0';
  });
  document.getElementById('tfOrders').hidden = mode === 'candles';
  document.getElementById('tfSummary').textContent = `${t(TF_SHORT[state.tf])} ▾`;
  renderPair();

  // Points: one per period or one per order, each with the weighted price of its previous 24 h. The
  // periods follow the calendar up to now, also those without orders (their previous 24 h may still
  // have an average); «Each order» has a point per order, whenever it was
  const points = chartPoints(trades, { tf: state.tf, tz: CONFIG.tz, now: Date.now() / 1000, withEmpty: true });
  // A period without orders is drawn flat at the previous one's price (a candle with open = close, green
  // as an unchanged one) and without volume: the volume says there was no trade
  let lastValue = null, lastClose = null;
  for (const p of points) {
    if (p.empty) Object.assign(p, { flatValue: lastValue, flatClose: lastClose });
    else { lastValue = p.value; lastClose = p.close; }
  }

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

  chartC.line.setData(mode === 'line' ? points.map(p => !p.empty ? { time: p.time, value: p.value }
    : p.flatValue == null ? { time: p.time } : { time: p.time, value: p.flatValue }) : []);
  chartC.candles.setData(mode === 'candles' ? points.map(({ time, open, high, low, close, empty, flatClose: c }) => !empty
    ? { time, open, high, low, close } : c == null ? { time } : { time, open: c, high: c, low: c, close: c }) : []);
  // Without an average in the previous 24 h the line is broken
  chartC.avg.setData(mode === 'avg' ? points.map(p => p.avg == null ? { time: p.time } : { time: p.time, value: p.avg }) : []);
  chartC.vol.setData(points.map(p => p.empty ? { time: p.time } :
    { time: p.time, value: p.vol, color: C(p.up ? '--up-vol' : '--down-vol') }));

  view = { info: new Map(points.map(p => [p.time, p])), last: points.at(-1)?.time ?? null, tf: state.tf };
  // A held legend keeps its point while it is still on the chart (a click opens what it shows); if it is
  // gone (another view, timeframe or filter), it is released
  const held = legendHeld && legendTime != null && view.info.has(legendTime) ? legendTime : undefined;
  if (legendHeld && legendTime != null && held === undefined) holdLegend(false);
  renderLegend(held);
  // Fit to all the data unless the visitor has moved or zoomed the chart in this view: otherwise
  // every render (a new order, the refresh every minute) would lose their zoom
  const fitKey = [state.fiat, state.unit, state.asset, mode, state.tf, [...state.nodeSel], [...(state.pmSel || [])].sort()].join('|');
  if (fitKey !== chartFit.key) chartFit = { key: fitKey, moved: false };
  if (!chartFit.moved) fitView();
  positionVolTag();
}

// The default view: everything, or the newest points that fit at BAR_PX pixels each (by hour the calendar
// gives thousands of periods, and fitted all together the candles would have no body). The same width on
// every screen: more periods on a computer, fewer on a phone
const BAR_PX = 12;
function fitView() {
  const n = view.info.size;
  const fit = Math.max(10, Math.floor(chartC.chart.timeScale().width() / BAR_PX));
  if (n > fit) chartC.chart.timeScale().setVisibleLogicalRange({ from: n - fit, to: n + 1 });
  else chartC.chart.timeScale().fitContent();
}

// The legend shows the point under the cursor; on leaving, back to the last one
chartC.chart.subscribeCrosshairMove(p => { if (!legendHeld) renderLegend(p.time); });
chartC.chart.subscribeClick(p => {
  const o = view.info.get(legendHeld ? legendTime ?? view.last : p.time)?.order;
  if (o) openEvent(o);
});
chartC.el.addEventListener('mouseleave', () => { holdLegend(false); renderLegend(); });
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
// Double click: back to the default view
chartC.el.addEventListener('dblclick', () => { chartFit.moved = false; fitView(); });
