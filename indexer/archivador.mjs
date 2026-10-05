// Event archiver: stores, as received, everything the Mostro nodes in .env publish, so that the
// intermediate versions of each order (pending, in-progress) and the mostro-rates, which relays
// replace or delete after 10 min, are not lost. The indexer will import these files later.
//
// Usage: node indexer/archivador.mjs   (Node >= 22: native WebSocket; no dependencies)
//
// Writes to ARCHIVE_DIR (default indexer/data/):
//   eventos/YYYY-MM-DD.jsonl  {"relay", "recibido", "evento"}: orders once per relay that sent them;
//                             mostro-rates once; node metadata only when it changes
//   yadio/YYYY-MM-DD.jsonl    {"recibido", "url", "datos"}: BTC/USD every 5 min for the last 24 h
// The file date and «recibido» (unix, s) are the reception time, in UTC.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';

if (typeof WebSocket === 'undefined') {
  console.error(`Node ${process.versions.node} has no WebSocket: Node 22 or newer is required.`);
  process.exit(1);
}

const raiz = new URL('../', import.meta.url);

// nostr-tools from vendor/ (the same one the site uses). It must run in this context: in a separate
// vm context its Uint8Array checks fail and verifyEvent always returns false
runInThisContext(readFileSync(new URL('vendor/nostr-tools-2.25.2.bundle.min.js', raiz), 'utf8')
  + ';globalThis.NostrTools = NostrTools;');
const { verifyEvent, nip19 } = globalThis.NostrTools;

// --- Configuration: the site's .env (process environment variables take precedence) ---
const fileEnv = {};
const envFile = new URL('.env', raiz);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    fileEnv[m[1]] = v;
  }
}
const get = k => process.env[k] ?? fileEnv[k];
const list = s => (s || '').split(/[\s,]+/).filter(Boolean);

const errors = [];
const mostros = list(get('MOSTRO_PUBKEYS')).map(k => {
  if (/^[0-9a-f]{64}$/i.test(k)) return k.toLowerCase();
  try { const d = nip19.decode(k); if (d.type === 'npub') return d.data; } catch {}
  errors.push(`invalid pubkey: ${k}`);
}).filter(Boolean);
const relays = list(get('RELAYS'));
if (!mostros.length) errors.push('MOSTRO_PUBKEYS is empty');
if (!relays.length) errors.push('RELAYS is empty');
for (const r of relays) {
  if (!/^wss:\/\/\S+$/i.test(r) && !/^ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/i.test(r)) {
    errors.push(`invalid relay (must start with wss://): ${r}`);
  }
}
if (errors.length) {
  console.error('Configuration error:\n  ' + errors.join('\n  '));
  process.exit(1);
}
const dirDatos = get('ARCHIVE_DIR') ? new URL(get('ARCHIVE_DIR').replace(/\/?$/, '/'), `file://${process.cwd()}/`)
  : new URL('indexer/data/', raiz);
for (const d of ['eventos', 'yadio']) mkdirSync(new URL(d, dirDatos), { recursive: true });

// Every currency and everything the node publishes about itself: filtering later is free,
// recovering what was not stored is impossible
const FILTROS = [
  { kinds: [38383], authors: mostros },                     // orders (NIP-69)
  { kinds: [0, 10002, 38385], authors: mostros },           // node profile, relays and info
  { kinds: [30078], authors: mostros, '#d': ['mostro-rates'] }, // Yadio prices, expire after 10 min
];
const KINDS = new Set(FILTROS.flatMap(f => f.kinds));
const LIMITE = 500;                 // events per query when paging history
const MARGEN = 3600;                // on reconnect, fetch from one hour before the last reception
const SILENCIO = 10 * 60 * 1000;    // no messages for 10 min: the connection is dead

const ahora = () => Math.floor(Date.now() / 1000);
const dia = s => new Date(s * 1000).toISOString().slice(0, 10);
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);

