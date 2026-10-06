// Freezes what the CURRENT site computes from the fixed data in shared/test/fixtures/ and writes it
// to shared/test/expected.json. Those are the values the restructured code (shared/) must reproduce.
//
// Usage: node tools/reference.mjs [--screenshot out.png]   (Node >= 22 and Google Chrome)
//
// The real index.html runs in headless Chrome with everything external replaced:
// - config.js: shared/test/fixtures/config.json (not the local .env);
// - relays: a fake WebSocket that answers REQs from fixtures/events.json, as a relay would;
// - Coinbase and Yadio: fixtures/btcusd.json and fixtures/yadio.json;
// - clock and time zone: fixtures/meta.json (now and the visitor's time zone);
// - any other host is unreachable.
import { readFileSync, writeFileSync } from 'node:fs';
import { serve, openChrome } from './cdp.mjs';

const root = new URL('../', import.meta.url);
const fixture = n => JSON.parse(readFileSync(new URL(`shared/test/fixtures/${n}`, root), 'utf8'));
const meta = fixture('meta.json');
const FIX = { events: fixture('events.json'), btcusd: fixture('btcusd.json'), yadio: fixture('yadio.json'), now: meta.now };

// Runs in the page before any of its scripts
function simulation(FIX) {
  const NOW = FIX.now * 1000;
  const RealDate = Date;
  window.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(NOW); }
    static now() { return NOW; }
  };

  const matches = (e, f) => (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey))
    && (f.since == null || e.created_at >= f.since) && (f.until == null || e.created_at <= f.until)
    && Object.keys(f).filter(k => k[0] === '#')
      .every(k => e.tags.some(t => t[0] === k.slice(1) && f[k].includes(t[1])));
  // A relay holding every fixture event: newest first, `limit` per filter
  class FakeRelay {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      setTimeout(() => { this.readyState = 1; this.onopen?.({}); });
    }
    send(text) {
      const [type, id, ...filters] = JSON.parse(text);
      if (type !== 'REQ') return;
      const out = new Map();
      for (const f of filters) {
        let l = FIX.events.filter(e => matches(e, f)).sort((a, b) => b.created_at - a.created_at);
        if (f.limit != null) l = l.slice(0, f.limit);
        for (const e of l) out.set(e.id, e);
      }
      setTimeout(() => {
        for (const e of out.values()) this.onmessage?.({ data: JSON.stringify(['EVENT', id, e]) });
        this.onmessage?.({ data: JSON.stringify(['EOSE', id]) });
      });
    }
    close() { this.readyState = 3; }
  }
  window.WebSocket = FakeRelay;

  const realFetch = window.fetch;
  const json = d => new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, ...rest) => {
    const u = new URL(String(url), location.href);
    if (u.hostname === 'api.yadio.io') return json(FIX.yadio);
    if (u.hostname === 'api.exchange.coinbase.com') {
      const from = new RealDate(u.searchParams.get('start')) / 1000;
      const to = new RealDate(u.searchParams.get('end')) / 1000;
      // Like Coinbase: [time, low, high, open, close, volume], newest first
      return json(Object.entries(FIX.btcusd).map(([t, c]) => [Number(t), c, c, c, c, 0])
        .filter(v => v[0] >= from && v[0] <= to).sort((a, b) => b[0] - a[0]));
    }
    if (u.origin !== location.origin) throw new TypeError(`unreachable in tests: ${u}`);
    return realFetch(url, ...rest);
  };
}

