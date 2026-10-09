// Page of the rate. The logic of the rate comes from shared/ (pure, tested with node --test); this
// module connects the data (relays → event store) to the render and wires the page together.
import { getTrades as tradesOf, getBook as bookOf } from '../shared/orders.js';
import { pmStats, defaultPmSelection } from '../shared/payment-methods.js';
import { state, store, saveView, HIDDEN_PM } from './state.js';
import { createRelayPool } from './nostr-client.js';
import { ensurePrices, loadBtcHistory, marketFor, unitPrice } from './prices.js';
import { chartC, view, renderChart, setEmpty, applyChartTheme } from './chart.js';
import { setStatus, renderStats, renderSelection, renderTrades, renderBook, renderFilters, updatePair } from './panels.js';
import { openEvent } from './event-dialog.js';

// ---------- Data: the node's relays ----------
// Signatures are verified with nostr-tools (vendor/); if it didn't load, we go on unverified and say so
const verifyEvent = window.NostrTools?.verifyEvent ?? null;
state.sigs = verifyEvent ? 'ok' : 'off';

const relays = createRelayPool({
  urls: CONFIG.relays, authors: CONFIG.mostros, kinds: [38383],
  // Node information and the prices it uses for market orders (mostro-rates)
  metaFilters: [{ kinds: META_KINDS }, { kinds: [30078], '#d': ['mostro-rates'] }],
  verify: verifyEvent, has: store.has,
  onEvent(ev, live) {
    if (!store.add(ev)) return false;
    if (live && ev.tags.some(t => t[0] === 's' && t[1] === 'success')) markFresh(ev);
    return true;
  },
  onUpdate: () => scheduleRender(),
  onStatus: () => setStatus(),
});
Object.defineProperties(state, {
  live: { get: () => relays.live, enumerable: true },
  rejected: { get: () => relays.rejected, enumerable: true },
});

// An order completed while the page is open: highlighted in the table
function markFresh(ev) {
  const d = ev.tags.find(t => t[0] === 'd')?.[1];
  const o = state.orders.get(ev.pubkey + ':' + d);
  if (o) o.fresh = true;
}

// ---------- Derived data ----------
const filters = () => ({ fiat: state.fiat, nodes: state.nodeSel, pmSel: state.pmSel });

function getTrades() {
  state.btcApprox = false;
  return tradesOf([...state.orders.values()], filters(), unitPrice);
}

// The official Tasa K follows the site's rules, not the visitor's filters: every node of the
// configuration and the payment methods it doesn't hide. Only the currency and the unit are chosen
function getOfficialTrades() {
  const orders = [...state.orders.values()];
  const nodes = new Set(CONFIG.mostros);
  const keys = pmStats(orders, { fiat: state.fiat, nodes, now: Date.now() / 1000 }).map(s => s.key);
  return tradesOf(orders, { fiat: state.fiat, nodes, pmSel: defaultPmSelection(keys, HIDDEN_PM) }, unitPrice);
}

// Market orders, each with its node's market price
function getBook() {
  return bookOf([...state.orders.values()], filters(), {
    now: Date.now() / 1000, market: marketFor, toPrice: p => unitPrice(p),
  });
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
      await ensurePrices();
      if (state.unit === 'usd') {
        const ts = [...state.orders.values()].filter(o => o.status === 'success').map(o => o.ts);
        if (ts.length) await loadBtcHistory(Math.min(...ts));
      }
      const trades = getTrades();
      renderChart(trades);
      const tasa = renderStats(getOfficialTrades(), trades);
      renderSelection(trades, tasa);
      renderTrades(trades);
      renderBook(tasa, getBook());
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
// Back to the default methods and nodes: «Your selection» disappears
document.getElementById('selReset').onclick = () => {
  state.nodeSel = new Set(CONFIG.mostros);
  state.pmSel = null;
  state.pmKnown = null;
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

// On a theme change the chart takes the new colours and is drawn again
document.addEventListener('themechange', () => { applyChartTheme(); scheduleRender(); });

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
  state, store, relays, chartC, getTrades, getBook, renderFilters, renderChart, scheduleRender,
  get view() { return view; }, get rendering() { return rendering; }, get renderQueued() { return renderQueued; },
};

updatePair();
if (!CONFIG.mostros.length || !CONFIG.relays.length) {
  const msg = CONFIG.fromEnv
    ? t('Configuración sin nodos o sin relays válidos')
    : t('Falta config.js: ejecuta «tasak build» o pasa ?mostro=…&relays=… en la URL');
  setStatus(msg);
  setEmpty(chartC, true, msg);
} else {
  setStatus();
  relays.start();
  scheduleRender();
  // If no relay answers, Yadio's API is asked after 15 s (see ensurePrices)
  setTimeout(scheduleRender, 15 * 1000);
  // Expires book orders and the node's prices, and moves the 24 h window
  setInterval(scheduleRender, 60 * 1000);
}
