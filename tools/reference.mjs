// Runs web/index.html in headless Chrome on the fixed data in shared/test/fixtures/ and checks that
// it computes exactly the values in shared/test/expected.json (frozen from the site before it was
// restructured). With --write it rewrites expected.json instead: only to change it on purpose.
//
// Usage: node tools/reference.mjs [--write] [--screenshot out.png]   (Node >= 22 and Google Chrome)
//
// Everything external is replaced:
// - config.js: shared/test/fixtures/config.json (not the local .env), and shared/ served from the
//   repository (no build needed);
// - relays: a fake WebSocket that answers REQs from fixtures/events.json, as a relay would;
// - Coinbase and Yadio: fixtures/btcusd.json and fixtures/yadio.json;
// - clock and time zone: fixtures/meta.json (now and the visitor's time zone);
// - any other host is unreachable.
//
// Then it loads the page again with the browser in another time zone (OTHER_ZONE): dates and candles
// follow the visitor's zone, so the times shown and the chart's periods change, and must be those of
// shared/ for that zone; the Tasa K, the prices and the orders must not change.
//
// cases.buggyOffsets is not checked: it froze a bug of the old tzOffset that is fixed now (the
// correct values are in cases.json); --write keeps it as it was.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve, openChrome } from './cdp.mjs';
import { simulation } from './simulation.mjs';
import { chartPoints } from '../shared/rate.js';
import { TIMEFRAMES } from '../shared/time.js';

const root = new URL('../', import.meta.url);
const fixture = n => JSON.parse(readFileSync(new URL(`shared/test/fixtures/${n}`, root), 'utf8'));
const meta = fixture('meta.json');
const FIX = { events: fixture('events.json'), btcusd: fixture('btcusd.json'), yadio: fixture('yadio.json'), now: meta.now };
const expectedFile = new URL('shared/test/expected.json', root);
const write = process.argv.includes('--write');
// +14 h from Havana: the day changes
const OTHER_ZONE = 'Asia/Tokyo';


// Runs in the page once it has loaded the fixtures: reads what the site computed. The page's
// state comes from window.tasak; what the old site computed inline comes from the same shared/
// modules the page uses
async function extract() {
  const T = window.tasak;
  const load = p => import(new URL(p, location.href).href);
  const [rate, time, pms, orders] = await Promise.all(
    ['shared/rate.js', 'shared/time.js', 'shared/payment-methods.js', 'shared/orders.js'].map(load));
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      await T.rendering;
      await new Promise(r => setTimeout(r, 20));
      if (!T.renderQueued) { await T.rendering; return; }
    }
  };
  await settle();
  const state = T.state;
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
    T.renderFilters();
    const c = r.currencies[fiat] = { activePaymentMethods: [...state.pmSel].sort(), units: {} };
    for (const unit of ['usd', 'btc', 'sat']) {
      state.unit = unit;
      const trades = T.getTrades();
      const approximateUsd = state.btcApprox;
      // The Tasa K shown: that of the 24 h that end at the last completed order
      const k = rate.lastTasaK(trades, now);
      const u = c.units[unit] = {
        approximateUsd,
        rateTo: k.to,
        rate: k.rate,
        previousRate: k.previous,
        orders24h: k.count,
        volume24h: k.volume,
        trades: trades.map(t => ({ key: t.key, ts: t.ts, size: t.size, price: t.price, chartTime: time.toChartTime(t.ts, CONFIG.tz) })),
        candles: {},
      };
      for (const tf of time.TIMEFRAMES) {
        const candles = rate.buildCandles(trades, tf, CONFIG.tz).sort((a, b) => a.time - b.time);
        u.candles[tf] = { candles, emptyPeriods: time.emptyPeriods(candles.map(k => k.time), tf) };
      }
      const book = T.getBook();
      const row = o => ({ key: o.key, price: o.price, size: o.size, fixed: o.fixed });
      u.book = { asks: book.asks.map(row), bids: book.bids.map(row) };
      // Chart points in Weighted mode (it adds the empty periods): value, volume and the moving
      // 24 h weighted average of each point
      u.points = {};
      for (const tf of [0, ...time.TIMEFRAMES]) {
        state.mode = 'avg'; state.tf = tf;
        T.renderChart(trades);
        u.points[tf] = [...T.view.info.values()].map(p => ({ time: p.time, value: p.value ?? null, vol: p.vol, n: p.n,
          avg: p.avg ?? null, avgN: p.avgN ?? null, avgVol: p.avgVol ?? null, empty: !!p.empty, key: p.order?.key ?? null }));
      }
    }
  }
  Object.assign(state, saved);
  T.renderFilters();
  T.renderChart(T.getTrades());

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
        wins: orders.newerVersion({ ts: ta, status: a, ev: { id: ia } }, { ts: tb, status: b, ev: { id: ib } }) });
    }
  }
  // Monday 5/1/1970 week anchor, month and year ends, leap day, and the configured zone's DST changes
  // (times already in local chart time, as periodStart receives them)
  const times = [0, 4 * 86400 - 1, 4 * 86400, 1790553599, 1790553600, 1790812799, 1790812800,
    1767225599, 1767225600, 1835438400, now];
  const periods = [];
  for (const t of times) for (const tf of time.TIMEFRAMES) {
    const start = time.periodStart(t, tf);
    periods.push({ time: t, tf, start, next: time.nextPeriod(start, tf) });
  }
  r.cases = {
    pmKey: pm.map(([text, fiat]) => ({ text, fiat, method: pms.pmKey(text, pms.pmListFor(window.MOSTRO_PAYMENT_METHODS, fiat)) })),
    // The FAQ example: 3 orders at 785 that add up to 3000 and one at 750 of 5000
    faqExample: rate.weightedPrice([{ price: 785, size: 1000 }, { price: 785, size: 1000 }, { price: 785, size: 1000 },
      { price: 750, size: 5000 }]),
    versions, periods,
  };
  return r;
}