// Orders: one line per relay that sent them (to check later which relay had what).
// mostro-rates: once per id (all relays send the same one).
// Node metadata (0, 10002, 38385): only when it changes; the node republishes it every 1-5 min.
const META = new Set([0, 10002, 38385]);
const claveDe = (relay, e) => e.kind === 38383 ? `${relay} ${e.id}` : e.id;
// Content and tags without publication dates; tags sorted (10002 changes their order on each publish)
const huella = e => JSON.stringify([e.content, e.tags.filter(t => t[0] !== 'published_at').map(t => JSON.stringify(t)).sort()]);
const metaDe = e => `${e.kind} ${e.pubkey} ${e.tags.find(t => t[0] === 'd')?.[1] ?? ''}`;

// --- State rebuilt from the files of the last 20 days (relays keep ~15) ---
const vistos = new Set();           // claveDe(): no duplicate lines after a restart or reconnect
const ultimo = new Map();           // relay -> last reception (s)
const ultimaMeta = new Map();       // metaDe() -> huella() of the last one stored
{
  const desde = dia(ahora() - 20 * 86400);
  const dir = new URL('eventos/', dirDatos);
  let n = 0;
  for (const f of readdirSync(dir).filter(f => f.endsWith('.jsonl') && f >= desde).sort()) {
    for (const line of readFileSync(new URL(f, dir), 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const { relay, recibido, evento } = JSON.parse(line);
        vistos.add(claveDe(relay, evento));
        if (META.has(evento.kind)) ultimaMeta.set(metaDe(evento), huella(evento));
        if (recibido > (ultimo.get(relay) ?? 0)) ultimo.set(relay, recibido);
        n++;
      } catch {}  // a line cut short by a power outage must not stop the start
    }
  }
  log(`archive: ${n} lines in the last 20 days`);
}

function guardar(relay, evento) {
  const clave = claveDe(relay, evento);
  if (vistos.has(clave)) { ultimo.set(relay, ahora()); return false; }
  // Only valid events from the node: signature, author and kind
  if (!mostros.includes(evento.pubkey) || !KINDS.has(evento.kind) || !verifyEvent(evento)) return false;
  vistos.add(clave);
  const recibido = ahora();
  ultimo.set(relay, recibido);
  if (META.has(evento.kind)) {
    const h = huella(evento);
    if (ultimaMeta.get(metaDe(evento)) === h) return false;
    ultimaMeta.set(metaDe(evento), h);
  }
  appendFileSync(new URL(`eventos/${dia(recibido)}.jsonl`, dirDatos),
    JSON.stringify({ relay, recibido, evento }) + '\n');
  return true;
}

// --- Connection to one relay: paged history, then a permanent subscription ---
class Conexion {
  constructor(url) {
    this.url = url;
    this.espera = 5000;
    this.consultas = new Map();     // subscription id -> { eventos, fin }
    this.n = 0;
  }

  conectar() {
    const ws = this.ws = new WebSocket(this.url);
    this.vivo = Date.now();
    ws.onopen = () => this.alAbrir().catch(e => { log(this.url, 'error:', e.message); ws.close(); });
    ws.onmessage = m => this.alMensaje(m.data);
    ws.onerror = () => {};           // the reason arrives in onclose
    ws.onclose = () => {
      clearInterval(this.vigia);
      for (const q of this.consultas.values()) q.fin(null);
      this.consultas.clear();
      if (this.abierta) log(this.url, 'disconnected');
      this.abierta = false;
      this.caida ??= Date.now();
      setTimeout(() => this.conectar(), this.espera);
      this.espera = Math.min(this.espera * 2, 5 * 60 * 1000);
    };
    // A relay that stops answering does not always close the connection
    this.vigia = setInterval(() => { if (Date.now() - this.vivo > SILENCIO) ws.close(); }, 60 * 1000);
  }

  alMensaje(data) {
    this.vivo = Date.now();
    let m;
    try { m = JSON.parse(data); } catch { return; }
    const q = this.consultas.get(m[1]);
    if (m[0] === 'EVENT' && m[2]) {
      if (q) q.eventos.push(m[2]);
      else if (guardar(this.url, m[2])) log(this.url, `new event kind ${m[2].kind}`);
    } else if ((m[0] === 'EOSE' || m[0] === 'CLOSED') && q) {
      if (m[0] === 'CLOSED') log(this.url, 'CLOSED:', m[2]);
      q.fin(m[0] === 'EOSE' ? q.eventos : null);
    } else if (m[0] === 'CLOSED') {
      log(this.url, 'live subscription CLOSED:', m[2]);
      this.ws.close();
    } else if (m[0] === 'NOTICE') {
      log(this.url, 'NOTICE:', m[1]);
    }
  }

