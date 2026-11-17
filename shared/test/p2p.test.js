import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseP2P, parseDeletion, isDeleted, newerDoc, assetId, p2pPmKeys, p2pTrades, p2pBook, p2pAssets,
  p2pMostUsedFiat, p2pPmStats, isAvailable, defaultP2PMethod,
} from '../p2p.js';
import { lastTasaK } from '../rate.js';

const PK = 'aa'.repeat(32);
let n = 0;
// An event of the platform as the NIP shows it: an internal balance against CUP. `tags` replace or
// add tags (a null value removes it)
function ev(z, tags = {}, { pubkey = PK, created_at = 1000, kind = 35353, extra = [] } = {}) {
  const base = z === 'trade'
    ? { d: 't' + n, k: 'sell', c: 'qusd', layer: 'internal', network: 'mainnet', f: 'CUP', amt: '10', fa: '4000', executed_at: String(created_at - 60), pm: 'bank transfer', y: 'example', z }
    : { d: 'o' + n, k: 'sell', c: 'qusd', layer: 'internal', network: 'mainnet', f: 'CUP', s: 'pending', amt: '0', fa: ['100', '5000'], price: '410', pm: ['bank transfer', 'cash'], y: 'example', z };
  const all = { ...base, ...tags };
  return {
    id: (n++).toString(16).padStart(64, '0'), pubkey, created_at, kind, content: '', sig: '',
    tags: [...Object.entries(all).filter(([, v]) => v != null).map(([k, v]) => [k, ...[].concat(v)]), ...extra],
  };
}

test('a trade that follows the NIP: price fa ÷ amt, asset identity, methods as published', () => {
  const d = parseP2P(ev('trade', { executed_at: '900' }));
  assert.equal(d.doc, 'trade');
  assert.equal(d.asset, `internal:${PK}:mainnet:qusd`);
  assert.deepEqual([d.amt, d.fa, d.executedAt, d.pmKeys], [10, [4000], 900, ['bank transfer']]);
  const [tr] = p2pTrades([d], new Map(), { asset: d.asset, fiat: 'CUP', pmSel: null });
  assert.deepEqual([tr.ts, tr.price, tr.size, tr.publishedAt], [900, 400, 4000, 1000]);
});

test('asset identity: tokens by contract, native assets and internal balances by ticker', () => {
  const base = { layer: 'trx', network: 'mainnet', c: 'usdt', pubkey: PK };
  assert.equal(assetId({ ...base, contract: 'TR7NHq' }), 'trx:mainnet:TR7NHq');
  assert.equal(assetId({ ...base, layer: 'sol', c: 'sol', contract: null }), 'sol:mainnet:sol');
  assert.equal(assetId({ ...base, layer: 'internal', contract: null }), `internal:${PK}:mainnet:usdt`);
  // The same internal ticker on two platforms is not the same asset
  const other = parseP2P(ev('trade', {}, { pubkey: 'bb'.repeat(32) }));
  assert.notEqual(other.asset, parseP2P(ev('trade')).asset);
});

test('trades that don\'t follow the NIP are ignored', () => {
  const bad = {
    'no executed_at': { executed_at: null },
    'executed after created_at': { executed_at: '1001' },
    'amount 0': { amt: '0' },
    'two fiat amounts': { fa: ['1', '2'] },
    'not a decimal': { fa: '1e3' },
    'negative': { amt: '-1' },
    'empty value': { pm: '' },
    'unknown side': { k: 'swap' },
    'uppercase ticker': { c: 'QUSD' },
    'contract on internal': { contract: 'x' },
    'with expiration': { expiration: '2000' },
    'missing y': { y: null },
    'order of another platform': { a: `35353:${'bb'.repeat(32)}:o1` },
  };
  for (const [note, tags] of Object.entries(bad)) assert.equal(parseP2P(ev('trade', tags)), null, note);
  assert.equal(parseP2P(ev('trade', {}, { extra: [['fa', '5']] })), null, 'repeated tag');
  assert.equal(parseP2P(ev('trade', { contract: '0xAB', layer: 'eth' })), null, 'EVM contract not lowercase');
  assert.equal(parseP2P(ev('other')), null, 'unknown z');
  assert.equal(parseP2P(ev('trade', {}, { kind: 38383 })), null, 'another kind');
  // Unknown tags, a non-empty content and an optional `a` of its own are fine
  const ok = ev('trade', { a: `35353:${PK}:o1` }, { extra: [['x', 'y'], ['x', 'z']] });
  ok.content = 'hi';
  assert.equal(parseP2P(ok).order, `35353:${PK}:o1`);
});

