// Captures, once, the fixed data the reference values are computed from (shared/test/fixtures/):
//   events.json   unique signed events of the archive: orders (38383) and node metadata
//   btcusd.json   Coinbase hourly BTC/USD closes covering those orders {hour (unix s): close}
//   yadio.json    a Yadio /exrates/USD response (BTC/USD and each currency per USD)
//   config.json   the site configuration (window.TASAK_CONFIG), from .env.example
//   meta.json     the fixed «now», browser time zone and where the data came from
//
// Usage: node tools/capture-fixtures.mjs <archive .jsonl> [now, unix s]
//   (Node >= 22; downloads from Coinbase and Yadio)
// The fixtures are committed: run this again only to replace them on purpose, and then regenerate
// shared/test/expected.json with tools/reference.mjs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const dir = new URL('shared/test/fixtures/', root);
const [archive, nowArg] = process.argv.slice(2);
if (!archive) {
  console.error('Usage: node tools/capture-fixtures.mjs <archive .jsonl> [now, unix s]');
  process.exit(1);
}
mkdirSync(dir, { recursive: true });

// --- Events: unique by id, only what index.html reads (orders and node metadata) ---
// (each archive line is {"relay", "recibido", "evento"}, the archiver's format)
const KINDS = new Set([38383, 0, 10002, 38385]);
const byId = new Map();
for (const line of readFileSync(archive, 'utf8').split('\n')) {
  if (!line) continue;
  const { evento: ev } = JSON.parse(line);
  if (KINDS.has(ev.kind)) byId.set(ev.id, ev);
}
const events = [...byId.values()].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
const orders = events.filter(e => e.kind === 38383);
const from = Math.min(...orders.map(e => e.created_at));
const newest = Math.max(...events.map(e => e.created_at));
// «Now» defaults to the hour after the newest event, so that the last 24 h hold real orders
const now = Number(nowArg) || Math.ceil((newest + 1) / 3600) * 3600;

// --- Coinbase hourly candles, at most 300 per request, from 1 h before the oldest order ---
const btcusd = {};
const step = 300 * 3600;
for (let start = Math.floor(from / 3600) * 3600 - 3600; start < now; start += step) {
  const end = Math.min(start + step, now);
  const url = 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600'
    + `&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'tasaK fixtures' } });
  if (!res.ok) throw new Error(`Coinbase HTTP ${res.status}`);
  for (const [time, , , , close] of await res.json()) btcusd[time] = close;
}

// --- Yadio: the same request the page makes ---
const yadio = await (await fetch('https://api.yadio.io/exrates/USD')).json();

// --- Configuration: .env.example (the working Kmbalache example), as build.mjs reads it ---
const env = {};
for (const line of readFileSync(new URL('.env.example', root), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !line.trim().startsWith('#')) env[m[1]] = m[2];
}
const list = s => (s || '').split(/[\s,]+/).filter(Boolean);
// The same keys build.mjs writes to config.js
const config = {
  nombreSitio: env.SITE_NAME || 'tasaK',
  nombreTasa: env.RATE_NAME || 'Tasa K',
  logo: env.LOGO || '',
  logoClaro: env.LOGO_LIGHT || '',
  tema: env.THEME || '',
  idioma: env.LANGUAGE || '',
  mostros: list(env.MOSTRO_PUBKEYS),
  relays: list(env.RELAYS),
  fiat: (env.FIAT || '').toUpperCase(),
  zonaHoraria: env.TIMEZONE || '',
  comunidad: { nombre: env.COMMUNITY || '', url: env.COMMUNITY_URL || '' },
  rrss: list(env.SOCIAL_LINKS),
  metodosOcultos: env.HIDDEN_PAYMENT_METHODS == null ? ['Pruebas', 'Otros']
    : env.HIDDEN_PAYMENT_METHODS.split(',').map(s => s.trim()).filter(Boolean),
};

const write = (name, data) => writeFileSync(new URL(name, dir), JSON.stringify(data, null, 1) + '\n');
write('events.json', events);
write('btcusd.json', btcusd);
write('yadio.json', yadio);
write('config.json', config);
write('meta.json', {
  now,
  // The visitor's browser time zone: the old tzOffset() depended on it, not only on CONFIG.tz
  browserTimeZone: config.zonaHoraria || 'UTC',
  capturedAt: new Date().toISOString(),
  events: { file: archive.split('/').pop(), total: events.length, orders: orders.length },
  btcusd: { source: 'Coinbase BTC-USD candles granularity=3600 (close)', hours: Object.keys(btcusd).length },
  yadio: { source: 'https://api.yadio.io/exrates/USD', BTC: yadio.BTC },
});
console.log(`${events.length} events (${orders.length} orders), ${Object.keys(btcusd).length} BTC/USD hours,`
  + ` now = ${new Date(now * 1000).toISOString()} -> ${dir.pathname}`);
