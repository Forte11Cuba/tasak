// Lee .env (o variables de entorno) y genera config.js para index.html.
// Uso: node build.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('.', import.meta.url);
const envFile = new URL('.env', dir);

const fileEnv = {};
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    fileEnv[m[1]] = v;
  }
} else {
  console.warn('Warning: no .env file; using environment variables only (see .env.example).');
}

// Las variables de entorno del proceso tienen prioridad (útil en CI)
const get = k => process.env[k] ?? fileEnv[k];
const list = s => (s || '').split(/[\s,]+/).filter(Boolean);

// Las variables del .env están en inglés para que sirvan a cualquier operador de nodo
const config = {
  nombreSitio: get('SITE_NAME') || 'tasaK',
  nombreTasa: get('RATE_NAME') || 'Tasa K',
  logo: get('LOGO') || '',
  logoClaro: get('LOGO_LIGHT') || '',
  // Tema por defecto (light | dark); vacío = el del sistema
  tema: ['light', 'dark'].includes(get('THEME')) ? get('THEME') : '',
  // Idioma por defecto (es | en); vacío = el del navegador
  idioma: ['es', 'en'].includes(get('LANGUAGE')) ? get('LANGUAGE') : '',
  mostros: list(get('MOSTRO_PUBKEYS')),
  relays: list(get('RELAYS')),
  // Vacíos: la moneda más usada en el nodo y la zona horaria del navegador del visitante
  fiat: (get('FIAT') || '').toUpperCase(),
  zonaHoraria: get('TIMEZONE') || '',
  comunidad: { nombre: get('COMMUNITY') || '', url: get('COMMUNITY_URL') || '' },
  rrss: list(get('SOCIAL_LINKS')),
  // Separados solo por coma: los nombres pueden llevar espacios («Saldo móvil»)
  metodosOcultos: get('HIDDEN_PAYMENT_METHODS') == null ? ['Pruebas', 'Otros']
    : get('HIDDEN_PAYMENT_METHODS').split(',').map(s => s.trim()).filter(Boolean),
};

// Mensajes en inglés, como el .env
const errors = [];
if (!config.mostros.length) errors.push('MOSTRO_PUBKEYS is empty');
for (const k of config.mostros) {
  if (!/^([0-9a-f]{64}|npub1[02-9ac-hj-np-z]{58})$/i.test(k)) errors.push(`invalid pubkey: ${k}`);
}
if (!config.relays.length) errors.push('RELAYS is empty');
for (const r of config.relays) {
  // Solo cifrados (wss://); ws:// únicamente para un relay local de pruebas
  if (!/^wss:\/\/\S+$/i.test(r) && !/^ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/i.test(r)) {
    errors.push(`invalid relay (must start with wss://): ${r}`);
  }
}
for (const u of [config.comunidad.url, ...config.rrss].filter(Boolean)) {
  if (!/^https:\/\/\S+$/i.test(u)) errors.push(`invalid link (must start with https://): ${u}`);
}
if (config.zonaHoraria) {
  try { new Intl.DateTimeFormat('en', { timeZone: config.zonaHoraria }); }
  catch { errors.push(`invalid TIMEZONE: ${config.zonaHoraria}`); }
}
for (const [k, v] of [['LOGO', config.logo], ['LOGO_LIGHT', config.logoClaro]].filter(([, v]) => v)) {
  if (!/^(https:\/\/\S+|[\w./-]+\.(svg|png|jpe?g|webp))$/i.test(v)) {
    errors.push(`invalid ${k} (.svg/.png/.jpg/.webp file or https link): ${v}`);
  } else if (!v.startsWith('https://') && !existsSync(new URL(v, dir))) {
    errors.push(`${k} file not found: ${v}`);
  }
}
if (errors.length) {
  console.error('Configuration error:\n  ' + errors.join('\n  '));
  process.exit(1);
}

writeFileSync(new URL('config.js', dir),
  `// Generado por build.mjs a partir de .env. No editar a mano.\nwindow.TASAK_CONFIG = ${JSON.stringify(config, null, 2)};\n`);
console.log(`config.js generated: ${config.mostros.length} node(s), ${config.relays.length} relay(s), currency ${config.fiat || 'auto'}`);
