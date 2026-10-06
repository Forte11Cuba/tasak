// Event archiver: stores, as received, everything the Mostro nodes in .env publish, so that the
// intermediate versions of each order (pending, in-progress) and the mostro-rates, which relays
// replace or delete after 10 min, are not lost. The indexer will import these files later.
//
// Usage: node indexer/archiver.mjs   (Node >= 22: native WebSocket; no dependencies)
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

const root = new URL('../', import.meta.url);

// nostr-tools from web/vendor/ (the same one the site uses). It must run in this context: in a separate
// vm context its Uint8Array checks fail and verifyEvent always returns false
runInThisContext(readFileSync(new URL('web/vendor/nostr-tools-2.25.2.bundle.min.js', root), 'utf8')
  + ';globalThis.NostrTools = NostrTools;');
const { verifyEvent, nip19 } = globalThis.NostrTools;

// --- Configuration: the site's .env (process environment variables take precedence) ---
const fileEnv = {};
const envFile = new URL('.env', root);
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
const dataDir = get('ARCHIVE_DIR') ? new URL(get('ARCHIVE_DIR').replace(/\/?$/, '/'), `file://${process.cwd()}/`)
  : new URL('indexer/data/', root);
for (const d of ['eventos', 'yadio']) mkdirSync(new URL(d, dataDir), { recursive: true });

// Every currency and everything the node publishes about itself: filtering later is free,
// recovering what was not stored is impossible
const FILTERS = [
  { kinds: [38383], authors: mostros },                     // orders (NIP-69)
  { kinds: [0, 10002, 38385], authors: mostros },           // node profile, relays and info
  { kinds: [30078], authors: mostros, '#d': ['mostro-rates'] }, // Yadio prices, expire after 10 min
];
const KINDS = new Set(FILTERS.flatMap(f => f.kinds));
const LIMIT = 500;               // events per query when paging history
const MARGIN = 3600;             // on reconnect, fetch from one hour before the last reception
const SILENCE = 10 * 60 * 1000;  // no messages for 10 min: the connection is dead

const now = () => Math.floor(Date.now() / 1000);
const day = s => new Date(s * 1000).toISOString().slice(0, 10);
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);

// Orders: one line per relay that sent them (to check later which relay had what).
// mostro-rates: once per id (all relays send the same one).
// Node metadata (0, 10002, 38385): only when it changes; the node republishes it every 1-5 min.
const META = new Set([0, 10002, 38385]);
const keyOf = (relay, e) => e.kind === 38383 ? `${relay} ${e.id}` : e.id;
// Content and tags without publication dates; tags sorted (10002 changes their order on each publish)
const fingerprint = e => JSON.stringify([e.content, e.tags.filter(t => t[0] !== 'published_at').map(t => JSON.stringify(t)).sort()]);
const metaKey = e => `${e.kind} ${e.pubkey} ${e.tags.find(t => t[0] === 'd')?.[1] ?? ''}`;

// --- State rebuilt from the files of the last 20 days (relays keep ~15) ---
const seen = new Set();          // keyOf(): no duplicate lines after a restart or reconnect
const lastReceived = new Map();   // relay -> last reception (s)
const lastMeta = new Map();      // metaKey() -> fingerprint() of the last one stored
{
  const from = day(now() - 20 * 86400);
  const dir = new URL('eventos/', dataDir);
  let n = 0;
  for (const f of readdirSync(dir).filter(f => f.endsWith('.jsonl') && f >= from).sort()) {
    for (const line of readFileSync(new URL(f, dir), 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const { relay, recibido: received, evento: ev } = JSON.parse(line);
        seen.add(keyOf(relay, ev));
        if (META.has(ev.kind)) lastMeta.set(metaKey(ev), fingerprint(ev));
        if (received > (lastReceived.get(relay) ?? 0)) lastReceived.set(relay, received);
        n++;
      } catch {}  // a line cut short by a power outage must not stop the start
    }
  }
  log(`archive: ${n} lines in the last 20 days`);
}

function store(relay, ev) {
  const key = keyOf(relay, ev);
  if (seen.has(key)) { lastReceived.set(relay, now()); return false; }
  // Only valid events from the node: signature, author and kind
  if (!mostros.includes(ev.pubkey) || !KINDS.has(ev.kind) || !verifyEvent(ev)) return false;
  seen.add(key);
  const received = now();
  lastReceived.set(relay, received);
  if (META.has(ev.kind)) {
    const h = fingerprint(ev);
    if (lastMeta.get(metaKey(ev)) === h) return false;
    lastMeta.set(metaKey(ev), h);
  }
  appendFileSync(new URL(`eventos/${day(received)}.jsonl`, dataDir),
    JSON.stringify({ relay, recibido: received, evento: ev }) + '\n');
  return true;
}

// --- Connection to one relay: paged history, then a permanent subscription ---
class Connection {
  constructor(url) {
    this.url = url;
    this.backoff = 5000;
    this.queries = new Map();   // subscription id -> { events, done }
    this.n = 0;
  }

