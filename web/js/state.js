// State of the page and the configuration it starts from: .env (config.js) with the URL on top.
import { pmListFor, hiddenSet } from '../shared/payment-methods.js';
import { createStore } from './event-store.js';

// Methods that don't count by default (HIDDEN_PAYMENT_METHODS in .env)
export const HIDDEN_PM = hiddenSet(CONFIG.hiddenPaymentMethods);

// Payment methods: makers type them by hand; they are matched against the Mostro app's list for that
// currency (vendor/mostro-payment-methods.js) and whatever doesn't match goes to «Otros»
const PM_LISTS = window.MOSTRO_PAYMENT_METHODS || {};

// Events of the node: every version of each order and the node's information
export const store = createStore(fiat => pmListFor(PM_LISTS, fiat));

export const state = {
  orders: store.orders,   // pubkey:d -> current state of the order
  nodeNames: store.nodeNames,
  nodeMeta: store.meta,   // pubkey -> { profile, info, relays } read from its Nostr events
  nodeRates: store.rates,   // pubkey -> newest mostro-rates of the node
  // live (relays connected) and rejected (invalid signatures): from the relay pool, in index.js
  btcusd: new Map(),   // unix hour -> BTC/USD
  btcLoadedFrom: Infinity,
  btcRetryAt: 0,       // after a Coinbase failure, don't retry before this time (ms)
  btcApprox: false,
  yadio: null,         // Yadio's API, only if no node publishes mostro-rates: { BTC, USD: { CUP, ... } }
  fiat: CONFIG.fiat,
  fiatAuto: !CONFIG.fiat,   // no FIAT in .env or URL: the most used currency on the node
  unit: 'usd',
  // 'line' = price, 'candles' = candles, 'avg' = weighted; by default the price of each order,
  // or the last view chosen in this browser
  mode: 'line',
  tf: 0,               // chart period in seconds; 0 = one point per order
  pmSel: null,         // Set of active methods; null = defaults
  nodeSel: new Set(CONFIG.mostros),
  sigs: 'cargando',
  // From the server's snapshot (api/snapshot.json), if there is one
  serverBtcUsd: new Map(),   // order key -> { usd, source, at }: the BTC/USD the server gave it
  signedRate: null,          // the Tasa K signed with the key of config.js (ratePubkey)
  snapshotAt: 0,             // when the server wrote the snapshot
  snapshotRejected: 0,       // its events with an invalid signature
};

// Last chart view chosen (mode and timeframe)
try {
  const v = JSON.parse(localStorage.getItem('tasak.view'));
  if (['line', 'candles', 'avg'].includes(v?.mode)) state.mode = v.mode;
  if ([0, 3600, 14400, 86400, 604800, 2592000, 31536000].includes(v?.tf)) state.tf = v.tf;
} catch {}

export const saveView = () => { try { localStorage.setItem('tasak.view', JSON.stringify({ mode: state.mode, tf: state.tf })); } catch {} };

export const shortKey = k => k.slice(0, 8) + '…';
export const nodeName = k => state.nodeNames.get(k) || shortKey(k);
