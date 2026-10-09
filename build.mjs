// Reads .env (or environment variables), generates web/config.js and copies shared/ into web/shared/,
// so that web/ is the only folder to deploy. With --serve, it then serves web/ locally.
// Usage: node build.mjs [--serve [--port 8765]]
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = new URL('.', import.meta.url);
const web = new URL('web/', root);
const envFile = new URL('.env', root);

// The .env format: KEY=value lines, # comments, optional quotes around the value; later lines win.
// The Rust server (server/src/config.rs) reads it the same way: both pass shared/test/config-cases.json.
export function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

// get(key) gives a variable's value or undefined; webDir is the URL of web/ (to check the logos).
// Returns { config, errors }: the config is only valid if errors is empty.
export function buildConfig(get, webDir) {
  const list = s => (s || '').split(/[\s,]+/).filter(Boolean);
  const config = {
    siteName: get('SITE_NAME') || 'tasaK',
    rateName: get('RATE_NAME') || 'Tasa K',
    logo: get('LOGO') || '',
    logoLight: get('LOGO_LIGHT') || '',
    // Default theme (light | dark); empty = the system's
    theme: ['light', 'dark'].includes(get('THEME')) ? get('THEME') : '',
    // Default language (es | en); empty = the browser's
    language: ['es', 'en'].includes(get('LANGUAGE')) ? get('LANGUAGE') : '',
    mostros: list(get('MOSTRO_PUBKEYS')),
    relays: list(get('RELAYS')),
    // Empty: the most traded currency on the node and the visitor's browser time zone
    fiat: (get('FIAT') || '').toUpperCase(),
    timeZone: get('TIMEZONE') || '',
    community: { name: get('COMMUNITY') || '', url: get('COMMUNITY_URL') || '' },
    socialLinks: list(get('SOCIAL_LINKS')),
    // Comma separated only: names may contain spaces («Saldo móvil»)
    hiddenPaymentMethods: get('HIDDEN_PAYMENT_METHODS') == null ? ['Pruebas', 'Otros']
      : get('HIDDEN_PAYMENT_METHODS').split(',').map(s => s.trim()).filter(Boolean),
  };

  const errors = [];
  if (!config.mostros.length) errors.push('MOSTRO_PUBKEYS is empty');
  for (const k of config.mostros) {
    if (!/^([0-9a-f]{64}|npub1[02-9ac-hj-np-z]{58})$/i.test(k)) errors.push(`invalid pubkey: ${k}`);
  }
  if (!config.relays.length) errors.push('RELAYS is empty');
  for (const r of config.relays) {
    // Encrypted only (wss://); ws:// just for a local test relay
    if (!/^wss:\/\/\S+$/i.test(r) && !/^ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/i.test(r)) {
      errors.push(`invalid relay (must start with wss://): ${r}`);
    }
  }
  for (const u of [config.community.url, ...config.socialLinks].filter(Boolean)) {
    if (!/^https:\/\/\S+$/i.test(u)) errors.push(`invalid link (must start with https://): ${u}`);
  }
  if (config.timeZone) {
    try { new Intl.DateTimeFormat('en', { timeZone: config.timeZone }); }
    catch { errors.push(`invalid TIMEZONE: ${config.timeZone}`); }
  }
  for (const [k, v] of [['LOGO', config.logo], ['LOGO_LIGHT', config.logoLight]].filter(([, v]) => v)) {
    if (!/^(https:\/\/\S+|[\w./-]+\.(svg|png|jpe?g|webp))$/i.test(v)) {
      errors.push(`invalid ${k} (.svg/.png/.jpg/.webp file or https link): ${v}`);
    } else if (!/^https:\/\//i.test(v) && !existsSync(new URL(v, webDir))) {
      errors.push(`${k} file not found in web/: ${v}`);
    }
  }
  return { config, errors };
}

export const renderConfig = config =>
  `// Generated from .env by build.mjs or the tasak server. Do not edit by hand.\n`
  + `window.TASAK_CONFIG = ${JSON.stringify(config, null, 2)};\n`;

// Only when run (node build.mjs), not when imported by the tests
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

function main() {
  let fileEnv = {};
  if (existsSync(envFile)) fileEnv = parseEnv(readFileSync(envFile, 'utf8'));
  else console.warn('Warning: no .env file; using environment variables only (see .env.example).');

  // Process environment variables take precedence (useful in CI)
  const { config, errors } = buildConfig(k => process.env[k] ?? fileEnv[k], web);
  if (errors.length) {
    console.error('Configuration error:\n  ' + errors.join('\n  '));
    process.exit(1);
  }

  writeFileSync(new URL('config.js', web), renderConfig(config));

  // The pure logic of the rate (shared/*.js, without its tests), as ES modules for the pages
  const sharedSrc = new URL('shared/', root);
  const sharedDst = new URL('shared/', web);
  rmSync(sharedDst, { recursive: true, force: true });
  mkdirSync(sharedDst);
  const modules = readdirSync(sharedSrc).filter(f => f.endsWith('.js'));
  for (const f of modules) copyFileSync(new URL(f, sharedSrc), new URL(f, sharedDst));

  console.log(`web/config.js generated: ${config.mostros.length} node(s), ${config.relays.length} relay(s), `
    + `currency ${config.fiat || 'auto'}; ${modules.length} modules copied to web/shared/`);

  // The pages use ES modules, which browsers don't load from file://: they need a web server
  const args = process.argv.slice(2);
  const portArg = args.indexOf('--port');
  const port = portArg >= 0 ? Number(args[portArg + 1]) : 8765;
  if (!args.includes('--serve')) {
    console.log('To see it: node build.mjs --serve  ->  http://localhost:8765/');
  } else if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${args[portArg + 1]}`);
    process.exit(1);
  } else {
    serve(port);
  }
}

// Minimal static server for trying the site: only this machine (127.0.0.1), only files inside web/,
// no cache so that every reload shows the latest files. To publish, use a real web server.
function serve(port) {
  const dir = fileURLToPath(web);
  const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  };
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { path = null; }
    let file = path && join(dir, normalize(path));
    if (file && file.startsWith(dir) && existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!file || !(file + sep).startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
  });
  server.on('error', e => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use: try node build.mjs --serve --port ${port + 1}` : e.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Serving web/ at http://localhost:${port}/ (Ctrl+C to stop; run it again after changing .env or shared/)`);
  });
}
