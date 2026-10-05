// Código compartido por index.html y nodo.html: configuración, formato e información del nodo.

// npub (bech32) -> hex. Sin dependencias para que funcione aunque el CDN esté bloqueado.
function toHex(key) {
  const s = String(key).trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(s)) return s;
  const CH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const m = s.match(/^npub1([02-9ac-hj-np-z]+)$/);
  if (!m) return null;
  let acc = 0, bits = 0, hex = '';
  for (const c of m[1].slice(0, -6)) {   // los últimos 6 caracteres son el checksum
    acc = ((acc << 5) | CH.indexOf(c)) & 0xfff;
    bits += 5;
    if (bits >= 8) { bits -= 8; hex += ((acc >> bits) & 0xff).toString(16).padStart(2, '0'); }
  }
  return hex.length === 64 ? hex : null;
}

// Relays: solo cifrados (wss://); ws:// únicamente para un relay local de pruebas
const validRelay = u => /^wss:\/\/\S+$/i.test(u) || /^ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/i.test(u);

// Configuración: .env (config.js) con los parámetros de la URL por encima
const CONFIG = (() => {
  const base = window.TASAK_CONFIG || {};
  const qs = new URLSearchParams(location.search);
  const list = k => (qs.get(k) || '').split(/[\s,]+/).filter(Boolean);
  const mostros = list('mostro').length ? list('mostro') : base.mostros || [];
  const relays = list('relays').length ? list('relays') : base.relays || [];
  return {
    fromEnv: !!window.TASAK_CONFIG,
    // La comunidad y sus redes describen los nodos del .env; no se muestran si la URL cambia de nodo
    comunidad: list('mostro').length ? null : base.comunidad,
    rrss: list('mostro').length ? [] : (base.rrss || []).filter(u => /^https:\/\//i.test(u)),
    mostros: [...new Set(mostros.map(toHex).filter(Boolean))],
    relays: [...new Set(relays.filter(validRelay))],
    nombreSitio: base.nombreSitio || 'tasaK',
    nombreTasa: base.nombreTasa || 'Tasa K',
    logo: base.logo || '',
    logoClaro: base.logoClaro || '',
    tema: base.tema || '',
    metodosOcultos: base.metodosOcultos || ['Pruebas', 'Otros'],
    // Sin moneda configurada, la página elige la más usada en el nodo
    fiat: (qs.get('fiat') || base.fiat || '').toUpperCase(),
    tz: base.zonaHoraria || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  };
})();

// ---------- Tema claro / oscuro ----------
// Elección guardada en este navegador > THEME del .env > tema del sistema.
// Se aplica nada más cargar comun.js (en <head>) para que la página no parpadee.
let THEME = (() => {
  try { const s = localStorage.getItem('tasak.theme'); if (s === 'light' || s === 'dark') return s; } catch {}
  if (CONFIG.tema === 'light' || CONFIG.tema === 'dark') return CONFIG.tema;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
})();
document.documentElement.dataset.theme = THEME;

// Cambia el tema sin recargar; las páginas escuchan 'themechange' para repintar lo que no es CSS (gráfica)
function setTheme(theme) {
  THEME = theme;
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('tasak.theme', theme); } catch {}
  applyNames();
  renderThemeButtons();
  document.dispatchEvent(new Event('themechange'));
}
function renderThemeButtons() {
  for (const b of document.querySelectorAll('.theme-btn')) {
    b.textContent = THEME === 'light' ? '☾' : '☀';
    b.title = t(THEME === 'light' ? 'Tema oscuro' : 'Tema claro');
    b.setAttribute('aria-label', b.title);
  }
}
document.addEventListener('DOMContentLoaded', () => {
  renderThemeButtons();
  for (const b of document.querySelectorAll('.theme-btn')) b.onclick = () => setTheme(THEME === 'light' ? 'dark' : 'light');
});

