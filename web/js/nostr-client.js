// Connection to the node's relays. Each relay is asked for the history, page by page backwards with
// `until` (relays limit the events per query) until a page comes back empty, and then for what is
// new, live; it reconnects with a growing wait. Only events of the node, of the kinds asked for and
// with a valid signature are handed over.
const PAGE = 300;

// urls, authors: relays and node pubkeys; kinds: kinds paged through (orders); metaFilters: other
// events of the node asked for in one query, as filters without authors (e.g. { kinds: [0] } or
// { kinds: [30078], '#d': ['mostro-rates'] }); verify(ev): signature check, or null if nostr-tools didn't
// load; has(id): whether the event is already known (it isn't checked again); onEvent(ev, live):
// returns true if the event changed something; onUpdate(): something changed (live, or at the end
// of the history of a relay); onStatus(): a relay went live or was lost
export function createRelayPool({ urls, authors, kinds, metaFilters, verify, has, onEvent, onUpdate, onStatus }) {
  const authorSet = new Set(authors);
  const metas = metaFilters.map(f => ({ ...f, authors }));
  // Whether an event matches a filter: its kinds and its tag conditions ('#d': […])
  const matches = (ev, f) => f.kinds.includes(ev.kind) && Object.keys(f).filter(k => k[0] === '#')
    .every(k => ev.tags.some(t => t[0] === k.slice(1) && f[k].includes(t[1])));
  const pool = {
    live: 0,       // relays with the history loaded and subscribed live
    rejected: 0,   // events with an invalid signature
    newest: 0,     // created_at of the newest event of `kinds` received
    // Ask the relays only for what is newer than this (unix s; 0 = their whole history): with the server's
    // snapshot, the older history comes from it
    historyFrom: 0,
    start: () => urls.forEach(url => connect(url)),
  };

  function accept(ev) {
    if (!ev || has(ev.id)) return false;
    if (!authorSet.has(ev.pubkey) || (!kinds.includes(ev.kind) && !metas.some(f => matches(ev, f)))) return false;
    // Without it, a relay could inject fake events with the node's pubkey
    if (verify && !verify(ev)) { pool.rejected++; return false; }
    if (kinds.includes(ev.kind)) pool.newest = Math.max(pool.newest, ev.created_at);
    return true;
  }

  function connect(url, attempt = 0) {
    let ws;
    try { ws = new WebSocket(url); } catch { return; }
    const base = { kinds, authors };
    // On reconnect we only ask for what is new; at first, from historyFrom or everything
    const since = pool.newest ? { since: pool.newest - 3600 } : pool.historyFrom ? { since: pool.historyFrom } : {};
    let page = 0, count = 0, oldest = Infinity, prevOldest = Infinity;
    let isLive = false, startedAt = 0, changed = false;
    const req = (id, extra) => ws.send(JSON.stringify(['REQ', id, { ...base, ...since, ...extra }]));

    ws.onopen = () => {
      startedAt = Math.floor(Date.now() / 1000);
      req('hist0', { limit: PAGE });
      // Profile, information and relays of the node, and the like
      ws.send(JSON.stringify(['REQ', 'meta', ...metas]));
    };
    ws.onmessage = onMessage;

    function onMessage(msg) {
      let d;
      try { d = JSON.parse(msg.data); } catch { return; }
      if (d[0] === 'EVENT') {
        // Only the page being asked counts for paging
        if (d[1] === 'hist' + page) { count++; oldest = Math.min(oldest, d[2]?.created_at ?? Infinity); }
        if (accept(d[2]) && onEvent(d[2], isLive)) {
          if (isLive) onUpdate();
          else changed = true;
        }
      } else if (d[0] === 'EOSE' && d[1] === 'meta') {
        ws.send(JSON.stringify(['CLOSE', 'meta']));
        if (isLive && changed) onUpdate();
      } else if (d[0] === 'EOSE' && d[1] === 'hist' + page) {
        ws.send(JSON.stringify(['CLOSE', d[1]]));
        if (count > 0 && oldest < prevOldest) {
          prevOldest = oldest;
          page++; count = 0;
          req('hist' + page, { limit: PAGE, until: oldest - 1 });
          return;
        }
        // Since we started asking for history, so nothing is lost if paging was slow
        ws.send(JSON.stringify(['REQ', 'live', { ...base, since: startedAt - 60 }, ...metas.map(f => ({ ...f, since: startedAt }))]));
        isLive = true;
        pool.live++;
        onStatus();
        if (changed) onUpdate();
      }
    }

    ws.onclose = () => {
      if (isLive) pool.live--;
      onStatus();
      // Back to the shortest wait only if it got to live; a relay that drops the connection before
      // (at once, or while paging) is retried less and less often
      const next = isLive ? 0 : attempt + 1;
      setTimeout(() => connect(url, next), Math.min(60000, 5000 * 2 ** next));
    };
    ws.onerror = () => ws.close();
  }

  return pool;
}

