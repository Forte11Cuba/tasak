// Captures, once, the fixed data the reference values are computed from (shared/test/fixtures/):
//   eventos.json  unique signed events of the archive: orders (38383) and node metadata
//   btcusd.json   Coinbase hourly BTC/USD closes covering those orders {hour (unix s): close}
//   yadio.json    a Yadio /exrates/USD response (BTC/USD and each currency per USD)
//   config.json   the site configuration (window.TASAK_CONFIG), from .env.example
//   meta.json     the fixed «now», browser time zone and where the data came from
//
// Usage: node tools/capturar-fixtures.mjs <archive .jsonl> [now, unix s]
//   (Node >= 22; downloads from Coinbase and Yadio)
// The fixtures are committed: run this again only to replace them on purpose, and then regenerate
// shared/test/esperado.json with tools/referencia.mjs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const raiz = new URL('../', import.meta.url);
const dir = new URL('shared/test/fixtures/', raiz);
const [archivo, ahoraArg] = process.argv.slice(2);
if (!archivo) {
  console.error('Usage: node tools/capturar-fixtures.mjs <archive .jsonl> [now, unix s]');
  process.exit(1);
}
mkdirSync(dir, { recursive: true });

// --- Events: unique by id, only what index.html reads (orders and node metadata) ---
const KINDS = new Set([38383, 0, 10002, 38385]);
const eventos = new Map();
for (const line of readFileSync(archivo, 'utf8').split('\n')) {
  if (!line) continue;
  const { evento } = JSON.parse(line);
  if (KINDS.has(evento.kind)) eventos.set(evento.id, evento);
}
const lista = [...eventos.values()].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
const ordenes = lista.filter(e => e.kind === 38383);
const desde = Math.min(...ordenes.map(e => e.created_at));
const hasta = Math.max(...lista.map(e => e.created_at));
// «Now» defaults to the hour after the newest event, so that the last 24 h hold real orders
const ahora = Number(ahoraArg) || Math.ceil((hasta + 1) / 3600) * 3600;

// --- Coinbase hourly candles, at most 300 per request, from 1 h before the oldest order ---
const btcusd = {};
const paso = 300 * 3600;
for (let inicio = Math.floor(desde / 3600) * 3600 - 3600; inicio < ahora; inicio += paso) {
  const fin = Math.min(inicio + paso, ahora);
  const url = 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600'
    + `&start=${new Date(inicio * 1000).toISOString()}&end=${new Date(fin * 1000).toISOString()}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'tasaK fixtures' } });
  if (!res.ok) throw new Error(`Coinbase HTTP ${res.status}`);
  for (const [time, , , , close] of await res.json()) btcusd[time] = close;
}

// --- Yadio: the same request the page makes ---
const yadio = await (await fetch('https://api.yadio.io/exrates/USD')).json();

// --- Configuration: .env.example (the working Kmbalache example), as build.mjs reads it ---
const env = {};
for (const line of readFileSync(new URL('.env.example', raiz), 'utf8').split(/\r?\n/)) {
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

const escribir = (nombre, datos) => writeFileSync(new URL(nombre, dir), JSON.stringify(datos, null, 1) + '\n');
escribir('eventos.json', lista);
escribir('btcusd.json', btcusd);
escribir('yadio.json', yadio);
escribir('config.json', config);
escribir('meta.json', {
  ahora,
  // The visitor's browser time zone: tzOffset() depends on it, not only on CONFIG.tz
  zonaNavegador: config.zonaHoraria || 'UTC',
  capturado: new Date().toISOString(),
  eventos: { archivo: archivo.split('/').pop(), total: lista.length, ordenes: ordenes.length },
  btcusd: { fuente: 'Coinbase BTC-USD candles granularity=3600 (close)', horas: Object.keys(btcusd).length },
  yadio: { fuente: 'https://api.yadio.io/exrates/USD', BTC: yadio.BTC },
});
console.log(`${lista.length} events (${ordenes.length} orders), ${Object.keys(btcusd).length} BTC/USD hours,`
  + ` now = ${new Date(ahora * 1000).toISOString()} -> ${dir.pathname}`);