// Runs in the page once it has loaded the fixtures: reads what the site computed
async function extract() {
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      await rendering;
      await new Promise(r => setTimeout(r, 20));
      if (!renderQueued) { await rendering; return; }
    }
  };
  await settle();
  const now = Date.now() / 1000;
  const text = id => document.getElementById(id)?.textContent.trim() ?? null;
  const r = {};

  // The default view, as a visitor sees it
  r.view = { fiat: state.fiat, unit: state.unit, mode: state.mode, timeframe: state.tf,
    activePaymentMethods: [...state.pmSel].sort() };
  r.header = Object.fromEntries(['sTasa', 'sTasaSub', 'sChg', 'sYadio', 'sYadioSub', 'sVol', 'sVolSub', 'sLast', 'sLastSub']
    .map(id => [id, text(id)]));

  // Chosen version of every order and how its payment methods were classified
  r.orders = [...state.orders.values()].sort((a, b) => a.key < b.key ? -1 : 1).map(o => ({
    key: o.key, id: o.ev.id, ts: o.ts, status: o.status, side: o.side, fiat: o.fiat, fa: o.fa, amt: o.amt,
    premium: o.premium, expiresAt: o.expiresAt, pm: o.pm, pmKeys: o.pmKeys, origin: o.origin ?? null,
  }));

  // Per currency with completed orders, its default payment methods, and per unit everything derived
  const saved = { fiat: state.fiat, unit: state.unit, mode: state.mode, tf: state.tf, pmSel: state.pmSel, pmKnown: state.pmKnown };
  const fiats = [...new Set(r.orders.filter(o => o.status === 'success').map(o => o.fiat))].sort();
  r.currencies = {};
  for (const fiat of fiats) {
    state.fiat = fiat; state.pmSel = null; state.pmKnown = null;
    renderFilters();
    const c = r.currencies[fiat] = { activePaymentMethods: [...state.pmSel].sort(), units: {} };
    for (const unit of ['usd', 'btc', 'sat']) {
      state.unit = unit;
      const trades = getTrades();
      const inWindow = trades.filter(t => t.ts > now - WIN);
      const before = trades.filter(t => t.ts > now - 2 * WIN && t.ts <= now - WIN);
      const u = c.units[unit] = {
        approximateUsd: state.btcApprox,
        rate: weightedPrice(inWindow),
        previousRate: weightedPrice(before),
        orders24h: inWindow.length,
        volume24h: inWindow.reduce((a, t) => a + t.size, 0),
        trades: trades.map(t => ({ key: t.key, ts: t.ts, size: t.size, price: t.price, chartTime: toChartTime(t.ts) })),
        candles: {},
      };
      for (const tf of [3600, 14400, 86400, 604800, 2592000, 31536000]) {
        const candles = buildCandles(trades, tf).sort((a, b) => a.time - b.time);
        u.candles[tf] = { candles, emptyPeriods: emptyPeriods(candles.map(k => k.time), tf) };
      }
      const book = getBook();
      const row = o => ({ key: o.key, price: o.price, size: o.size, fixed: o.fixed });
      u.book = { asks: book.asks.map(row), bids: book.bids.map(row) };
      // Chart points in Weighted mode (it adds the empty periods): value, volume and the moving
      // 24 h weighted average of each point
      u.points = {};
      for (const tf of [0, 3600, 14400, 86400, 604800, 2592000, 31536000]) {
        state.mode = 'avg'; state.tf = tf;
        renderChart(trades);
        u.points[tf] = [...view.info.values()].map(p => ({ time: p.time, value: p.value ?? null, vol: p.vol, n: p.n,
          avg: p.avg ?? null, avgN: p.avgN ?? null, avgVol: p.avgVol ?? null, empty: !!p.empty, key: p.order?.key ?? null }));
      }
    }
  }
  Object.assign(state, saved);
  renderFilters();
  renderChart(getTrades());

  // Small cases straight on the functions
  const pm = [['Cash', 'USD'], ['Cash App', 'USD'], ['360 CUP de saldo móvil 📲', 'CUP'], ['Saldo móvil', 'CUP'],
    ['Clásica', 'CUP'], ['prueba, no tomar', 'CUP'], ['TEST', 'USD'], ['Transfermovil', 'CUP'], ['EnZona', 'CUP'],
    ['Transferencia CUP 🇨🇺', 'CUP'], ['Efectivo', 'CUP'], ['Zelle', 'CUP'], ['Zelle', 'USD'], ['+53 5555 5555', 'CUP'],
    ['MiTransfer', 'CUP'], ['Bank Transfer', 'XYZ']];
  const statuses = ['pending', 'in-progress', 'success', 'canceled', 'expired'];
  const versions = [];
  for (const a of statuses) for (const b of statuses) for (const [ta, tb] of [[1, 1], [2, 1], [1, 2]]) {
    for (const [ia, ib] of [['a', 'b'], ['b', 'a']]) {
      versions.push({ a: [ta, a, ia], b: [tb, b, ib],
        wins: newerVersion({ ts: ta, status: a, ev: { id: ia } }, { ts: tb, status: b, ev: { id: ib } }) });
    }
  }
  // Monday 5/1/1970 week anchor, month and year ends, leap day, and the configured zone's DST changes
  // (times already in local chart time, as periodStart receives them)
  const times = [0, 4 * 86400 - 1, 4 * 86400, 1790553599, 1790553600, 1790812799, 1790812800,
    1767225599, 1767225600, 1835438400, now];
  const periods = [];
  for (const time of times) for (const tf of [3600, 14400, 86400, 604800, 2592000, 31536000]) {
    const start = periodStart(time, tf);
    periods.push({ time, tf, start, next: nextPeriod(start, tf) });
  }
  // Every half hour around the 2026 DST changes of America/Havana (8/3 and 1/11, 05:00 UTC).
  // KNOWN BUG, frozen as is: tzOffset parses date text in the browser's zone, so within ~5 h of a DST
  // change of that zone it is off by one hour. The restructured code must return the correct
  // offsets here (Intl formatToParts, see cases.json), not these
  const offsets = [1772946000, 1793509200].flatMap(c => Array.from({ length: 9 }, (_, i) => c + (i - 4) * 1800))
    .concat(now).map(ts => ({ ts, offset: tzOffset(ts) }));
  r.cases = {
    pmKey: pm.map(([text, fiat]) => ({ text, fiat, method: pmKey(text, fiat) })),
    // The FAQ example: 3 orders at 785 that add up to 3000 and one at 750 of 5000
    faqExample: weightedPrice([{ price: 785, size: 1000 }, { price: 785, size: 1000 }, { price: 785, size: 1000 },
      { price: 750, size: 5000 }]),
    versions, periods,
    buggyOffsets: offsets,
  };
  return r;
}

