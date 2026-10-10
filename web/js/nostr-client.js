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
          });
        } else if (d[0] === 'EOSE' || d[0] === 'CLOSED') end();
      };
      ws.onerror = end;
      ws.onclose = end;
    }
  });
}
