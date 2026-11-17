// «Depth»: the order book now, as in an exchange. The price on the horizontal axis (the header's unit),
// the cumulative amount in currency on the vertical one, buyers on the left and sellers on the right,
// and a vertical line at the Tasa K. Its own chart in its own container (#depth), shown instead of the
// chart over time (#chart), which keeps its mode, zoom and panes underneath. Data: depth-curve.js.
import { depthCurve } from './depth-curve.js';
import { state } from './state.js';
import { fmtPrice, fmtPct } from './format.js';
import { openEvent } from './event-dialog.js';
import { addPairWatermark } from './chart.js';
import { P, p2p } from './platform.js';

const css = getComputedStyle(document.documentElement);
const C = n => css.getPropertyValue(n).trim();
const el = document.getElementById('depth');
const legendEl = document.getElementById('depthLegend');

// The horizontal axis is a price. lightweight-charts' own (createOptionsChart) weighs the ticks by
// multiples of 100, 50, 25… whatever the size of the prices (0.4 sat/CUP, 40 M BTC/CUP): this one, by
// multiples of the power of ten of the grid's step, so that the ticks fall on round prices in every unit
const WEIGHTS = [1000, 500, 100, 50, 10, 5, 2];
const priceAxis = {
  unit: 1,
  options() { return this.opts; },
  setOptions(o) { this.opts = o; },
  preprocessData() {},
  updateFormatter(l) { if (this.opts) this.opts.localization = l; },
  createConverterToInternalObj() { return x => x; },
  key: x => x,
  cacheKey: x => x,
  convertHorzItemToInternal: x => x,
  formatHorzItem: x => fmtPrice(x),
  formatTickmark: m => fmtPrice(m.time),
  maxTickMarkWeight: marks => Math.max(...marks.map(m => m.weight)),
  fillWeightsForPoints(points, start) {
    for (let i = start; i < points.length; i++) {
      const k = Math.round(points[i].time / this.unit);
      const w = WEIGHTS.findIndex(m => k % m === 0);
      points[i].timeWeight = w < 0 ? 0 : WEIGHTS.length - w;
    }
  },
};

// Amounts of the vertical axis: compact from a million (1,74 M), as the header's volume
const fmtCum = n => n >= 1e6 ? new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 2 }).format(n) : fmtInt(n);

const chart = LightweightCharts.createChartEx(el, priceAxis, {
  autoSize: true,
  layout: { background: { color: C('--bg') }, textColor: C('--muted'), fontSize: 11 },
  grid: { vertLines: { color: C('--grid') }, horzLines: { color: C('--grid') } },
  rightPriceScale: { borderColor: C('--line') },
  // Thousands of grid points: down to a fraction of a pixel each when zoomed out
  timeScale: { borderColor: C('--line'), minBarSpacing: 0.001, rightOffset: 0 },
  crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  localization: { locale: LOCALE, priceFormatter: fmtCum },
});
const { AreaSeries, LineType } = LightweightCharts;
// From zero up to what is visible: the outer orders (out of the view) don't flatten the rest
// (a side with nothing in view has no range: the other one gives it)
const fromZero = original => {
  const r = original();
  return r?.priceRange ? { ...r, priceRange: { minValue: 0, maxValue: Math.max(r.priceRange.maxValue, 1) } } : null;
};
const area = () => chart.addSeries(AreaSeries, {
  lineType: LineType.WithSteps, lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
  priceFormat: { type: 'custom', formatter: fmtCum, minMove: 1 }, autoscaleInfoProvider: fromZero,
});
const bids = area(), asks = area();
bids.priceScale().applyOptions({ scaleMargins: { top: 0.15, bottom: 0 } });

// Coordinate of a fractional logical index: the library's gives 0 unless it is a whole one, so it is
// interpolated between the two around it
function xOf(l) {
  const ts = chart.timeScale(), i = Math.floor(l);
  const a = ts.logicalToCoordinate(i), b = ts.logicalToCoordinate(i + 1);
  return a == null || b == null ? null : a + (b - a) * (l - i);
}