const server = await serve(new URL('.', root).pathname.replace(/\/$/, ''), {
  '/config.js': `window.TASAK_CONFIG = ${JSON.stringify(fixture('config.json'))};\n`,
});
// Nothing leaves the machine: every host but the local server is unreachable
const chrome = await openChrome(['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']);
try {
  const p = await chrome.newPage();
  await p.cmd('Emulation.setTimezoneOverride', { timezoneId: meta.browserTimeZone });
  await p.cmd('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await p.cmd('Page.addScriptToEvaluateOnNewDocument', { source: `(${simulation})(${JSON.stringify(FIX)});` });
  await p.goto(`${server.url}/index.html?lang=es`);
  await p.waitFor('state.live === CONFIG.relays.length');
  const r = await p.evaluate(`(${extract})()`);

  const out = process.argv.indexOf('--screenshot');
  if (out > 0) writeFileSync(process.argv[out + 1], await p.screenshot());
  // Images of the node's profile are external: failing to load them is expected here
  const errors = p.errors.filter(e => !/ERR_NAME_NOT_RESOLVED|Failed to load resource/.test(e));
  if (errors.length) throw new Error('errors in the page:\n  ' + errors.join('\n  '));

  const expected = {
    description: 'Values computed by the site before restructuring (tools/reference.mjs) from shared/test/fixtures/',
    now: meta.now, browserTimeZone: meta.browserTimeZone, ...r,
  };
  writeFileSync(new URL('shared/test/expected.json', root), JSON.stringify(expected, null, 1) + '\n');
  const units = r.currencies[r.view.fiat]?.units;
  console.log(`view ${r.view.fiat}/${r.view.unit}: header «${r.header.sTasa}» (${r.header.sTasaSub})`);
  for (const [unit, u] of Object.entries(units || {})) {
    console.log(`  ${unit}: rate ${u.rate} from ${u.orders24h} orders in 24 h, ${u.trades.length} trades in total`);
  }
  console.log(`${r.orders.length} orders, currencies ${Object.keys(r.currencies).join(', ')} -> shared/test/expected.json`);
} finally {
  chrome.close();
  server.close();
}
