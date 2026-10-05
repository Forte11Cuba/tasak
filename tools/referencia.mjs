// Freezes what the CURRENT site computes from the fixed data in shared/test/fixtures/ and writes it
// to shared/test/esperado.json. Those are the values the restructured code (shared/) must reproduce.
//
// Usage: node tools/referencia.mjs [--captura out.png]   (Node >= 22 and Google Chrome)
//
// The real index.html runs in headless Chrome with everything external replaced:
// - config.js: shared/test/fixtures/config.json (not the local .env);
// - relays: a fake WebSocket that answers REQs from fixtures/eventos.json, as a relay would;
// - Coinbase and Yadio: fixtures/btcusd.json and fixtures/yadio.json;
// - clock and time zone: fixtures/meta.json (now and the visitor's time zone);
// - any other host is unreachable.
import { readFileSync, writeFileSync } from 'node:fs';
import { servir, abrirChrome } from './cdp.mjs';

const raiz = new URL('../', import.meta.url);
const fix = n => JSON.parse(readFileSync(new URL(`shared/test/fixtures/${n}`, raiz), 'utf8'));
const meta = fix('meta.json');
const FIX = { eventos: fix('eventos.json'), btcusd: fix('btcusd.json'), yadio: fix('yadio.json'), ahora: meta.ahora };

// Runs in the page before any of its scripts
function simulacion(FIX) {
  const NOW = FIX.ahora * 1000;
  const RealDate = Date;
  window.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(NOW); }
    static now() { return NOW; }
  };

  const coincide = (e, f) => (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey))
    && (f.since == null || e.created_at >= f.since) && (f.until == null || e.created_at <= f.until)
    && Object.keys(f).filter(k => k[0] === '#')
      .every(k => e.tags.some(t => t[0] === k.slice(1) && f[k].includes(t[1])));
  // A relay holding every fixture event: newest first, `limit` per filter
  class RelayFalso {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      setTimeout(() => { this.readyState = 1; this.onopen?.({}); });
    }
    send(texto) {
      const [tipo, id, ...filtros] = JSON.parse(texto);
      if (tipo !== 'REQ') return;
      const salida = new Map();
      for (const f of filtros) {
        let l = FIX.eventos.filter(e => coincide(e, f)).sort((a, b) => b.created_at - a.created_at);
        if (f.limit != null) l = l.slice(0, f.limit);
        for (const e of l) salida.set(e.id, e);
      }
      setTimeout(() => {
        for (const e of salida.values()) this.onmessage?.({ data: JSON.stringify(['EVENT', id, e]) });
        this.onmessage?.({ data: JSON.stringify(['EOSE', id]) });
      });
    }
    close() { this.readyState = 3; }
  }
  window.WebSocket = RelayFalso;

  const fetchReal = window.fetch;
  const json = d => new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, ...resto) => {
    const u = new URL(String(url), location.href);
    if (u.hostname === 'api.yadio.io') return json(FIX.yadio);
    if (u.hostname === 'api.exchange.coinbase.com') {
      const desde = new RealDate(u.searchParams.get('start')) / 1000;
      const hasta = new RealDate(u.searchParams.get('end')) / 1000;
      // Like Coinbase: [time, low, high, open, close, volume], newest first
      return json(Object.entries(FIX.btcusd).map(([t, c]) => [Number(t), c, c, c, c, 0])
        .filter(v => v[0] >= desde && v[0] <= hasta).sort((a, b) => b[0] - a[0]));
    }
    if (u.origin !== location.origin) throw new TypeError(`unreachable in tests: ${u}`);
    return fetchReal(url, ...resto);
  };
}

