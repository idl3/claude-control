import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ShapeSubscriber, chunksToMessages, DegradedRequired } from '../lib/olam-transcript.js';

// --- B2: chunksToMessages -------------------------------------------------------

function row(over = {}) {
  return {
    world_id: 'w1', session_id: 's1', message_id: 'm1', seq: 0,
    actor_id: 'a', actor_type: 'agent', role: 'assistant',
    chunk: 'hello', chunk_type: 'text', created_at: '2026-07-02T00:00:00Z',
    ...over,
  };
}

test('groups seq-ordered chunks into one message per message_id', () => {
  const msgs = chunksToMessages([
    row({ message_id: 'm1', seq: 0, chunk: 'Hello ' }),
    row({ message_id: 'm1', seq: 1, chunk: 'world' }),
    row({ message_id: 'm2', seq: 0, chunk: 'next', role: 'user', actor_type: 'operator' }),
  ]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].uuid, 'm1');
  assert.equal(msgs[0].role, 'assistant');
  assert.deepEqual(msgs[0].blocks.map((b) => b.text), ['Hello ', 'world']);
  assert.equal(msgs[1].role, 'user'); // role=user maps to user side
});

test('tool_use chunk becomes a tool_use block with parsed name/input', () => {
  const [m] = chunksToMessages([
    row({ chunk_type: 'tool_use', chunk: JSON.stringify({ name: 'Bash', input: { command: 'ls' } }) }),
  ]);
  const b = m.blocks[0];
  assert.equal(b.kind, 'tool_use');
  assert.equal(b.name, 'Bash');
  assert.deepEqual(b.input, { command: 'ls' });
});

test('unparseable tool_use falls back to raw input, never throws', () => {
  const [m] = chunksToMessages([row({ chunk_type: 'tool_use', chunk: 'not json' })]);
  assert.equal(m.blocks[0].kind, 'tool_use');
  assert.deepEqual(m.blocks[0].input, { raw: 'not json' });
});

test('goal_mode_assumption → thinking block; agent_exit → warning text', () => {
  const [a] = chunksToMessages([row({ chunk_type: 'goal_mode_assumption', chunk: 'assumed X' })]);
  assert.equal(a.blocks[0].kind, 'thinking');
  const [b] = chunksToMessages([row({ message_id: 'm9', chunk_type: 'agent_exit', chunk: 'code 143' })]);
  assert.match(b.blocks[0].text, /agent_exit: code 143/);
});

test('empty-text chunks produce no block; message with zero blocks is dropped', () => {
  const msgs = chunksToMessages([row({ chunk: '', chunk_type: 'text' })]);
  assert.deepEqual(msgs, []);
});

test('malformed rows (missing message_id) are skipped, not fatal', () => {
  const msgs = chunksToMessages([{ chunk: 'x', chunk_type: 'text' }, row({ chunk: 'ok' })]);
  assert.equal(msgs.length, 1);
});

// --- B1: ShapeSubscriber --------------------------------------------------------

/** Fake OlamOrgClient.apiFetch: scripted responses keyed by call index. */
function clientWith(responses) {
  let i = 0;
  return {
    org: 'atlas',
    apiFetch: async (path) => {
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return {
        ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
        status: r.status ?? 200,
        headers: new Map(Object.entries(r.headers ?? {})),
        json: async () => r.body ?? [],
        _path: path,
      };
    },
    _calls: () => i,
  };
}

const insert = (value) => ({ headers: { operation: 'insert' }, key: value.message_id + value.seq, value });
const upToDate = { headers: { control: 'up-to-date' } };

test('drains snapshot to up-to-date, emitting mapped messages', async () => {
  const client = clientWith([
    { headers: { 'electric-offset': '10', 'electric-handle': 'h1' }, body: [insert(row({ chunk: 'a' })), upToDate] },
    // live poll — never resolves in this test; stop after first append
  ]);
  const sub = new ShapeSubscriber(client, { worldId: 'w1', sessionId: 's1' });
  const appended = [];
  sub.on('append', (m) => { appended.push(...m); sub.stop(); });
  await sub.start();
  assert.equal(appended.length, 1);
  assert.equal(appended[0].blocks[0].text, 'a');
});

test('offset + handle from response headers ride the next request', async () => {
  let secondPath = null;
  let i = 0;
  const client = {
    org: 'atlas',
    apiFetch: async (path) => {
      i += 1;
      if (i === 1) {
        return { ok: true, status: 200, headers: new Map([['electric-offset', '42'], ['electric-handle', 'H']]), json: async () => [upToDate] };
      }
      secondPath = path;
      const sub2 = new URLSearchParams(path.split('?')[1]);
      // stop the loop
      return { ok: true, status: 200, headers: new Map(), json: async () => { queueMicrotask(() => {}); return []; }, _sub: sub2 };
    },
  };
  const sub = new ShapeSubscriber(client, { worldId: 'w1', sessionId: 's1', livePollDelayMs: 5 });
  sub.on('append', () => {});
  const p = sub.start();
  await new Promise((r) => setTimeout(r, 20));
  sub.stop();
  await p;
  assert.match(secondPath, /offset=42/);
  assert.match(secondPath, /handle=H/);
  assert.match(secondPath, /live=true/);
});

test('409 resets handle/offset (shape rehydrate), does not crash', async () => {
  const client = clientWith([
    { status: 409 },
    { headers: { 'electric-offset': '0', 'electric-handle': 'h2' }, body: [insert(row({ chunk: 'after-reset' })), upToDate] },
  ]);
  const sub = new ShapeSubscriber(client, { worldId: 'w1', sessionId: 's1' });
  const seen = [];
  sub.on('append', (m) => { seen.push(...m); sub.stop(); });
  await sub.start();
  assert.equal(seen[0].blocks[0].text, 'after-reset');
});

test('auth failure emits degraded (typed), never error', async () => {
  const client = clientWith([{ status: 401 }]);
  const sub = new ShapeSubscriber(client, { worldId: 'w1', sessionId: 's1' });
  let degradedReason = null;
  let errored = false;
  sub.on('degraded', (r) => { degradedReason = r; });
  sub.on('error', () => { errored = true; });
  await sub.start();
  assert.match(degradedReason, /shape auth 401/);
  assert.equal(errored, false);
});

test('apiFetch throwing (network) also degrades, not crashes', async () => {
  const client = { org: 'atlas', apiFetch: async () => { throw new Error('network down'); } };
  const sub = new ShapeSubscriber(client, { worldId: 'w1', sessionId: 's1' });
  let reason = null;
  sub.on('degraded', (r) => { reason = r; });
  await sub.start();
  assert.match(reason, /network down/);
});

test('bounded backfill caps the initial replay to backfillCap rows', async () => {
  const many = Array.from({ length: 50 }, (_, k) => insert(row({ message_id: `m${k}`, chunk: `c${k}` })));
  const client = clientWith([{ headers: { 'electric-offset': '1' }, body: [...many, upToDate] }]);
  const sub = new ShapeSubscriber(client, { worldId: 'w1', sessionId: 's1', backfillCap: 10 });
  const seen = [];
  sub.on('append', (m) => { seen.push(...m); sub.stop(); });
  await sub.start();
  assert.equal(seen.length, 10); // last 10 of 50
  assert.equal(seen[0].uuid, 'm40');
});
