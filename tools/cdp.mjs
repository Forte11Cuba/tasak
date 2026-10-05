// Helpers to check the site in headless Chrome over the DevTools protocol (CDP), with no
// dependencies (Node >= 22: native WebSocket and fetch): a static server for the site, Chrome, and
// a page to drive (evaluate JS, collect console errors, take screenshots).
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';
import { setTimeout as esperar } from 'node:timers/promises';

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

// Serves the folder `raiz` on 127.0.0.1; `reemplazos` maps a path (e.g. '/config.js') to the
// content served instead of the file on disk
export function servir(raiz, reemplazos = {}) {
  const server = createServer((req, res) => {
    const ruta = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (ruta in reemplazos) {
      res.writeHead(200, { 'Content-Type': TIPOS[extname(ruta)] || 'text/plain' });
      return res.end(reemplazos[ruta]);
    }
    const archivo = join(raiz, normalize(ruta === '/' ? '/index.html' : ruta));
    if (!archivo.startsWith(raiz) || !existsSync(archivo)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TIPOS[extname(archivo)] || 'application/octet-stream' });
    res.end(readFileSync(archivo));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    cerrar: () => server.close(),
  })));
}

// Starts headless Chrome (CHROME = path of the binary; default google-chrome)
export async function abrirChrome(args = []) {
  const perfil = mkdtempSync(join(tmpdir(), 'tasak-chrome-'));
  const proc = spawn(process.env.CHROME || 'google-chrome', [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${perfil}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', ...args,
  ], { stdio: 'ignore' });
  const archivoPuerto = join(perfil, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(archivoPuerto); i++) await esperar(100);
  if (!existsSync(archivoPuerto)) { proc.kill(); throw new Error('Chrome did not start (set CHROME to its path)'); }
  const puerto = Number(readFileSync(archivoPuerto, 'utf8').split('\n')[0]);
  return {
    puerto,
    async nuevaPagina() {
      const res = await fetch(`http://127.0.0.1:${puerto}/json/new?about:blank`, { method: 'PUT' });
      return Pagina.conectar((await res.json()).webSocketDebuggerUrl);
    },
    cerrar() {
      proc.kill();
      try { rmSync(perfil, { recursive: true, force: true }); } catch {}
    },
  };
}

export class Pagina {
  static async conectar(url) {
    const p = new Pagina();
    p.ws = new WebSocket(url);
    await new Promise((ok, mal) => { p.ws.onopen = ok; p.ws.onerror = mal; });
    p.ws.onmessage = m => p.alMensaje(JSON.parse(m.data));
    await p.cmd('Runtime.enable');
    await p.cmd('Page.enable');
    await p.cmd('Log.enable');
    return p;
  }

  n = 0;
  pendientes = new Map();
  errores = [];          // console errors and uncaught exceptions of the page

  alMensaje(m) {
    if (m.id) {
      const p = this.pendientes.get(m.id);
      this.pendientes.delete(m.id);
      if (m.error) p?.mal(new Error(`${m.error.message} (${p.metodo})`));
      else p?.ok(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      this.errores.push(d.exception?.description || d.text);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      this.errores.push(m.params.args.map(a => a.value ?? a.description).join(' '));
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      this.errores.push(`${m.params.entry.text} ${m.params.entry.url || ''}`.trim());
    }
  }

  cmd(metodo, params = {}) {
    const id = ++this.n;
    this.ws.send(JSON.stringify({ id, method: metodo, params }));
    return new Promise((ok, mal) => this.pendientes.set(id, { ok, mal, metodo }));
  }

  // Evaluates an expression in the page (awaiting promises) and returns its value as JSON
  async evaluar(expr) {
    const r = await this.cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  // Waits until `expr` is truthy in the page
  async esperarA(expr, ms = 20000) {
    const fin = Date.now() + ms;
    for (;;) {
      try { if (await this.evaluar(expr)) return; } catch {}
      if (Date.now() > fin) throw new Error(`timed out waiting for: ${expr}`);
      await esperar(100);
    }
  }

  async ir(url) {
    const cargada = new Promise(ok => {
      const prev = this.alMensaje.bind(this);
      this.alMensaje = m => { prev(m); if (m.method === 'Page.loadEventFired') { this.alMensaje = prev; ok(); } };
    });
    await this.cmd('Page.navigate', { url });
    await cargada;
  }

  async captura(ancho = 1400, alto = 900) {
    await this.cmd('Emulation.setDeviceMetricsOverride', { width: ancho, height: alto, deviceScaleFactor: 1, mobile: ancho < 600 });
    const { data } = await this.cmd('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(data, 'base64');
  }

  cerrar() { this.ws.close(); }
}
