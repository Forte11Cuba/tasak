// Helpers to check the site in headless Chrome over the DevTools protocol (CDP), with no
// dependencies (Node >= 22: native WebSocket and fetch): a static server for the site, Chrome, and
// a page to drive (evaluate JS, collect console errors, take screenshots).
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

// Serves the folder `root` on 127.0.0.1. `overrides` maps a path (e.g. '/config.js') to the content
// served instead of the file on disk; `mounts` maps a path prefix (e.g. '/shared/') to another folder
export function serve(root, overrides = {}, mounts = {}) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path in overrides) {
      res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'text/plain' });
      return res.end(overrides[path]);
    }
    const prefix = Object.keys(mounts).find(p => path.startsWith(p));
    const base = prefix ? mounts[prefix] : root;
    const rel = prefix ? '/' + path.slice(prefix.length) : path === '/' ? '/index.html' : path;
    const file = join(base, normalize(rel));
    if (!file.startsWith(base) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
  })));
}

// Starts headless Chrome (CHROME = path of the binary; default google-chrome)
export async function openChrome(args = []) {
  const profile = mkdtempSync(join(tmpdir(), 'tasak-chrome-'));
  const proc = spawn(process.env.CHROME || 'google-chrome', [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', ...args,
  ], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) { proc.kill(); throw new Error('Chrome did not start (set CHROME to its path)'); }
  const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
  return {
    port,
    async newPage() {
      const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
      return Page.connect((await res.json()).webSocketDebuggerUrl);
    },
    close() {
      proc.kill();
      try { rmSync(profile, { recursive: true, force: true }); } catch {}
    },
  };
}

export class Page {
  static async connect(url) {
    const p = new Page();
    p.ws = new WebSocket(url);
    await new Promise((ok, fail) => { p.ws.onopen = ok; p.ws.onerror = fail; });
    p.ws.onmessage = m => p.onMessage(JSON.parse(m.data));
    await p.cmd('Runtime.enable');
    await p.cmd('Page.enable');
    await p.cmd('Log.enable');
    return p;
  }

  n = 0;
  pending = new Map();
  errors = [];          // console errors and uncaught exceptions of the page

  onMessage(m) {
    if (m.id) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p?.fail(new Error(`${m.error.message} (${p.method})`));
      else p?.ok(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      this.errors.push(d.exception?.description || d.text);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      this.errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      this.errors.push(`${m.params.entry.text} ${m.params.entry.url || ''}`.trim());
    }
  }

  cmd(method, params = {}) {
    const id = ++this.n;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, fail) => this.pending.set(id, { ok, fail, method }));
  }

  // Evaluates an expression in the page (awaiting promises) and returns its value as JSON
  async evaluate(expr) {
    const r = await this.cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  // Waits until `expr` is truthy in the page
  async waitFor(expr, ms = 20000) {
    const end = Date.now() + ms;
    for (;;) {
      try { if (await this.evaluate(expr)) return; } catch {}
      if (Date.now() > end) throw new Error(`timed out waiting for: ${expr}`);
      await sleep(100);
    }
  }

  async goto(url) {
    const loaded = new Promise(ok => {
      const prev = this.onMessage.bind(this);
      this.onMessage = m => { prev(m); if (m.method === 'Page.loadEventFired') { this.onMessage = prev; ok(); } };
    });
    await this.cmd('Page.navigate', { url });
    await loaded;
  }

  async screenshot(width = 1400, height = 900) {
    await this.cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    const { data } = await this.cmd('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(data, 'base64');
  }

  close() { this.ws.close(); }
}
