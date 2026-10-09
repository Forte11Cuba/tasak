// What the checks in tools/ simulate in the page, before any of its scripts: the clock (FIX.now), relays
// holding FIX.events, Coinbase (FIX.btcusd), Yadio (FIX.yadio) and the server's snapshot (FIX.snapshot;
// without it, the site has no server). Nothing leaves the machine.
// Runs in the page, so it can't use anything outside its own body
export function simulation(FIX) {
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
    // The server's snapshot; without FIX.snapshot, a site without its server, whatever web/api/ holds
    if (u.origin === location.origin && u.pathname.endsWith('/api/snapshot.json')) {
      return FIX.snapshot ? json(FIX.snapshot) : new Response('', { status: 404 });
    }
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
