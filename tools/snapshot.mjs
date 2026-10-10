// Checks the site with its server: web/index.html in headless Chrome with a snapshot (api/snapshot.json)
// built from the fixed data of shared/test/fixtures/, relays that have nothing and a Tasa K signed with
// a test key. The snapshot alone must draw what expected.json says; its events are verified as those of
// the relays; the signed rate shows only if the key of config.js signed it, with a warning if it doesn't
// match this browser's; the unsigned orders are marked.
//
// Usage: node tools/snapshot.mjs   (Node >= 22; Chrome, or CHROME=path)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { serve, openChrome } from './cdp.mjs';
import { simulation } from './simulation.mjs';

const root = new URL('../', import.meta.url);
const fixture = n => JSON.parse(readFileSync(new URL(`shared/test/fixtures/${n}`, root), 'utf8'));
const expected = JSON.parse(readFileSync(new URL('shared/test/expected.json', root), 'utf8'));
const config = fixture('config.json');
const events = fixture('events.json');
const NOW = expected.now;

// nostr-tools from web/vendor/, to sign the test rates (in this context: in another one its checks fail)
runInThisContext(readFileSync(new URL('web/vendor/nostr-tools-2.25.2.bundle.min.js', root), 'utf8')
  + ';globalThis.NostrTools = NostrTools;');
const { generateSecretKey, getPublicKey, finalizeEvent } = globalThis.NostrTools;
const key = generateSecretKey(), other = generateSecretKey();
const ratePubkey = getPublicKey(key);

// A Tasa K event as tasak publishes it (only the fields the site reads)
const cup = expected.currencies.CUP.units;
const round = x => Number(x.toFixed(2));
// Its window ends at the last order, as the site's (expected.json's rateTo)
function rateEvent({ usd = round(cup.usd.rate), emptySince = null, to = cup.usd.rateTo, sk = key } = {}) {
  const tasak = {
    rules: 1, decimals: 2, fiat: 'CUP', from: to - 86400, to, empty_since: emptySince,
    rate: { btc: round(cup.btc.rate), usd }, previous: { btc: round(cup.btc.previousRate), usd: round(cup.usd.previousRate) },
    volume: cup.usd.volume24h, count: cup.usd.orders24h,
  };
  return finalizeEvent({
    kind: 30078, created_at: NOW, content: JSON.stringify({ BTC: { CUP: tasak.rate.btc }, tasak }),
    tags: [['d', 'tasak'], ['f', 'CUP'], ['expiration', String(NOW + 600)]],
  }, sk);
}

// The snapshot: every event of the fixtures (as the relays had them), and what each case adds
const snapshot = extra => ({ version: 1, generated: NOW - 120, events, nodeOrders: [], btcUsd: {}, rate: null, ...extra });
const FIX = { events: [], btcusd: fixture('btcusd.json'), yadio: fixture('yadio.json'), now: NOW };

const server = await serve(fileURLToPath(new URL('web', root)),
  { '/config.js': `window.TASAK_CONFIG = ${JSON.stringify({ ...config, ratePubkey })};\n` },
  { '/shared/': fileURLToPath(new URL('shared', root)) });