test('open orders are checked; the others only replace them', () => {
  const o = parseP2P(ev('order'));
  assert.deepEqual([o.status, o.fa, o.price, o.premium, o.pmKeys], ['pending', [100, 5000], 410, null, ['bank transfer', 'cash']]);
  assert.equal(parseP2P(ev('order', { premium: '2' })), null, 'price and premium');
  assert.equal(parseP2P(ev('order', { price: null })), null, 'neither price nor premium');
  assert.equal(parseP2P(ev('order', { price: null, premium: '-100' })), null, 'premium −100');
  assert.equal(parseP2P(ev('order', { price: null, premium: '-2.5' })).premium, -2.5);
  assert.equal(parseP2P(ev('order', { fa: ['5000', '100'] })), null, 'minimum above maximum');
  assert.equal(parseP2P(ev('order', { pm: null })), null, 'without methods');
  // A closed order that keeps its last amounts (fa of two values not 0) still replaces the open one
  const closed = parseP2P(ev('order', { s: 'canceled', fa: ['60', '120'], price: null }));
  assert.deepEqual([closed.doc, closed.status], ['order', 'canceled']);
  assert.equal(parseP2P(ev('order', { s: 'gone' })), null, 'unknown status');
});

test('versions: latest created_at, then greatest id', () => {
  const v = (ts, id) => ({ ts, ev: { id } });
  assert.equal(newerDoc(v(2, 'a'), v(1, 'b')), true);
  assert.equal(newerDoc(v(1, 'b'), v(1, 'a')), true);
  assert.equal(newerDoc(v(1, 'a'), v(1, 'b')), false);
});

test('deletions (NIP-09): own addresses with k = 35353, up to their created_at', () => {
  const del = (tags, pubkey = PK) => ({ kind: 5, pubkey, created_at: 1500, tags });
  assert.deepEqual(parseDeletion(del([['a', `35353:${PK}:t1`], ['k', '35353']])), [{ key: `${PK}:t1`, ts: 1500 }]);
  assert.deepEqual(parseDeletion(del([['a', `35353:${PK}:t1`]])), [], 'without k');
  assert.deepEqual(parseDeletion(del([['a', `35353:${'bb'.repeat(32)}:t1`], ['k', '35353']])), [], 'another author');
  const deletions = new Map([[`${PK}:t1`, 1500]]);
  assert.equal(isDeleted({ key: `${PK}:t1`, ts: 1400 }, deletions), true);
  assert.equal(isDeleted({ key: `${PK}:t1`, ts: 1600 }, deletions), false, 'a later version');
  assert.equal(isDeleted({ key: `${PK}:t2`, ts: 1400 }, deletions), false);
});