// ---------- Nombre del sitio y de la tasa (configurables en .env) ----------
// Logo: si el nombre termina en mayúsculas (tasaK), esa parte va resaltada
function brandHtml(name = CONFIG.nombreSitio) {
  const m = name.match(/^(.*[^A-Z])([A-Z]+)$/);
  return m ? `${esc(m[1])}<span>${esc(m[2])}</span>` : esc(name);
}
// Rellena los textos marcados con data-name, el título de la pestaña y el icono
function applyNames() {
  for (const el of document.querySelectorAll('[data-name="sitio"]')) {
    // Con LOGO en el .env se muestra la imagen (LOGO_LIGHT en el tema claro); si no carga, el nombre en texto
    const logo = THEME === 'light' && CONFIG.logoClaro ? CONFIG.logoClaro : CONFIG.logo;
    el.innerHTML = logo
      ? `<img class="brand-logo" src="${esc(logo)}" alt="${esc(CONFIG.nombreSitio)}">`
      : brandHtml();
    el.querySelector('img')?.addEventListener('error', () => { el.innerHTML = brandHtml(); });
  }
  for (const el of document.querySelectorAll('[data-name="tasa"]')) el.textContent = CONFIG.nombreTasa;
  document.title = document.title.replace('tasaK', CONFIG.nombreSitio);
  const letter = (CONFIG.nombreSitio.match(/[A-Z]+$/)?.[0] || CONFIG.nombreSitio[0] || 'K').slice(0, 2);
  const icon = document.querySelector('link[rel="icon"]');
  if (icon) icon.href = 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0b0e11"/>` +
    `<text x="16" y="24" font-size="${letter.length > 1 ? 16 : 22}" font-weight="800" text-anchor="middle" fill="#f0b90b" font-family="sans-serif">${esc(letter)}</text></svg>`);
}
document.addEventListener('DOMContentLoaded', applyNames);

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtInt = n => Math.round(n).toLocaleString(LOCALE);
const fmtTime = ts => new Date(ts * 1000).toLocaleString(LOCALE, {
  timeZone: CONFIG.tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// ---------- Información del nodo: perfil (0), información (38385) y relays (10002) ----------
const META_KINDS = [0, 38385, 10002];

// Guarda en `metaMap` (pubkey -> { profile, info, relays }) la versión más reciente de cada evento
function applyMeta(metaMap, ev) {
  const m = metaMap.get(ev.pubkey) || {};
  const slot = { 0: 'profile', 38385: 'info', 10002: 'relays' }[ev.kind];
  if (!slot || (m[slot] && m[slot].ts >= ev.created_at)) return false;
  if (ev.kind === 0) {
    let p;
    try { p = JSON.parse(ev.content); } catch { return false; }
    m.profile = { ts: ev.created_at, ...p };
  } else if (ev.kind === 38385) {
    const t = {};
    for (const [k, v] of ev.tags) if (!(k in t)) t[k] = v;
    m.info = { ts: ev.created_at, ...t };
  } else {
    m.relays = { ts: ev.created_at, list: ev.tags.filter(t => t[0] === 'r').map(t => t[1]) };
  }
  metaMap.set(ev.pubkey, m);
  return true;
}

// Nombre legible de una red social a partir de su enlace
function linkLabel(u) {
  try {
    const url = new URL(u);
    const h = url.hostname.replace(/^www\./, '');
    const path = url.pathname.replace(/\/$/, '').split('/').pop();
    if (h === 't.me') return `Telegram · @${path}`;
    if (h === 'x.com' || h === 'twitter.com') return `X · @${path}`;
    if (h === 'youtube.com') return `YouTube · ${decodeURIComponent(path)}`;
    if (h === 'github.com') return `GitHub · ${path}`;
    if (/primal\.net|njump\.me|nostr/.test(h)) return t('Nostr de la comunidad');
    return h;
  } catch { return u; }
}
const extLink = (u, label) => /^https:\/\//i.test(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(label)} ↗</a>` : '';

// Tarjeta HTML de un nodo. `activity` son filas [etiqueta, valor HTML] con datos de sus órdenes.
function nodeCardHtml(pk, m = {}, activity = []) {
  const fmtSats = n => `${fmtInt(Number(n))} sats`;
  const fmtDur = sec => sec >= 3600 ? `${sec / 3600} h` : `${Math.round(sec / 60)} min`;
  const p = m.profile || {}, info = m.info;
  const npub = window.NostrTools?.nip19?.npubEncode(pk) || pk;
  const kv = rows => `<dl class="node-kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;

  const links = [
    p.website && extLink(p.website, t('Web del nodo')),
    CONFIG.comunidad?.url && extLink(CONFIG.comunidad.url, CONFIG.comunidad.nombre || t('Comunidad')),
    ...CONFIG.rrss.map(u => extLink(u, linkLabel(u))),
    extLink('https://njump.me/' + npub, t('El nodo en Nostr')),
  ].filter(Boolean).join('');

  return `<div class="node-card">
    <div class="node-top">
      ${p.picture && /^https:\/\//.test(p.picture) ? `<img alt="" src="${esc(p.picture)}" onerror="this.remove()">` : ''}
      <div>
        <h3>${esc(p.name || pk.slice(0, 8) + '…')}</h3>
        ${p.about ? `<p>${esc(p.about)}</p>` : ''}
        ${CONFIG.comunidad?.nombre ? `<p>${t('Comunidad:')} <strong>${esc(CONFIG.comunidad.nombre)}</strong></p>` : ''}
      </div>
    </div>
    ${links ? `<div class="node-links">${links}</div>` : ''}

    <div class="node-sec">${t('Condiciones')}</div>
    ${info ? kv([
      info.fee != null && [t('Comisión del nodo'), t('{p} del monto de cada orden', { p: `<strong>${(Number(info.fee) * 100).toLocaleString(LOCALE, { maximumFractionDigits: 2 })}${LANG === 'en' ? '' : ' '}%</strong>` })],
      info.min_order_amount && [t('Monto por orden'), `${fmtSats(info.min_order_amount)} – ${fmtSats(info.max_order_amount)}`],
      info.expiration_hours && [t('Una orden publicada dura'), `${esc(info.expiration_hours)} h`],
      info.expiration_seconds && [t('Tiempo para seguir una orden tomada'), fmtDur(Number(info.expiration_seconds))],
      [t('Estado'), info.maintenance_mode === 'true' ? `<span style="color:var(--accent)">${t('⚠ en mantenimiento')}</span>` : `<span class="up">${t('● operativo')}</span>`],
    ]) : `<p class="muted">${t('El nodo aún no ha enviado su información (evento kind 38385).')}</p>`}

    ${activity.length ? `<div class="node-sec">${t('Actividad')}</div>${kv(activity)}` : ''}

    <div class="node-sec">${t('Técnico')}</div>
    ${kv([
      ['Pubkey', `<span class="num">${esc(npub)}</span>`],
      info?.mostro_version && ['Mostro', `v${esc(info.mostro_version)}${info.protocol_version ? ` · ${t('protocolo {v}', { v: esc(info.protocol_version) })}` : ''}`],
      info?.lnd_node_alias && [t('Nodo Lightning'), `${esc(info.lnd_node_alias)}${info.lnd_version ? ` · LND ${esc(info.lnd_version.split(' ')[0])}` : ''}`],
      info?.lnd_node_pubkey && [t('Pubkey Lightning'), `<span class="num">${esc(info.lnd_node_pubkey)}</span>`],
      m.relays?.list.length && [t('Relays del nodo'), m.relays.list.map(esc).join('<br>')],
      info && [t('Información publicada'), esc(fmtTime(info.ts))],
    ])}
  </div>`;
}