const chrome = await openChrome(['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']);
let failed = 0;
// Every host but the local server is unreachable on purpose: those load errors (the node's picture) are
// expected, and the page hides what doesn't load
const pageErrors = p => p.errors.filter(e => !e.includes('net::ERR_NAME_NOT_RESOLVED'));
const check = (ok, what, got) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ` (got ${JSON.stringify(got)})`}`);
  if (!ok) failed++;
};

const READY = 'window.tasak && tasak.state.snapshotAt > 0 && tasak.state.orders.size > 0 && document.getElementById("sTasa").textContent !== "—"';
async function page(snap, now = NOW, relayEvents = [], { query = '', ready = READY } = {}) {
  const p = await chrome.newPage();
  await p.cmd('Emulation.setTimezoneOverride', { timezoneId: expected.browserTimeZone });
  await p.cmd('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });
  await p.cmd('Page.addScriptToEvaluateOnNewDocument', { source: `(${simulation})(${JSON.stringify({ ...FIX, events: relayEvents, now, snapshot: snap })});` });
  await p.goto(`${server.url}/index.html?lang=es${query}`);
  await p.waitFor(ready);
  await p.evaluate('tasak.rendering');
  await new Promise(r => setTimeout(r, 300));
  await p.evaluate('tasak.rendering');
  return p;
}
const header = p => p.evaluate(`({ tasa: document.getElementById('sTasa').textContent, sub: document.getElementById('sTasaSub').innerText,
  status: document.getElementById('status').innerText, warn: !!document.querySelector('#sTasaSub .warn'),
  // The header must fit in one line at 1500 px
  oneLine: (() => { const t = [...document.querySelector('header').children].map(e => e.getBoundingClientRect().top); return Math.max(...t) - Math.min(...t) < 30; })() })`);

try {
  // 1. The snapshot alone (relays with nothing): the same header as expected.json
  let p = await page(snapshot());
  let h = await header(p);
  check(h.tasa === expected.header.sTasa && h.sub === expected.header.sTasaSub, 'the snapshot alone draws the expected header', h);
  check(/· \d+ min/.test(h.status), 'the status says how old the server data is', h.status);
  // The FAQ shows the key of config.js that signs the site's rate, as npub
  const faqKey = await p.evaluate(`({ npub: document.querySelector('.rate-npub').title, short: document.querySelector('.rate-npub').textContent,
    inspect: document.querySelector('.rate-inspect').href,
    on: !document.querySelector('.rate-key-on').hidden, off: !document.querySelector('.rate-key-off').hidden })`);
  const npub = globalThis.NostrTools.nip19.npubEncode(ratePubkey);
  const addr = globalThis.NostrTools.nip19.decode(faqKey.inspect.split('/a/')[1]).data;
  check(faqKey.npub === npub && faqKey.short === `${npub.slice(0, 12)}…${npub.slice(-6)}` && faqKey.on && !faqKey.off,
    'the FAQ shows the site\'s signing npub, shortened', faqKey);
  check(addr.pubkey === ratePubkey && addr.kind === 30078 && addr.identifier === 'tasak', 'and links its newest rate on Nostr Inspect', addr);
  check(pageErrors(p).length === 0, 'no console errors', pageErrors(p));
  p.close();

  // 1b. The Content Security Policy of the page is in force: an injected inline script doesn't run
  p = await page(snapshot());
  const blocked = await p.evaluate(`new Promise(ok => {
    document.addEventListener('securitypolicyviolation', e => ok(e.violatedDirective), { once: true });
    const s = document.createElement('script'); s.textContent = 'window.injected = 1'; document.body.append(s);
    setTimeout(() => ok(window.injected ? 'ran' : 'no event'), 500);
  })`);
  check(/^script-src/.test(blocked), 'the Content Security Policy blocks an injected inline script', blocked);
  p.close();

  // 2. The signed rate, matching this browser's: shown, no warning
  p = await page(snapshot({ rate: rateEvent() }));
  h = await header(p);
  check(h.tasa === expected.header.sTasa && !h.warn, 'a signed rate that matches: shown without warning', h);
  check(await p.evaluate('tasak.state.signedRate?.fiat === "CUP"'), 'the signed rate is accepted', null);
  p.close();

  // 3. Signed by the right key but with another value: shown, with the warning
  p = await page(snapshot({ rate: rateEvent({ usd: 1100 }) }));
  h = await header(p);
  check(h.tasa.startsWith('1100') && h.warn, 'a signed rate that doesn\'t match: shown with a warning', h);
  p.close();

  // 4. Tampered after signing, or signed by another key: ignored, this browser's rate
  const tampered = rateEvent();
  tampered.content = tampered.content.replace(`"usd":${round(cup.usd.rate)}`, '"usd":2000');
  check(tampered.content.includes('"usd":2000'), 'the test really tampers with the rate', null);
  for (const [name, ev] of [['tampered', tampered], ['another key', rateEvent({ sk: other })]]) {
    p = await page(snapshot({ rate: ev }));
    h = await header(p);
    check(h.tasa === expected.header.sTasa && !h.warn && await p.evaluate('tasak.state.signedRate === null'), `a rate ${name}: ignored`, h);
    p.close();
  }

  // 5. Without orders in the last 24 h: the last rate, saying how old it is
  p = await page(snapshot({ rate: rateEvent({ to: NOW - 2 * 86400, emptySince: NOW - 86400 }) }));
  h = await header(p);
  check(h.sub.startsWith('sin órdenes 24h · de hace 2 días') && h.oneLine, 'an empty window says how old the rate is, in one line', h);
  p.close();

  // 6. An event with a bad signature in the snapshot: rejected and counted; an unsigned order: marked;
  //    the server's BTC/USD of an order: used
  const forged = { ...events.find(e => e.kind === 38383), content: 'x' };
  const nodeOrder = {
    key: `${config.mostros[0]}:unsigned-1`, node: config.mostros[0], id: 'ev-from-db', ts: NOW - 3 * 86400, takenAt: NOW - 3 * 86400 - 60,
    side: 'buy', fiat: 'CUP', fa: 1000, amt: 1200, premium: 5, origin: { fixed: false, premium: 5 }, pm: ['EnZona'], pmKeys: ['EnZona'],
  };
  const trade = await (async () => {
    const q = await page(snapshot());
    const t0 = await q.evaluate('tasak.getTrades().at(-1)').then(o => ({ key: o.key, fa: o.fa[0], amt: o.amt }));
    q.close();
    return t0;
  })();
  p = await page(snapshot({ events: [forged, ...events], nodeOrders: [nodeOrder], btcUsd: { [trade.key]: { usd: 50000, source: 'node', at: NOW } } }));
  check(await p.evaluate('tasak.state.snapshotRejected') === 1, 'a forged event of the snapshot is rejected', null);
  const marked = await p.evaluate(`[...document.querySelectorAll('#trades tr')].some(tr => tr.dataset.key === ${JSON.stringify(nodeOrder.key)} && tr.querySelector('.unsigned'))`);
  check(marked, 'the unsigned order is in the table, marked', null);
  await p.evaluate(`document.querySelector('#trades tr[data-key="${nodeOrder.key}"]').click()`);
  const dlg = await p.evaluate(`document.getElementById('evMeta').innerText`);
  check(/sin firma/.test(dlg), 'its dialog says it is unsigned', dlg);
  const price = await p.evaluate(`tasak.getTrades().find(o => o.key === ${JSON.stringify(trade.key)}).price`);
  check(Math.abs(price - trade.fa / (trade.amt / 1e8) / 50000) < 1e-9, 'an order\'s BTC/USD from the server is used', price);
  check(pageErrors(p).length === 0, 'no console errors', pageErrors(p));
  p.close();

  // 7. An unsigned order inside the last 24 h: it counts, and nothing breaks (it has no event)
  const recent = { ...nodeOrder, key: `${config.mostros[0]}:unsigned-2`, id: 'ev-recent', ts: NOW - 3600, takenAt: NOW - 3700 };
  p = await page(snapshot({ nodeOrders: [recent] }));
  h = await header(p);
  // It is now the last order: the window ends at it and it is in it
  const k = await p.evaluate(`import('/shared/rate.js').then(m => { const k = m.lastTasaK(tasak.getTrades(), Date.now() / 1000); return { to: k.to, count: k.count, ids: k.ids }; })`);
  check(k.to === recent.ts && k.ids.includes(recent.id) && h.sub.startsWith(`${k.count} órdenes`), 'an unsigned order of the last 24 h counts in the rate', { h, k });
  check(await p.evaluate(`tasak.getTrades().some(o => o.key === ${JSON.stringify(recent.key)})`), 'it is a trade like the others', null);
  check(pageErrors(p).length === 0, 'no console errors', pageErrors(p));
  p.close();

  // 9. Relays with every event and a complete snapshot: the same header, no warning, and the relays are
  //    asked only for the last 7 days
  p = await page(snapshot(), NOW, events);
  await p.waitFor('tasak.state.live > 0');
  await p.evaluate('tasak.scheduleRender(), tasak.rendering');
  await new Promise(r => setTimeout(r, 300));
  h = await header(p);
  check(h.tasa === expected.header.sTasa && !/faltan/.test(h.status), 'relays and a complete snapshot: no warning', h);
  const since = await p.evaluate('Math.min(...tasak.state.relaysFrom ? window.tasakRequests.filter(f => f.kinds?.includes(38383)).map(f => f.since ?? 0) : [0])');
  check(since >= NOW - 7 * 86400 - 3600 && since <= NOW - 7 * 86400 + 60, 'the relays are asked for the last 7 days only', since);
  p.close();

  // 10. A snapshot that misses a completed order of those days: the warning
  const isSuccess = e => e.kind === 38383 && e.tags.some(t => t[0] === 's' && t[1] === 'success');
  const dOf = e => e.tags.find(t => t[0] === 'd')[1];
  const missingOne = events.find(e => isSuccess(e) && e.created_at > NOW - 6 * 86400 && e.created_at < NOW - 3600);
  p = await page(snapshot({ events: events.filter(e => e.kind !== 38383 || dOf(e) !== dOf(missingOne)) }), NOW, events);
  await p.waitFor('tasak.state.live > 0');
  await p.evaluate('tasak.scheduleRender(), tasak.rendering');
  await new Promise(r => setTimeout(r, 300));
  h = await header(p);
  check(/faltan 1/.test(h.status), 'a snapshot missing a completed order of the last days: warned', h.status);
  p.close();

  // 8. No signed rate and no orders in the last 24 h: the last rate there was, saying how old it is
  p = await page(snapshot(), NOW + 3 * 86400);
  h = await header(p);
  check(h.tasa !== '—' && h.sub.startsWith('sin órdenes 24h · de hace 3 días') && h.oneLine, 'without a signed rate, an empty window keeps the last rate', h);
  p.close();

  // 11. The URL changes the node: the snapshot is about the .env node, so it isn't loaded (none of its
  //     orders, signed or not) and the relays are asked for their whole history
  const otherNode = getPublicKey(generateSecretKey());
  p = await page(snapshot({ nodeOrders: [nodeOrder] }), NOW, events, {
    query: `&mostro=${otherNode}`,
    ready: 'window.tasak && window.tasakRequests?.some(f => f.kinds?.includes(38383))',
  });
  await new Promise(r => setTimeout(r, 500));
  await p.evaluate('tasak.rendering');
  const urlNode = await p.evaluate(`({ at: tasak.state.snapshotAt, orders: tasak.state.orders.size,
    // The history pages (with limit), not the live subscription, which starts now
    since: window.tasakRequests.filter(f => f.kinds?.includes(38383) && f.limit).map(f => f.since ?? null) })`);
  check(urlNode.at === 0 && urlNode.orders === 0, 'another node in the URL: the snapshot isn\'t loaded', urlNode);
  check(urlNode.since.length > 0 && urlNode.since.every(s => s === null), 'another node in the URL: the relays are asked for their whole history', urlNode.since);
  // The node selector: the site's node (back to the site) and the node of the URL (the current one)
  const rows = await p.evaluate(`[...document.querySelectorAll('#nodes .node-row')].map(r => ({ href: r.getAttribute('href'), on: r.classList.contains('on') }))`);
  check(rows.length === 2 && !rows[0].on && !/mostro=/.test(rows[0].href) && rows[1].on && rows[1].href.includes(otherNode),
    'another node in the URL: the selector has the site\'s node and the current one', rows);
  // Its Tasa K counts every method but the test orders: the .env's hidden ones are the site's rules
  check(JSON.stringify(await p.evaluate('CONFIG.hiddenPaymentMethods')) === '["Pruebas"]', 'another node in the URL: only the test orders are hidden', null);
  check(pageErrors(p).length === 0, 'no console errors', pageErrors(p));
  p.close();

  // 12. An unsigned order of another node in the snapshot: not added
  const foreign = { ...nodeOrder, key: `${otherNode}:unsigned-3`, node: otherNode, id: 'ev-foreign' };
  p = await page(snapshot({ nodeOrders: [nodeOrder, foreign] }));
  const keys = await p.evaluate(`[${JSON.stringify(nodeOrder.key)}, ${JSON.stringify(foreign.key)}].map(k => tasak.state.orders.has(k))`);
  check(keys[0] && !keys[1], 'the snapshot adds only the unsigned orders of the page\'s nodes', keys);
  p.close();

  // 13. The node selector with the site's node: its row is the node filter, marked, and an invalid npub
  //     is refused without leaving the page
  p = await page(snapshot());
  const site = await p.evaluate(`[...document.querySelectorAll('#nodes .node-row')].map(r => ({ node: r.dataset.node, on: r.classList.contains('on') }))`);
  check(site.length === 1 && site[0].node === config.mostros[0] && site[0].on, 'the selector: the site\'s node, selected', site);
  const bad = await p.evaluate(`(() => { const i = document.getElementById('nodeInput'); i.value = 'npub1nope';
    document.getElementById('nodeForm').requestSubmit(); return i.classList.contains('bad') && location.search === '?lang=es'; })()`);
  check(bad, 'the selector refuses an invalid npub', null);
  check(pageErrors(p).length === 0, 'no console errors', pageErrors(p));
  p.close();
} finally {
  chrome.close();
  server.close();
}
console.log(failed ? `${failed} checks failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