  connect() {
    const ws = this.ws = new WebSocket(this.url);
    this.lastSeen = Date.now();
    ws.onopen = () => this.onOpen().catch(e => { log(this.url, 'error:', e.message); ws.close(); });
    ws.onmessage = m => this.onMessage(m.data);
    ws.onerror = () => {};           // the reason arrives in onclose
    ws.onclose = () => {
      clearInterval(this.watchdog);
      for (const q of this.queries.values()) q.done(null);
      this.queries.clear();
      if (this.isOpen) log(this.url, 'disconnected');
      this.isOpen = false;
      this.downSince ??= Date.now();
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 5 * 60 * 1000);
    };
    // A relay that stops answering does not always close the connection
    this.watchdog = setInterval(() => { if (Date.now() - this.lastSeen > SILENCE) ws.close(); }, 60 * 1000);
  }

  onMessage(data) {
    this.lastSeen = Date.now();
    let m;
    try { m = JSON.parse(data); } catch { return; }
    const q = this.queries.get(m[1]);
    if (m[0] === 'EVENT' && m[2]) {
      if (q) q.events.push(m[2]);
      else if (store(this.url, m[2])) log(this.url, `new event kind ${m[2].kind}`);
    } else if ((m[0] === 'EOSE' || m[0] === 'CLOSED') && q) {
      if (m[0] === 'CLOSED') log(this.url, 'CLOSED:', m[2]);
      q.done(m[0] === 'EOSE' ? q.events : null);
    } else if (m[0] === 'CLOSED') {
      log(this.url, 'live subscription CLOSED:', m[2]);
      this.ws.close();
    } else if (m[0] === 'NOTICE') {
      log(this.url, 'NOTICE:', m[1]);
    }
  }

  // A query that ends at EOSE; resolves to its events (null if interrupted)
  query(filter) {
    const id = `h${++this.n}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => q.done(null), 60 * 1000);
      const q = {
        events: [],
        done: ev => {
          clearTimeout(timer);
          if (!this.queries.delete(id)) return;
          if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(['CLOSE', id]));
          resolve(ev);
        },
      };
      this.queries.set(id, q);
      this.ws.send(JSON.stringify(['REQ', id, filter]));
    });
  }

  // Backwards with until, per filter (each one has its own limit), until a batch brings nothing new.
  // «Fewer than LIMIT» is not enough: some relays return fewer events than requested
  async history(filter, since) {
    const ids = new Set();
    let until, total = 0;
    for (;;) {
      const f = { ...filter, limit: LIMIT };
      if (since) f.since = since;
      if (until) f.until = until;
      const events = await this.query(f);
      if (!events) throw new Error('history query interrupted');
      const fresh = events.filter(e => !ids.has(e.id));
      if (!fresh.length) break;
      for (const e of fresh) {
        ids.add(e.id);
        if (store(this.url, e)) total++;
      }
      // until is inclusive: if a whole batch shares one second, step back one so as not to get stuck
      const min = Math.min(...events.map(e => e.created_at));
      until = min === until ? min - 1 : min;
    }
    return total;
  }

  async onOpen() {
    this.isOpen = true;
    const outage = this.downSince ? Math.round((Date.now() - this.downSince) / 1000) : 0;
    this.downSince = null;
    const from = lastReceived.has(this.url) ? lastReceived.get(this.url) - MARGIN : undefined;
    log(this.url, 'connected' + (from ? `, fetching since ${new Date(from * 1000).toISOString()}` : ', fetching full history'));
    // The permanent subscription goes first so nothing is missed while history is paged
    this.ws.send(JSON.stringify(['REQ', 'live', ...FILTERS.map(f => ({ ...f, since: now() - 60 }))]));
    let total = 0;
    for (const f of FILTERS) total += await this.history(f, from);
    log(this.url, `history: ${total} new events`);
    this.backoff = 5000;
    // After a long outage, the lost mostro-rates can only be recovered from Yadio (last 24 h)
    if (outage > 5 * 60) yadio('reconnection');
  }
}

// --- Yadio: BTC/USD every 5 min for the last 24 h (the same values mostro-rates publishes) ---
const YADIO_URL = 'https://api.yadio.io/today/24/USD';
let lastYadio = 0, retry = null;
async function yadio(reason) {
  if (retry || Date.now() - lastYadio < 30 * 60 * 1000) return;   // at most every half hour
  lastYadio = Date.now();
  try {
    const res = await fetch(YADIO_URL, { signal: AbortSignal.timeout(30 * 1000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('unexpected response');
    const received = now();
    appendFileSync(new URL(`yadio/${day(received)}.jsonl`, dataDir),
      JSON.stringify({ recibido: received, url: YADIO_URL, datos: data }) + '\n');
    log(`yadio (${reason}): ${data.length} prices`);
  } catch (e) {
    log(`yadio (${reason}) failed: ${e.message}; retrying in 5 min`);
    lastYadio = 0;
    retry = setTimeout(() => { retry = null; yadio(reason); }, 5 * 60 * 1000);
  }
}

log(`archiver: ${mostros.length} node(s), ${relays.length} relay(s), data in ${dataDir.pathname}`);
for (const r of relays) new Connection(r).connect();
yadio('start');
// Every 12 h: two overlapping downloads cover the 24 h even if one fails
setInterval(() => yadio('periodic'), 12 * 3600 * 1000);