// The profiles (kind 0) of some pubkeys: pubkey -> { name, picture }, the newest of each. Only for the
// names in the node selector: one query per relay, closed at its end or after `ms`; checked like the
// rest (author, kind, signature)
export function fetchProfiles({ urls, authors, verify, ms = 8000 }) {
  return new Promise(done => {
    const found = new Map(), newest = new Map(), sockets = [];
    let left = urls.length;
    const finish = () => { clearTimeout(timer); sockets.forEach(ws => { try { ws.close(); } catch {} }); done(found); };
    const timer = setTimeout(finish, ms);
    if (!left || !authors.length) return finish();
    for (const url of urls) {
      let ws;
      try { ws = new WebSocket(url); } catch { if (--left === 0) finish(); continue; }
      sockets.push(ws);
      let ended = false;
      const end = () => { if (ended) return; ended = true; try { ws.close(); } catch {} if (--left === 0) finish(); };
      ws.onopen = () => ws.send(JSON.stringify(['REQ', 'profiles', { kinds: [0], authors }]));
      ws.onmessage = msg => {
        let d;
        try { d = JSON.parse(msg.data); } catch { return; }
        if (d[0] === 'EVENT' && d[1] === 'profiles') {
          const ev = d[2];
          if (ev?.kind !== 0 || !authors.includes(ev.pubkey) || (newest.get(ev.pubkey) || 0) >= ev.created_at) return;
          if (verify && !verify(ev)) return;
          let c;
          try { c = JSON.parse(ev.content); } catch { return; }
          newest.set(ev.pubkey, ev.created_at);
          found.set(ev.pubkey, {
            name: typeof c?.name === 'string' ? c.name : '',
            picture: typeof c?.picture === 'string' ? c.picture : '',
            nip05: typeof c?.nip05 === 'string' ? c.nip05 : '',
          });
        } else if (d[0] === 'EOSE' || d[0] === 'CLOSED') end();
      };
      ws.onerror = end;
      ws.onclose = end;
    }
  });
}