// Paths where two JSON values differ (at most `max`)
function differences(a, b, path = '', out = [], max = 20) {
  if (out.length >= max) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[k], b[k], `${path}.${k}`, out, max);
  } else if (!Object.is(a, b) && JSON.stringify(a) !== JSON.stringify(b)) {
    out.push(`${path || '.'}: expected ${JSON.stringify(b)?.slice(0, 80)}, got ${JSON.stringify(a)?.slice(0, 80)}`);
  }
  return out;
}

const web = fileURLToPath(new URL('web', root));
const server = await serve(web, { '/config.js': `window.TASAK_CONFIG = ${JSON.stringify(fixture('config.json'))};\n` },
  { '/shared/': fileURLToPath(new URL('shared', root)) });
// Nothing leaves the machine: every host but the local server is unreachable
const chrome = await openChrome(['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']);
try {
  const p = await chrome.newPage();
  await p.cmd('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await p.cmd('Page.addScriptToEvaluateOnNewDocument', { source: `(${simulation})(${JSON.stringify(FIX)});` });
  // The page with the browser in `timeZone`: what it computed, the zone it uses and the zone's tag
  const run = async timeZone => {
    p.errors.length = 0;
    await p.cmd('Emulation.setTimezoneOverride', { timezoneId: timeZone });
    await p.goto(`${server.url}/index.html?lang=es`);
    await p.waitFor('window.tasak && tasak.state.live === CONFIG.relays.length');
    const r = await p.evaluate(`(${extract})()`);
    const page = await p.evaluate(`({ tz: CONFIG.tz, tag: document.getElementById('tzTag').textContent })`);
    // Images of the node's profile are external: failing to load them is expected here
    const errors = p.errors.filter(e => !/ERR_NAME_NOT_RESOLVED|Failed to load resource/.test(e));
    if (errors.length) throw new Error(`errors in the page (${timeZone}):\n  ` + errors.join('\n  '));
    return { r, page };
  };
  const { r, page } = await run(meta.browserTimeZone);

  const out = process.argv.indexOf('--screenshot');
  if (out > 0) writeFileSync(process.argv[out + 1], await p.screenshot());

  const previous = existsSync(expectedFile) ? JSON.parse(readFileSync(expectedFile, 'utf8')) : null;
  const actual = {
    description: previous?.description
      ?? 'Values computed by the site before restructuring (tools/reference.mjs) from shared/test/fixtures/',
    now: meta.now, browserTimeZone: meta.browserTimeZone, ...r,
    cases: { ...r.cases, buggyOffsets: previous?.cases?.buggyOffsets ?? [] },
  };
  const units = r.currencies[r.view.fiat]?.units;
  console.log(`view ${r.view.fiat}/${r.view.unit}: header «${r.header.sTasa}» (${r.header.sTasaSub})`);
  for (const [unit, u] of Object.entries(units || {})) {
    console.log(`  ${unit}: rate ${u.rate} from ${u.orders24h} orders in 24 h, ${u.trades.length} trades in total`);
  }
  if (write) {
    writeFileSync(expectedFile, JSON.stringify(actual, null, 1) + '\n');
    console.log(`${r.orders.length} orders, currencies ${Object.keys(r.currencies).join(', ')} -> shared/test/expected.json`);
  } else {
    const diff = previous ? differences(actual, previous) : ['no shared/test/expected.json (run with --write)'];
    if (diff.length) {
      console.error(`DIFFERENT from expected.json:\n  ${diff.join('\n  ')}`);
      process.exitCode = 1;
    } else {
      console.log(`same as expected.json: ${r.orders.length} orders, currencies ${Object.keys(r.currencies).join(', ')}`);
    }
  }

  // In another zone: the same rate, prices and orders; other times, and the candles of shared/ for that zone
  const other = await run(OTHER_ZONE);
  const o = other.r;
  const problems = [];
  if (page.tz !== meta.browserTimeZone || other.page.tz !== OTHER_ZONE) {
    problems.push(`the page doesn't use the browser's time zone: ${page.tz}, ${other.page.tz}`);
  }
  const { sLastSub, sVolSub, ...header } = o.header;
  const { sLastSub: sLastSub0, sVolSub: sVolSub0, ...header0 } = r.header;
  problems.push(...differences(header, header0, '.header'), ...differences(o.orders, r.orders, '.orders'),
    ...differences(o.view, r.view, '.view'));
  if (sLastSub === sLastSub0) problems.push(`.header.sLastSub: the time of the last order didn't change (${sLastSub})`);
  let candles = 0;
  for (const [fiat, c] of Object.entries(r.currencies)) {
    for (const [unit, u] of Object.entries(c.units)) {
      const ou = o.currencies[fiat]?.units[unit];
      const at = `.currencies.${fiat}.units.${unit}`;
      if (!ou) { problems.push(`${at}: missing`); continue; }
      const same = ({ approximateUsd, rateTo, rate, previousRate, orders24h, volume24h, book, trades }) =>
        ({ approximateUsd, rateTo, rate, previousRate, orders24h, volume24h, book, trades: trades.map(({ chartTime, ...t }) => t) });
      problems.push(...differences(same(ou), same(u), at));
      const trades = ou.trades.map(({ key, ts, size, price }) => ({ key, ts, size, price }));
      for (const tf of [0, ...TIMEFRAMES]) {
        const want = chartPoints(trades, { tf, tz: OTHER_ZONE, now: meta.now, withEmpty: true }).map(p => ({ time: p.time,
          value: p.value ?? null, vol: p.vol, n: p.n, avg: p.avg ?? null, avgN: p.avgN ?? null, avgVol: p.avgVol ?? null,
          empty: !!p.empty, key: p.order?.key ?? null }));
        problems.push(...differences(ou.points[tf], want, `${at}.points.${tf}`));
        if (tf === 86400 && u.points[tf].length && JSON.stringify(ou.points[tf]) !== JSON.stringify(u.points[tf])) candles++;
      }
    }
  }
  if (!candles) problems.push(`the daily candles are the same in ${meta.browserTimeZone} and ${OTHER_ZONE}`);
  if (problems.length) {
    console.error(`DIFFERENT in ${OTHER_ZONE}:\n  ${problems.slice(0, 20).join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(`in ${OTHER_ZONE} (${other.page.tag}; ${page.tag} in ${meta.browserTimeZone}): the same rate, prices and orders;`
      + ` last order «${sLastSub}» instead of «${sLastSub0}», and the candles of shared/ for that zone`);
  }
} finally {
  chrome.close();
  server.close();
}