// The vertical line at the Tasa K, drawn by a primitive: the rate rarely falls on a grid point, so its
// place is between two logical indexes (the chart's own price lines are horizontal)
const rateLine = {
  x: null,   // logical index of the rate (fractional)
  attached({ requestUpdate }) { this.requestUpdate = requestUpdate; },
  updateAllViews() {},
  paneViews() { return [this.view]; },
  view: {
    zOrder: () => 'top',
    renderer: () => ({
      draw(target) {
        const x = rateLine.x == null ? null : xOf(rateLine.x);
        if (x == null) return;
        target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
          if (x < 0 || x > mediaSize.width) return;
          ctx.save();
          ctx.strokeStyle = C('--avg');
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(Math.round(x) + 0.5, 0);
          ctx.lineTo(Math.round(x) + 0.5, mediaSize.height);
          ctx.stroke();
          ctx.restore();
        });
      },
    }),
  },
};
bids.attachPrimitive(rateLine);
addPairWatermark(chart.panes()[0]);

export function applyDepthTheme() {
  chart.applyOptions({
    layout: { background: { color: C('--bg') }, textColor: C('--muted') },
    grid: { vertLines: { color: C('--grid') }, horzLines: { color: C('--grid') } },
    rightPriceScale: { borderColor: C('--line') },
    timeScale: { borderColor: C('--line') },
  });
  colourSeries();
}
function colourSeries() {
  bids.applyOptions({ lineColor: C('--up'), topColor: C('--up-vol'), bottomColor: C('--up-bg') });
  asks.applyOptions({ lineColor: C('--down'), topColor: C('--down-vol'), bottomColor: C('--down-bg') });
}
colourSeries();

// What is drawn, for the legend, the click and tools/: the curve and its points by price
export let depth = { curve: null, byX: new Map() };
const toLogical = x => (x - depth.curve.points[0].x) / depth.curve.step;
const fromLogical = l => depth.curve.points[0].x + l * depth.curve.step;

// The view opens at depth.curve.view (±20 % around the rate); once the visitor moves or zooms it, it
// stays (in prices: the grid changes with the book) until the filters change. Double click: back
let fit = { key: null, moved: false };
const fitView = () => {
  const v = depth.curve?.view;
  if (v) chart.timeScale().setVisibleLogicalRange({ from: toLogical(v.from), to: toLogical(v.to) });
};

export function renderDepth(tasa, book) {
  const curve = depthCurve(book, { center: tasa });
  // The visitor's view in prices, before the grid changes
  const old = depth.curve?.points.length ? chart.timeScale().getVisibleLogicalRange() : null;
  const oldPrices = old && { from: fromLogical(old.from), to: fromLogical(old.to) };
  depth = { curve, byX: new Map(curve.points.map(p => [p.x, p])) };
  priceAxis.unit = curve.step ? 10 ** Math.floor(Math.log10(curve.step) + 1e-9) : 1;

  const total = book.asks.length + book.bids.length;
  el.querySelector('.empty').style.display = curve.points.length ? 'none' : 'flex';
  el.querySelector('.empty').textContent = curve.points.length ? ''
    : !total ? t(state.loading || !state.live ? 'Cargando…' : 'Sin órdenes abiertas con estos filtros')
    : t('Ninguna orden abierta con precio en la gráfica') + ` (${notes(curve).join(' · ')})`;

  // Every grid point in both series (whitespace where a side has nothing): the horizontal axis is
  // the union of their points, and a gap would squeeze the spread out of the axis
  bids.setData(curve.points.map(p => p.bid ? { time: p.x, value: p.bid.cum } : { time: p.x }));
  asks.setData(curve.points.map(p => p.ask ? { time: p.x, value: p.ask.cum } : { time: p.x }));
  rateLine.x = curve.rate != null && curve.points.length ? toLogical(curve.rate) : null;
  rateLine.requestUpdate?.();

  const key = [state.fiat, state.unit, state.asset, [...state.nodeSel], [...(state.pmSel || [])].sort()].join('|');
  if (key !== fit.key) fit = { key, moved: false };
  if (curve.points.length) {
    if (!fit.moved) fitView();
    else if (oldPrices) chart.timeScale().setVisibleLogicalRange({ from: toLogical(oldPrices.from), to: toLogical(oldPrices.to) });
  }
  renderLegend();
}