test('rate per asset and currency: no mixing, the platform\'s own count, the deleted don\'t', () => {
  const docs = [
    ev('trade', { fa: '4000', executed_at: '100' }, { created_at: 200 }),
    ev('trade', { fa: '4200', executed_at: '300' }, { created_at: 300 }),
    ev('trade', { fa: '3000', executed_at: '400', maker: 'platform' }, { created_at: 400 }),
    ev('trade', { fa: '45', f: 'USD', executed_at: '400' }, { created_at: 400 }),
    ev('trade', { fa: '10', c: 'usdt', layer: 'trx', contract: 'TR7', executed_at: '400' }, { created_at: 400 }),
    ev('trade', { fa: '9999', executed_at: '450' }, { created_at: 450 }),
  ].map(parseP2P);
  const deletions = new Map([[docs[5].key, 500]]);
  const filters = { asset: docs[0].asset, fiat: 'CUP', pmSel: null };
  const trades = p2pTrades(docs, deletions, filters);
  assert.deepEqual(trades.map(t => t.price), [400, 420, 300]);
  assert.equal(lastTasaK(trades, 1000).rate, (400 * 4000 + 420 * 4200 + 300 * 3000) / 11200);
  assert.deepEqual(p2pAssets(docs, deletions, 'CUP', 1000).map(a => [a.c, a.trades]), [['qusd', 3], ['usdt', 1]]);
  assert.equal(p2pMostUsedFiat(docs, deletions, 1000), 'CUP');
});

test('order book: only available orders, by price; premium orders without price go last', () => {
  const now = 2000;
  const docs = [
    ev('order', { price: '420' }),
    ev('order', { price: '410' }),
    ev('order', { price: null, premium: '1' }),
    ev('order', { price: '400', expires_at: '1999' }),
    ev('order', { price: '400', expiration: '2000' }),
    ev('order', { k: 'buy', price: '390' }),
    ev('order', { k: 'buy', price: '395', pm: 'zelle' }),
    ev('order', { s: 'paused' }),
  ].map(parseP2P);
  const book = p2pBook(docs, new Map(), { asset: docs[0].asset, fiat: 'CUP', pmSel: null }, now);
  assert.deepEqual(book.asks.map(o => o.price), [410, 420, null]);
  assert.deepEqual(book.bids.map(o => o.price), [395, 390]);
  assert.equal(book.asks[0].size, 5000);
  assert.equal(isAvailable(docs[7], now), false, 'paused');
  const sel = new Set(['cash']);
  assert.deepEqual(p2pBook(docs, new Map(), { asset: docs[0].asset, fiat: 'CUP', pmSel: sel }, now).bids.map(o => o.price), [390]);
  assert.deepEqual(p2pPmStats(docs, new Map(), { asset: docs[0].asset, fiat: 'CUP' }, now),
    [{ key: 'bank transfer', done: 0, open: 4 }, { key: 'cash', done: 0, open: 4 }, { key: 'zelle', done: 0, open: 1 }]);
});

test('payment methods: each value as published, test orders detected by their text', () => {
  assert.deepEqual(p2pPmKeys(['etecsa mobile balance', 'bank transfer']), ['etecsa mobile balance', 'bank transfer']);
  assert.deepEqual(p2pPmKeys(['Prueba, no tomar']), ['Pruebas']);
  assert.deepEqual(p2pPmKeys([]), ['Sin método']);
});

test('one method at a time: the most traded one that isn\'t hidden, by default', () => {
  const stats = [{ key: 'etecsa mobile balance', done: 9 }, { key: 'bank transfer', done: 5 }, { key: 'cash', done: 1 }];
  assert.equal(defaultP2PMethod(stats, () => false), 'etecsa mobile balance');
  assert.equal(defaultP2PMethod(stats, k => k === 'etecsa mobile balance'), 'bank transfer');
  assert.equal(defaultP2PMethod(stats, () => true), 'etecsa mobile balance', 'all hidden: the first one');
  assert.equal(defaultP2PMethod([], () => false), null);
  // A trade of one method doesn't count in another's rate
  const docs = [ev('trade', { fa: '3000', pm: 'etecsa mobile balance' }), ev('trade', { fa: '11000', pm: 'bank transfer' })].map(parseP2P);
  const one = pm => p2pTrades(docs, new Map(), { asset: docs[0].asset, fiat: 'CUP', pmSel: new Set([pm]) }).map(t => t.price);
  assert.deepEqual([one('etecsa mobile balance'), one('bank transfer')], [[300], [1100]]);
});