// Connection to the relays for a P2P platform (kind 35353): the whole history they keep of its trades,
// available orders and deletions, as with the nodes, and then what is new, live; its profile (kind 0)
// once. Each kind is paged backwards with `until` until a page comes back empty, at most PAGE events per
// query and with a pause between pages, since relays cut off clients that ask too fast. A relay that
// refuses the kind (CLOSED, e.g. «kind not allowed») is `refused`, not down: it isn't retried and doesn't
// count. Only events of `author`, of those kinds and with a valid signature are handed over
// (onEvent(ev, live)).
const PAGE_PAUSE = 1000;
export function createPlatformPool({ urls, author, verify, onEvent, onUpdate, onStatus }) {
  const pool = {
    live: 0,         // relays with the history loaded and subscribed live
    refused: 0,      // relays that don't accept kind 35353
    rejected: 0,     // events with an invalid signature
    total: urls.length,
    // Still loading: no relay has its history yet, or one that has events of the platform is still
    // paging through it (an empty relay finishing first doesn't mean there is nothing)
    get loading() { return pool.live === 0 || [...paging.values()].some(got => got > 0); },
    start: () => urls.forEach(url => connect(url)),
  };
  const paging = new Map();   // url -> events received from its history, while it pages
  const seen = new Set();
  let newest = 0;   // created_at of the newest kind 35353 accepted (author and signature checked)
  // Relays that got to the end of their history: on reconnecting, only what is newer. One that was cut
  // off while paging starts again from the beginning, or the older part would be lost
  const completed = new Set();
  // The history, one query after another: available orders first (a page or two: the relay keeps only
  // the newest version of each, so those still pending), so the order book doesn't wait for the trades;
  // then the trades and the deletions of its trades
  const HISTORY = [
    { kinds: [35353], '#z': ['order'], '#s': ['pending'] },
    { kinds: [35353], '#z': ['trade'] },
    { kinds: [5], '#k': ['35353'] },
  ];
  const accept = ev => {
    if (!ev || seen.has(ev.id) || ev.pubkey !== author || ![0, 5, 35353].includes(ev.kind)) return false;
    if (verify && !verify(ev)) { pool.rejected++; return false; }
    seen.add(ev.id);
    return true;
  };

  function connect(url, attempt = 0) {
    let ws;
    try { ws = new WebSocket(url); } catch { return; }
    let step = 0, page = 0, count = 0, fresh = 0, oldest = Infinity, until = null;
    let isLive = false, refused = false, changed = false, noDeletions = false;
    const got = new Set();   // ids of this connection's history
    const startedAt = Math.floor(Date.now() / 1000);
    // On reconnecting, only what is newer than what came, and every new version of the orders, not only
    // the pending ones: an order taken or canceled meanwhile must leave the book
    const resume = completed.has(url) && newest > 0;
    const since = resume ? { since: newest - 3600 } : {};
    const steps = resume ? [{ kinds: [35353], '#z': ['order'] }, ...HISTORY.slice(1)] : HISTORY;
    const sub = () => `h${step}-${page}`;
    const ask = () => {
      count = 0; fresh = 0; oldest = Infinity;
      ws.send(JSON.stringify(['REQ', sub(), { ...steps[step], authors: [author], ...since, limit: PAGE, ...(until ? { until } : {}) }]));
    };
    ws.onopen = () => {
      paging.set(url, 0);
      ws.send(JSON.stringify(['REQ', 'meta', { kinds: [0], authors: [author] }]));
      ask();
    };
    ws.onmessage = msg => {
      let d;
      try { d = JSON.parse(msg.data); } catch { return; }
      if (d[0] === 'EVENT') {
        if (d[1] === sub()) {
          count++;
          oldest = Math.min(oldest, d[2]?.created_at ?? Infinity);
          if (d[2]?.id && !got.has(d[2].id)) { got.add(d[2].id); fresh++; paging.set(url, (paging.get(url) || 0) + 1); }
        }
        if (!accept(d[2])) return;
        if (d[2].kind === 35353) newest = Math.max(newest, d[2].created_at);
        if (onEvent(d[2], isLive)) {
          if (isLive) onUpdate();
          else changed = true;
        }
      } else if (d[0] === 'EOSE' && d[1] === 'meta') {
        ws.send(JSON.stringify(['CLOSE', 'meta']));
      } else if (d[0] === 'EOSE' && d[1] === sub()) {
        ws.send(JSON.stringify(['CLOSE', d[1]]));
        // What came so far is shown while the rest loads
        if (changed) { changed = false; onUpdate(); }
        // The next page. Several events can share a second (a platform publishes in batches) and a page
        // can end in the middle of them: the next one asks again up to that second, included, and goes
        // below it only once it brings nothing new. Until a page comes back empty or with nothing new
        if (fresh > 0) { until = oldest; page++; }
        else if (count > 0 && until === oldest) { until = oldest - 1; page++; }
        else { step++; page = 0; until = null; }
        if (step < steps.length) { setTimeout(() => ws.readyState === 1 && ask(), PAGE_PAUSE); return; }
        goLive();
      } else if (d[0] === 'CLOSED' && d[1] !== 'meta') {
        // Too many queries: the same one again, later
        if (d[1] === sub() && /^rate-limited/i.test(d[2] || '')) { setTimeout(() => ws.readyState === 1 && ask(), 10 * PAGE_PAUSE); return; }
        // A deletion query refused (some relays don't index #k): the rest goes on without it, also live
        if (d[1] === sub() && step === 2) { noDeletions = true; step++; goLive(); return; }
        refused = true;
        pool.refused++;
        console.warn(url, 'refuses the platform events:', d[2]);
        ws.close();
      }
    };
    function goLive() {
      paging.delete(url);
      completed.add(url);
      ws.send(JSON.stringify(['REQ', 'live', { kinds: [35353], authors: [author], since: startedAt - 60 },
        ...(noDeletions ? [] : [{ kinds: [5], authors: [author], '#k': ['35353'], since: startedAt - 60 }])]));
      isLive = true;
      pool.live++;
      onStatus();
    }
    ws.onclose = () => {
      paging.delete(url);
      if (isLive) pool.live--;
      onStatus();
      if (refused) return;
      const next = isLive ? 0 : attempt + 1;
      setTimeout(() => connect(url, next), Math.min(60000, 5000 * 2 ** next));
    };
    ws.onerror = () => ws.close();
  }

  return pool;
}
