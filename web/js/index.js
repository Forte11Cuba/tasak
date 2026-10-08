// Page of the rate. The logic of the rate comes from shared/ (pure, tested with node --test); this
// module holds the data (relays, signatures) and the render, and wires the page together.
import { pmListFor } from '../shared/payment-methods.js';
import { parseOrder, nextVersion, getTrades as tradesOf, getBook as bookOf } from '../shared/orders.js';
import { state, saveView } from './state.js';
import { loadYadio, loadBtcHistory, btcSpot, yadioFiatPerUsd, unitPrice } from './prices.js';
import { chartC, view, renderChart, setEmpty, applyChartTheme } from './chart.js';
import { setStatus, renderStats, renderTrades, renderBook, renderFilters, updatePair } from './panels.js';
import { openEvent } from './event-dialog.js';

const MOSTROS = new Set(CONFIG.mostros);

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