// What is left out of the chart, and that the ranges count by their maximum
function notes(curve) {
  const out = [];
  if (curve.noPrice) out.push(t('{n} sin precio', { n: curve.noPrice }));
  if (curve.outside) out.push(t('{n} fuera de escala', { n: curve.outside }));
  if (curve.ranges) out.push(t('órdenes con rango: por su máximo'));
  return out;
}

const kv = (k, v, cls = '') => `<span><span class="k">${k}</span><span class="${cls}">${v}</span></span>`;
const side = (name, s, cls) => s ? `<div class="row">${kv(name, `${fmtInt(s.cum)} ${esc(state.fiat)}`, cls)}<span class="muted">${nOrders(s.n)}</span></div>` : '';

// Under the cursor: the price, how far from the rate, and each side's amount up to it. Otherwise, the
// rate and the whole book, with what is left out
function renderLegend(x) {
  const curve = depth.curve;
  const p = x == null ? null : depth.byX.get(x);
  if (!curve?.points.length) { legendEl.innerHTML = ''; return; }
  if (p) {
    const vsRate = curve.rate == null ? '' : `<span class="muted">${t('{p} frente a la {rate}', { p: fmtPct((p.x / curve.rate - 1) * 100, 1), rate: esc(CONFIG.rateName) })}</span>`;
    legendEl.innerHTML = `<div class="row">${kv(t('Precio'), fmtPrice(p.x))}${vsRate}</div>`
      + side(t('Compradores'), p.bid, 'up') + side(t('Vendedores'), p.ask, 'down');
  } else {
    const n = notes(curve);
    legendEl.innerHTML = (curve.rate == null ? '' : `<div class="row">${kv(esc(CONFIG.rateName), fmtPrice(curve.rate), 'rate')}</div>`)
      + side(t('Compradores'), curve.totals.bid, 'up') + side(t('Vendedores'), curve.totals.ask, 'down')
      + (n.length ? `<div class="row muted">${n.join(' · ')}</div>` : '');
  }
  placeLegend();
}

// The legend goes on the wider side of the rate's line and no wider than that side, so that it never
// covers the line (on a phone it wraps into more rows)
function placeLegend() {
  const width = chart.timeScale().width();
  const x = rateLine.x == null ? null : xOf(rateLine.x);
  const pad = 10;
  let left = pad, max = width - 2 * pad;
  if (x != null && x > 0 && x < width) {
    if (x - 2 * pad >= width - x - 2 * pad) max = x - 2 * pad;
    else { left = x + pad; max = width - x - 2 * pad; }
  }
  legendEl.style.setProperty('left', Math.round(left) + 'px');
  legendEl.style.setProperty('max-width', Math.max(0, Math.round(max)) + 'px');
}
chart.timeScale().subscribeVisibleLogicalRangeChange(() => requestAnimationFrame(placeLegend));
new ResizeObserver(() => requestAnimationFrame(placeLegend)).observe(el);

chart.subscribeCrosshairMove(p => renderLegend(p.time));
el.addEventListener('mouseleave', () => renderLegend());

// A click opens the signed event of the order of that step: the outermost one in the amount under the
// cursor (where both sides overlap, the one hovered, or the buyers')
chart.subscribeClick(p => {
  const pt = p.time == null ? null : depth.byX.get(p.time);
  if (!pt) return;
  const s = p.hoveredSeries === asks ? pt.ask ?? pt.bid : pt.bid ?? pt.ask;
  const o = s && (P ? p2p.docs : state.orders).get(s.order.key);
  if (o) openEvent(o);
});

// Zoom or scroll done by the visitor (wheel, drag, pinch); in the capture phase: the chart library
// stops the propagation of its events
const moved = () => { fit.moved = true; };
el.addEventListener('wheel', moved, { passive: true });
el.addEventListener('pointermove', e => { if (e.buttons) moved(); }, true);
el.addEventListener('touchmove', moved, { passive: true });
el.addEventListener('dblclick', () => { fit.moved = false; fitView(); });
