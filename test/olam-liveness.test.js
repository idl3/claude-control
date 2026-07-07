import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LivenessCache } from '../lib/olam-liveness.js';

test('get() calls the fetcher exactly once per miss and caches the result', async () => {
  let calls = 0;
  const cache = new LivenessCache();
  const fetcher = async () => { calls += 1; return { state: 'live' }; };
  const a = await cache.get('id1', fetcher);
  const b = await cache.get('id1', fetcher);
  assert.deepEqual(a, { state: 'live' });
  assert.deepEqual(b, { state: 'live' });
  assert.equal(calls, 1); // second call served from cache, fetcher never re-invoked
});

test('get() re-fetches once the TTL window has elapsed', async () => {
  let calls = 0;
  let now = 1000;
  const cache = new LivenessCache({ ttlMs: 4000, now: () => now });
  const fetcher = async () => { calls += 1; return { state: 'dormant', tick: calls }; };
  await cache.get('id1', fetcher);
  now += 3999; // still inside TTL
  await cache.get('id1', fetcher);
  assert.equal(calls, 1);
  now += 2; // now 4001ms since the first fetch — TTL expired
  const third = await cache.get('id1', fetcher);
  assert.equal(calls, 2);
  assert.equal(third.tick, 2);
});

test('distinct ids never share a cache entry', async () => {
  const cache = new LivenessCache();
  await cache.get('olam:atlas:s1', async () => ({ state: 'live' }));
  await cache.get('olam:atlas:s2', async () => ({ state: 'dormant' }));
  assert.equal(cache.peek('olam:atlas:s1').liveness.state, 'live');
  assert.equal(cache.peek('olam:atlas:s2').liveness.state, 'dormant');
});

test('peek() returns null for an unfetched id, the entry (regardless of freshness) once fetched', async () => {
  const cache = new LivenessCache({ ttlMs: 10 });
  assert.equal(cache.peek('id1'), null);
  await cache.get('id1', async () => ({ state: 'live' }));
  assert.ok(cache.peek('id1'));
  assert.equal(cache.peek('id1').liveness.state, 'live');
});

test('invalidate() forces the next get() to re-fetch even inside the TTL window', async () => {
  let calls = 0;
  const cache = new LivenessCache({ ttlMs: 60_000 });
  const fetcher = async () => { calls += 1; return { state: 'live' }; };
  await cache.get('id1', fetcher);
  cache.invalidate('id1');
  await cache.get('id1', fetcher);
  assert.equal(calls, 2);
});

test('clear() drops every cached entry', async () => {
  const cache = new LivenessCache();
  await cache.get('id1', async () => ({ state: 'live' }));
  await cache.get('id2', async () => ({ state: 'dormant' }));
  cache.clear();
  assert.equal(cache.peek('id1'), null);
  assert.equal(cache.peek('id2'), null);
});
