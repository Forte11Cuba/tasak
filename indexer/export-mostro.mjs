// Exports the completed orders of a Mostro node from a copy of its SQLite database, to recover the
// history that relays have already deleted (they keep order events for ~15-30 days).
//
// Usage: node indexer/export-mostro.mjs <copy of mostro.db> [node pubkey, hex or npub]
//   (Node >= 22.13: node:sqlite; no dependencies)
//
// Run it on a COPY, never on the database the node is using. A consistent copy while the node runs:
//   sqlite3 mostro.db ".backup mostro-copy.db"
// The pubkey defaults to the first one in MOSTRO_PUBKEYS (.env).
//
// Writes ARCHIVE_DIR/mostro-db/<pubkey>-YYYY-MM-DD.jsonl (default indexer/data/), one line per order:
//   {"nodo", "exportado", "orden": {...}}
// Only public trade data: the same values the node publishes in its 38383 events, plus taken_at,
// invoice_held_at and price_from_api, which are not published. Keys, invoices, preimages, Cashu
// tokens and the users table are never read.
//
// What the database does and does not have (Mostro v0.19):
// - One row per order, overwritten in place: no history, no signatures, no stored BTC price.
// - fiat_amount and amount of a completed order are exactly the fa and amt of its success event,
//   and event_id is the id of that event: matching it against a Nostr event confirms the order.
// - price_from_api = 1: market price (sats computed at take time); 0: fixed sats.
// - There is no completion time. taken_at lies between the take request and the escrow lock
//   (invoice_held_at); both are 0 if a take was undone.
// - Range orders: each completed slice is its own row (range_parent_id = the parent order).
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runInThisContext } from 'node:vm';

const root = new URL('../', import.meta.url);
const [file, keyArg] = process.argv.slice(2);
if (!file || !existsSync(file)) {
  console.error('Usage: node indexer/export-mostro.mjs <copy of mostro.db> [node pubkey]');
  process.exit(1);
}

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

// nostr-tools from web/vendor/, only to read an npub. It must run in this context: in a separate vm
// context its Uint8Array checks fail
runInThisContext(readFileSync(new URL('web/vendor/nostr-tools-2.25.2.bundle.min.js', root), 'utf8')
  + ';globalThis.NostrTools = NostrTools;');
const key = keyArg || (get('MOSTRO_PUBKEYS') || '').split(/[\s,]+/).filter(Boolean)[0] || '';
let node = /^[0-9a-f]{64}$/i.test(key) ? key.toLowerCase() : null;
if (!node) {
  try { const d = NostrTools.nip19.decode(key); if (d.type === 'npub') node = d.data; } catch {}
}
if (!node) {
  console.error(`invalid or missing node pubkey: «${key}» (pass it as 2nd argument or set MOSTRO_PUBKEYS)`);
  process.exit(1);
}

// Statuses of an executed trade. settled-hold-invoice: fiat paid and sats released, buyer payout
// still pending. settled-by-admin / completed-by-admin: only in databases of older versions
const EXECUTED = ['success', 'settled-hold-invoice', 'completed-by-admin', 'settled-by-admin'];

// Only these columns are read; a database from an older version may lack some (they come as null)
const COLUMNS = ['id', 'kind', 'status', 'event_id', 'fiat_code', 'fiat_amount', 'amount', 'premium',
  'price_from_api', 'payment_method', 'min_amount', 'max_amount', 'range_parent_id',
  'created_at', 'taken_at', 'invoice_held_at', 'expires_at'];

let db, existing;
try {
  db = new DatabaseSync(file, { readOnly: true });
  existing = new Set(db.prepare('PRAGMA table_info(orders)').all().map(c => c.name));
} catch (e) {
  console.error(`cannot read ${file}: ${e.message}`);
  process.exit(1);
}
if (!existing.size) {
  console.error(`${file} has no orders table: is it a Mostro database?`);
  process.exit(1);
}
const select = COLUMNS.map(c => existing.has(c) ? `o.${c}` : `NULL AS ${c}`).join(', ');
const hasDisputes = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'disputes'").get();
const rows = db.prepare(`
  SELECT ${select}${hasDisputes ? ', d.status AS dispute_status' : ', NULL AS dispute_status'}
  FROM orders o ${hasDisputes ? 'LEFT JOIN disputes d ON d.order_id = o.id' : ''}
  WHERE o.status IN (${EXECUTED.map(() => '?').join(', ')})
  ORDER BY o.created_at, o.id`).all(...EXECUTED);
db.close();

const exportedAt = Math.floor(Date.now() / 1000);
const lines = [];
const summary = new Map();      // fiat -> { n, noAmount }
let from = Infinity, to = 0;
for (const f of rows) {
  const order = { ...f };
  // 0 means «not set» in these columns
  for (const c of ['taken_at', 'invoice_held_at']) if (!order[c]) order[c] = null;
  for (const c of ['min_amount', 'max_amount']) if (!order[c]) order[c] = null;
  order.price_from_api = order.price_from_api == null ? null : !!order.price_from_api;
  lines.push(JSON.stringify({ nodo: node, exportado: exportedAt, orden: order }));

  const r = summary.get(f.fiat_code) ?? { n: 0, noAmount: 0 };
  r.n++;
  if (!(f.amount > 0 && f.fiat_amount > 0)) r.noAmount++;
  summary.set(f.fiat_code, r);
  from = Math.min(from, f.created_at);
  to = Math.max(to, f.created_at);
}

const dataDir = get('ARCHIVE_DIR') ? new URL(get('ARCHIVE_DIR').replace(/\/?$/, '/'), `file://${process.cwd()}/`)
  : new URL('indexer/data/', root);
const dir = new URL('mostro-db/', dataDir);
mkdirSync(dir, { recursive: true });
const outFile = new URL(`${node}-${new Date(exportedAt * 1000).toISOString().slice(0, 10)}.jsonl`, dir);
writeFileSync(outFile, lines.length ? lines.join('\n') + '\n' : '');

const date = s => new Date(s * 1000).toISOString().slice(0, 10);
console.log(`${rows.length} executed orders${rows.length ? ` created ${date(from)} … ${date(to)}` : ''} -> ${outFile.pathname}`);
for (const [fiat, r] of [...summary].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${fiat}: ${r.n}${r.noAmount ? ` (${r.noAmount} without amount or sats: no price)` : ''}`);
}
const missing = COLUMNS.filter(c => !existing.has(c));
if (missing.length) console.log(`  columns missing in this database (exported as null): ${missing.join(', ')}`);