// Runs in the page once it has loaded the fixtures: reads what the site computed
async function extraer() {
  const calmar = async () => {
    for (let i = 0; i < 100; i++) {
      await rendering;
      await new Promise(r => setTimeout(r, 20));
      if (!renderQueued) { await rendering; return; }
    }
  };
  await calmar();
  const now = Date.now() / 1000;
  const texto = id => document.getElementById(id)?.textContent.trim() ?? null;
  const r = {};

  // The default view, as a visitor sees it
  r.vista = { fiat: state.fiat, unidad: state.unit, modo: state.mode, temporalidad: state.tf,
    metodosActivos: [...state.pmSel].sort() };
  r.cabecera = Object.fromEntries(['sTasa', 'sTasaSub', 'sChg', 'sYadio', 'sYadioSub', 'sVol', 'sVolSub', 'sLast', 'sLastSub']
    .map(id => [id, texto(id)]));

  // Chosen version of every order and how its payment methods were classified
  r.ordenes = [...state.orders.values()].sort((a, b) => a.key < b.key ? -1 : 1).map(o => ({
    key: o.key, id: o.ev.id, ts: o.ts, status: o.status, side: o.side, fiat: o.fiat, fa: o.fa, amt: o.amt,
    premium: o.premium, expiresAt: o.expiresAt, pm: o.pm, pmKeys: o.pmKeys, origin: o.origin ?? null,
  }));

  // Per currency with completed orders, its default payment methods, and per unit everything derived
  const antes = { fiat: state.fiat, unit: state.unit, pmSel: state.pmSel, pmKnown: state.pmKnown };
  const fiats = [...new Set(r.ordenes.filter(o => o.status === 'success').map(o => o.fiat))].sort();
  r.monedas = {};
  for (const fiat of fiats) {
    state.fiat = fiat; state.pmSel = null; state.pmKnown = null;
    renderFilters();
    const m = r.monedas[fiat] = { metodosActivos: [...state.pmSel].sort(), unidades: {} };
    for (const unit of ['usd', 'btc', 'sat']) {
      state.unit = unit;
      const trades = getTrades();
      const enVentana = trades.filter(t => t.ts > now - WIN);
      const anterior = trades.filter(t => t.ts > now - 2 * WIN && t.ts <= now - WIN);
      const u = m.unidades[unit] = {
        usdAproximado: state.btcApprox,
        tasa: weightedPrice(enVentana),
        tasaAnterior: weightedPrice(anterior),
        ordenes24h: enVentana.length,
        volumen24h: enVentana.reduce((a, t) => a + t.size, 0),
        trades: trades.map(t => ({ key: t.key, ts: t.ts, size: t.size, price: t.price, tiempoGrafica: toChartTime(t.ts) })),
        velas: {},
      };
      for (const tf of [3600, 14400, 86400, 604800, 2592000, 31536000]) {
        const velas = buildCandles(trades, tf).sort((a, b) => a.time - b.time);
        u.velas[tf] = { velas, vacios: emptyPeriods(velas.map(c => c.time), tf) };
      }
      const libro = getBook();
      const fila = o => ({ key: o.key, price: o.price, size: o.size, fixed: o.fixed });
      u.libro = { asks: libro.asks.map(fila), bids: libro.bids.map(fila) };
    }
  }
  Object.assign(state, antes);
  renderFilters();

  // Small cases straight on the functions
  const pm = [['Cash', 'USD'], ['Cash App', 'USD'], ['360 CUP de saldo móvil 📲', 'CUP'], ['Saldo móvil', 'CUP'],
    ['Clásica', 'CUP'], ['prueba, no tomar', 'CUP'], ['TEST', 'USD'], ['Transfermovil', 'CUP'], ['EnZona', 'CUP'],
    ['Transferencia CUP 🇨🇺', 'CUP'], ['Efectivo', 'CUP'], ['Zelle', 'CUP'], ['Zelle', 'USD'], ['+53 5555 5555', 'CUP'],
    ['MiTransfer', 'CUP'], ['Bank Transfer', 'XYZ']];
  const estados = ['pending', 'in-progress', 'success', 'canceled', 'expired'];
  const versiones = [];
  for (const a of estados) for (const b of estados) for (const [ta, tb] of [[1, 1], [2, 1], [1, 2]]) {
    for (const [ia, ib] of [['a', 'b'], ['b', 'a']]) {
      versiones.push({ a: [ta, a, ia], b: [tb, b, ib],
        gana: newerVersion({ ts: ta, status: a, ev: { id: ia } }, { ts: tb, status: b, ev: { id: ib } }) });
    }
  }
  // Monday 5/1/1970 week anchor, month and year ends, leap day, and the configured zone's DST changes
  // (times already in local chart time, as periodStart receives them)
  const tiempos = [0, 4 * 86400 - 1, 4 * 86400, 1790553599, 1790553600, 1790812799, 1790812800,
    1767225599, 1767225600, 1835438400, now];
  const periodos = [];
  for (const time of tiempos) for (const tf of [3600, 14400, 86400, 604800, 2592000, 31536000]) {
    const inicio = periodStart(time, tf);
    periodos.push({ time, tf, inicio, siguiente: nextPeriod(inicio, tf) });
  }
  // Every half hour around the 2026 DST changes of America/Havana (8/3 and 1/11, 05:00 UTC).
  // KNOWN BUG, frozen as is: tzOffset parses date text in the browser's zone, so within ~5 h of a DST
  // change of that zone it is off by one hour. The restructured code must return the correct
  // offsets here (Intl formatToParts), not these
  const offsets = [1772946000, 1793509200].flatMap(c => Array.from({ length: 9 }, (_, i) => c + (i - 4) * 1800))
    .concat(now).map(ts => ({ ts, offset: tzOffset(ts) }));
  r.casos = {
    pmKey: pm.map(([texto, moneda]) => ({ texto, moneda, metodo: pmKey(texto, moneda) })),
    // The FAQ example: 3 orders at 785 that add up to 3000 and one at 750 of 5000
    ejemploFaq: weightedPrice([{ price: 785, size: 1000 }, { price: 785, size: 1000 }, { price: 785, size: 1000 },
      { price: 750, size: 5000 }]),
    versiones, periodos,
    offsetsConFallo: offsets,
  };
  return r;
}