  // A query that ends at EOSE; resolves to its events (null if interrupted)
  consulta(filtro) {
    const id = `h${++this.n}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => q.fin(null), 60 * 1000);
      const q = {
        eventos: [],
        fin: ev => {
          clearTimeout(timer);
          if (!this.consultas.delete(id)) return;
          if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(['CLOSE', id]));
          resolve(ev);
        },
      };
      this.consultas.set(id, q);
      this.ws.send(JSON.stringify(['REQ', id, filtro]));
    });
  }

  // Backwards with until, per filter (each one has its own limit), until a batch brings nothing new.
  // «Fewer than LIMITE» is not enough: some relays return fewer events than requested
  async historial(filtro, since) {
    const ids = new Set();
    let until, total = 0;
    for (;;) {
      const f = { ...filtro, limit: LIMITE };
      if (since) f.since = since;
      if (until) f.until = until;
      const eventos = await this.consulta(f);
      if (!eventos) throw new Error('history query interrupted');
      const nuevos = eventos.filter(e => !ids.has(e.id));
      if (!nuevos.length) break;
      for (const e of nuevos) {
        ids.add(e.id);
        if (guardar(this.url, e)) total++;
      }
      // until is inclusive: if a whole batch shares one second, step back one so as not to get stuck
      const min = Math.min(...eventos.map(e => e.created_at));
      until = min === until ? min - 1 : min;
    }
    return total;
  }

  async alAbrir() {
    this.abierta = true;
    const corte = this.caida ? Math.round((Date.now() - this.caida) / 1000) : 0;
    this.caida = null;
    const desde = ultimo.has(this.url) ? ultimo.get(this.url) - MARGEN : undefined;
    log(this.url, 'connected' + (desde ? `, fetching since ${new Date(desde * 1000).toISOString()}` : ', fetching full history'));
    // The permanent subscription goes first so nothing is missed while history is paged
    this.ws.send(JSON.stringify(['REQ', 'vivo', ...FILTROS.map(f => ({ ...f, since: ahora() - 60 }))]));
    let total = 0;
    for (const f of FILTROS) total += await this.historial(f, desde);
    log(this.url, `history: ${total} new events`);
    this.espera = 5000;
    // After a long outage, the lost mostro-rates can only be recovered from Yadio (last 24 h)
    if (corte > 5 * 60) yadio('reconnection');
  }
}

// --- Yadio: BTC/USD every 5 min for the last 24 h (the same values mostro-rates publishes) ---
const URL_YADIO = 'https://api.yadio.io/today/24/USD';
let ultimaYadio = 0, reintento = null;
async function yadio(motivo) {
  if (reintento || Date.now() - ultimaYadio < 30 * 60 * 1000) return;   // at most every half hour
  ultimaYadio = Date.now();
  try {
    const res = await fetch(URL_YADIO, { signal: AbortSignal.timeout(30 * 1000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const datos = await res.json();
    if (!Array.isArray(datos)) throw new Error('unexpected response');
    const recibido = ahora();
    appendFileSync(new URL(`yadio/${dia(recibido)}.jsonl`, dirDatos),
      JSON.stringify({ recibido, url: URL_YADIO, datos }) + '\n');
    log(`yadio (${motivo}): ${datos.length} prices`);
  } catch (e) {
    log(`yadio (${motivo}) failed: ${e.message}; retrying in 5 min`);
    ultimaYadio = 0;
    reintento = setTimeout(() => { reintento = null; yadio(motivo); }, 5 * 60 * 1000);
  }
}

log(`archiver: ${mostros.length} node(s), ${relays.length} relay(s), data in ${dirDatos.pathname}`);
for (const r of relays) new Conexion(r).conectar();
yadio('start');
// Every 12 h: two overlapping downloads cover the 24 h even if one fails
setInterval(() => yadio('periodic'), 12 * 3600 * 1000);
