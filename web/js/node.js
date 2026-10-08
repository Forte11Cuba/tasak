const MOSTROS = new Set(CONFIG.mostros);
const verifyEvent = window.NostrTools?.verifyEvent ?? null;
const meta = new Map();     // pubkey -> { profile, info, relays }
const orders = new Map();   // pubkey:d -> newest version of the order
let live = 0;

document.getElementById('back').href = 'index.html' + location.search;

// Summary of a node's orders for the «Actividad» section
function activity(pk) {
  const now = Date.now() / 1000;
  const mine = [...orders.values()].filter(o => o.pk === pk);
  const done = mine.filter(o => o.s === 'success' && o.fa > 0);
  const open = mine.filter(o => o.s === 'pending' && !(o.exp && o.exp < now));
  const byFiat = new Map();
  for (const o of done) {
    const v = byFiat.get(o.f) || { n: 0, vol: 0 };
    v.n++; v.vol += o.fa;
    byFiat.set(o.f, v);
  }
  const first = Math.min(...done.map(o => o.ts));
  return [
    [t('Órdenes completadas'), `${done.length}${done.length ? ` · ${t('desde {d}', { d: esc(fmtTime(first).split(',')[0]) })}` : ''} <span class="muted">${t('(lo que guardan los relays, ~15 días)')}</span>`],
    ...[...byFiat].sort((a, b) => b[1].n - a[1].n)
      .map(([f, v]) => [t('Volumen en {f}', { f: esc(f) }), `${fmtInt(v.vol)} ${esc(f)} · ${nOrders(v.n)}`]),
    [t('Órdenes abiertas ahora'), String(open.length)],
  ];
}

let queued = false;
function render() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    document.getElementById('nodes').innerHTML = CONFIG.mostros.length
      ? CONFIG.mostros.map(pk => nodeCardHtml(pk, meta.get(pk), activity(pk))).join('')
      : `<p class="muted">${t('No hay nodos configurados: ejecuta «node build.mjs» o pasa ?mostro=… en la URL.')}</p>`;
    const name = meta.get(CONFIG.mostros[0])?.profile?.name;
    if (name) document.title = `${name} · ${t('Nodo Mostro')} · ${CONFIG.siteName}`;
    document.getElementById('dot').classList.toggle('live', live > 0);
    document.getElementById('status').textContent = live
      ? `${live}/${CONFIG.relays.length} relays${verifyEvent ? ' · ' + t('✓ firmas') : ''}` : t('Conectando…');
  });
}

function onEvent(ev) {
  if (!ev || !MOSTROS.has(ev.pubkey)) return;
  if (verifyEvent && !verifyEvent(ev)) return;
  if (ev.kind === 38383) {
    const t = {};
    for (const [k, ...v] of ev.tags) if (!(k in t)) t[k] = v;
    if (!t.d || !t.s) return;
    const key = ev.pubkey + ':' + t.d[0];
    const prev = orders.get(key);
    if (prev && prev.ts >= ev.created_at) return;
    orders.set(key, {
      pk: ev.pubkey, ts: ev.created_at, s: t.s[0], f: (t.f?.[0] || '').toUpperCase(),
      fa: (t.fa || []).length === 1 ? Number(t.fa[0]) : 0, exp: Number(t.expires_at?.[0] || 0),
    });
  } else if (!applyMeta(meta, ev)) return;
  render();
}

// One query per relay: node information and its orders (no paging: they are few)
function connect(url) {
  let ws;
  try { ws = new WebSocket(url); } catch { return; }
  let counted = false;
  ws.onopen = () => {
    ws.send(JSON.stringify(['REQ', 'n', { kinds: META_KINDS, authors: CONFIG.mostros },
      { kinds: [38383], authors: CONFIG.mostros, limit: 500 }]));
  };
  ws.onmessage = msg => {
    let d;
    try { d = JSON.parse(msg.data); } catch { return; }
    if (d[0] === 'EVENT') onEvent(d[2]);
    else if (d[0] === 'EOSE' && !counted) { counted = true; live++; render(); }
  };
  ws.onclose = () => { if (counted) { live--; render(); } };
  ws.onerror = () => ws.close();
}

render();
CONFIG.relays.forEach(connect);
