// Data of the depth chart: the order book as cumulative amounts in currency on a price grid. Pure (no
// DOM nor globals), so that web/test/ checks it with node --test. Only the browser draws it: the server
// doesn't compute it, which is why it is here and not in shared/.
//
// lightweight-charts spaces its points evenly, whatever their horizontal values: the book is sampled on
// a grid of equal steps, so that the price axis is linear. An order at price p counts for the buyers at
// every point ≤ p and for the sellers at every point ≥ p; the error is at most one step.

// The grid covers from center ÷ SPAN to center × SPAN: orders outside are left out of the chart and
// counted (a seller at a million would otherwise make the step huge)
export const SPAN = 2;
// Step of the grid: about 0.1 % of the center, rounded up to 1, 2 or 5 × 10ⁿ (round prices on the axis)
export const STEP = 0.001;
// The chart opens at ±20 % around the center, widened to show the best buyer and the best seller
export const WINDOW = 0.2;
// Margin beyond the outermost orders (fraction of the center), so that their step is seen
const MARGIN = 0.05;

// The smallest 1, 2 or 5 × 10ⁿ ≥ x, as m × 10^e: the grid values are then exact multiples
export function niceStep(x) {
  const e = Math.floor(Math.log10(x));
  for (const m of [1, 2, 5]) if (m * 10 ** e >= x * (1 - 1e-12)) return { m, e };
  return { m: 1, e: e + 1 };
}
// The k-th value of the grid (k × m × 10^e), dividing for negative exponents: 0.1 × 3 isn't 0.3
const gridValue = ({ m, e }, k) => e >= 0 ? k * m * 10 ** e : k * m / 10 ** -e;

// book: { asks, bids } as getBook / p2pBook give them ({ price, size, fa, … }; price null = without price).
// center: the Tasa K in the same unit, or null (then the middle of the best prices, or the best one).
// Returns { center, rate, step, points: [{ x, bid, ask }], view: { from, to }, totals, noPrice, outside,
// ranges }; bid / ask: { cum, n, order } (cumulative amount, orders in it and the outermost of them) or
// null where that side has nothing. Without priced orders in scale, no points
export function depthCurve({ asks, bids }, { center = null } = {}) {
  const priced = o => o.price != null && Number.isFinite(o.price) && o.price > 0;
  const noPrice = asks.filter(o => !priced(o)).length + bids.filter(o => !priced(o)).length;
  const a = asks.filter(priced).sort((x, y) => x.price - y.price);
  const b = bids.filter(priced).sort((x, y) => y.price - x.price);
  const rate = Number.isFinite(center) && center > 0 ? center : null;
  const c = rate ?? (a.length && b.length ? (a[0].price + b[0].price) / 2 : (a[0] ?? b[0])?.price ?? null);
  const empty = { center: c, rate, step: null, points: [], view: null, totals: { bid: null, ask: null }, noPrice, outside: 0, ranges: 0 };
  if (c == null) return empty;

  const lo = c / SPAN, hi = c * SPAN;
  const inScale = o => o.price >= lo && o.price <= hi;
  const sa = a.filter(inScale), sb = b.filter(inScale);
  const outside = a.length + b.length - sa.length - sb.length;
  if (!sa.length && !sb.length) return { ...empty, outside };

  const step = niceStep(c * STEP);
  const size = gridValue(step, 1);
  const prices = [...sa, ...sb].map(o => o.price);
  const from = Math.max(lo, Math.min(c * (1 - WINDOW), ...prices) - c * MARGIN);
  const to = Math.min(hi, Math.max(c * (1 + WINDOW), ...prices) + c * MARGIN);
  // Rounded outwards: an order near the ends of the scale still falls on a point of the grid
  const k0 = Math.floor(from / size), k1 = Math.ceil(to / size);
  const points = [];
  for (let k = k0; k <= k1; k++) points.push({ x: gridValue(step, k), bid: null, ask: null });

  // Sellers from the cheapest, upwards; buyers from the dearest, downwards
  let j = 0, cum = 0;
  for (const p of points) {
    while (j < sa.length && sa[j].price <= p.x) cum += sa[j++].size;
    if (j) p.ask = { cum, n: j, order: sa[j - 1] };
  }
  j = 0; cum = 0;
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    while (j < sb.length && sb[j].price >= p.x) cum += sb[j++].size;
    if (j) p.bid = { cum, n: j, order: sb[j - 1] };
  }

  // The initial view: ±WINDOW around the center, with the best prices of both sides (and a margin)
  const best = [sa[0]?.price, sb[0]?.price].filter(p => p != null);
  const vFrom = Math.min(c * (1 - WINDOW), ...best.map(p => p - c * MARGIN / 2));
  const vTo = Math.max(c * (1 + WINDOW), ...best.map(p => p + c * MARGIN / 2));
  const total = side => side.length ? { cum: side.reduce((s, o) => s + o.size, 0), n: side.length } : null;
  return {
    center: c, rate, step: size, points,
    view: { from: Math.max(vFrom, points[0].x), to: Math.min(vTo, points.at(-1).x) },
    totals: { bid: total(sb), ask: total(sa) },
    noPrice, outside,
    // Orders with a range (19.500–130.000), counted by their maximum as the book's depth bar
    ranges: [...sa, ...sb].filter(o => o.fa?.length > 1).length,
  };
}
