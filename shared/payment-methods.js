// Payment methods. Makers type the method by hand; it is matched against the Mostro app's list for
// that currency (vendor/mostro-payment-methods.js), and whatever does not match (phone numbers,
// notes, unusual banks…) goes to «Otros» so the filter does not fill up with free text.
// Pure: the lists and the hidden methods come as parameters.

export const OTHERS = 'Otros';
export const TESTS = 'Pruebas';
export const NO_METHOD = 'Sin método';
const FALLBACK_LIST = ['Bank Transfer', 'Cash in person'];

// Compared without accents, case, emojis or flags, and with collapsed spaces
export const normPm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\p{Extended_Pictographic}|\p{Regional_Indicator}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Methods of a currency; `lists` is { CUP: [...], ..., default: [...] }
export const pmListFor = (lists, fiat) => lists[fiat] || lists.default || FALLBACK_LIST;

// Method of the list that a free text refers to
export function pmKey(raw, list) {
  const s = normPm(raw);
  if (/prueba|\btest\b|no tomar/.test(s)) return TESTS;
  const norm = list.map(m => ({ m, n: normPm(m) }));
  // 1) equal («Cash» → Cash, not Cash App); 2) the text contains the method, the longest one
  // («360 CUP de saldo móvil 📲» → Saldo móvil); 3) the text is part of a single method («Clásica»)
  const exact = norm.find(x => x.n === s);
  if (exact) return exact.m;
  const inside = norm.filter(x => s.includes(x.n)).sort((a, b) => b.n.length - a.n.length)[0];
  if (inside) return inside.m;
  const partial = s.length >= 4 ? norm.filter(x => x.n.includes(s)) : [];
  return partial.length === 1 ? partial[0].m : OTHERS;
}

// Whether an order passes the selected methods (a Set); test orders only with «Pruebas» selected
export function orderMatchesPm(o, selected) {
  if (o.pmKeys.includes(TESTS)) return selected.has(TESTS);
  return o.pmKeys.some(k => selected.has(k));
}

// Hidden by default: HIDDEN_PAYMENT_METHODS of the .env
export const hiddenSet = names => new Set(names.map(normPm));
export const isHidden = (key, hidden) => hidden.has(normPm(key));

// Methods of a currency with completed and open orders (pending and not expired) of each, in the
// filter's order: «Otros» last, then most completed, most open and by name
export function pmStats(orders, { fiat, nodes, now }) {
  const counts = new Map();
  for (const o of orders) {
    if (o.fiat !== fiat || !nodes.has(o.node)) continue;
    const open = o.status === 'pending' && !(o.expiresAt && o.expiresAt < now);
    for (const k of o.pmKeys) {
      const c = counts.get(k) || { done: 0, open: 0 };
      if (o.status === 'success') c.done++;
      if (open) c.open++;
      counts.set(k, c);
    }
  }
  return [...counts].map(([key, c]) => ({ key, ...c })).sort((a, b) =>
    (a.key === OTHERS) - (b.key === OTHERS) || b.done - a.done || b.open - a.open || a.key.localeCompare(b.key));
}

// Selected by default: every method that is not hidden
export const defaultPmSelection = (keys, hidden) => new Set(keys.filter(k => !isHidden(k, hidden)));