const servidor = await servir(new URL('.', raiz).pathname.replace(/\/$/, ''), {
  '/config.js': `window.TASAK_CONFIG = ${JSON.stringify(fix('config.json'))};\n`,
});
// Nothing leaves the machine: every host but the local server is unreachable
const chrome = await abrirChrome(['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']);
try {
  const p = await chrome.nuevaPagina();
  await p.cmd('Emulation.setTimezoneOverride', { timezoneId: meta.zonaNavegador });
  await p.cmd('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await p.cmd('Page.addScriptToEvaluateOnNewDocument', { source: `(${simulacion})(${JSON.stringify(FIX)});` });
  await p.ir(`${servidor.url}/index.html?lang=es`);
  await p.esperarA('state.live === CONFIG.relays.length');
  const r = await p.evaluar(`(${extraer})()`);

  const salida = process.argv.indexOf('--captura');
  if (salida > 0) writeFileSync(process.argv[salida + 1], await p.captura());
  // Images of the node's profile are external: failing to load them is expected here
  const errores = p.errores.filter(e => !/ERR_NAME_NOT_RESOLVED|Failed to load resource/.test(e));
  if (errores.length) throw new Error('errors in the page:\n  ' + errores.join('\n  '));

  const esperado = {
    descripcion: 'Values computed by the site before restructuring (tools/referencia.mjs) from shared/test/fixtures/',
    ahora: meta.ahora, zonaNavegador: meta.zonaNavegador, ...r,
  };
  writeFileSync(new URL('shared/test/esperado.json', raiz), JSON.stringify(esperado, null, 1) + '\n');
  const cup = r.monedas[r.vista.fiat]?.unidades;
  console.log(`view ${r.vista.fiat}/${r.vista.unidad}: header «${r.cabecera.sTasa}» (${r.cabecera.sTasaSub})`);
  for (const [unidad, u] of Object.entries(cup || {})) {
    console.log(`  ${unidad}: rate ${u.tasa} from ${u.ordenes24h} orders in 24 h, ${u.trades.length} trades in total`);
  }
  console.log(`${r.ordenes.length} orders, currencies ${Object.keys(r.monedas).join(', ')} -> shared/test/esperado.json`);
} finally {
  chrome.cerrar();
  servidor.cerrar();
}
