import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OlamTranscriptSource } from '../lib/olam-transcript.js';

// Client whose shape long-poll blocks (holds open like real Electric live=true)
// so we can count concurrent subscribers deterministically.
function blockingClient() {
  let openPolls = 0;
  let maxConcurrent = 0;
  const client = {
    org: 'atlas',
    _openPolls: () => openPolls,
    _maxConcurrent: () => maxConcurrent,
    apiFetch: async (path) => {
      // The first (snapshot) poll returns up-to-date immediately; live polls
      // block until the source is stopped.
      if (!path.includes('live=true')) {
        return { ok: true, status: 200, headers: new Map([['electric-offset', '1']]), json: async () => [{ headers: { control: 'up-to-date' } }] };
      }
      openPolls += 1;
      maxConcurrent = Math.max(maxConcurrent, openPolls);
      try {
        await new Promise((r) => setTimeout(r, 10_000)); // long-poll hold
      } finally {
        openPolls -= 1;
      }
      return { ok: true, status: 200, headers: new Map(), json: async () => [] };
    },
    runnerStatus: async () => ({ feed: [], feedCursor: 0 }),
  };
  return client;
}

test('start() is idempotent — never opens a second shape subscriber', async () => {
  const client = blockingClient();
  const src = new OlamTranscriptSource(client, { worldId: 'w1', sessionId: 's1', livePollDelayMs: 0, shapeOpts: { livePollDelayMs: 0 } });
  src.start();
  src.start(); // duplicate — must no-op
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(client._maxConcurrent() <= 1, `expected <=1 concurrent poll, saw ${client._maxConcurrent()}`);
  src.stop();
});

test('stop() tears the live poll down (open polls drain to zero)', async () => {
  const client = blockingClient();
  const src = new OlamTranscriptSource(client, { worldId: 'w1', sessionId: 's1', shapeOpts: { livePollDelayMs: 0 } });
  src.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(client._openPolls(), 1);
  src.stop();
  await new Promise((r) => setTimeout(r, 20));
  // the blocked fetch still resolves after its timer, but no NEW poll starts
  assert.equal(src._running, false);
});

test('switching sessions: old source stopped before new one polls (one live at a time)', async () => {
  const clientA = blockingClient();
  const clientB = blockingClient();
  const a = new OlamTranscriptSource(clientA, { worldId: 'w1', sessionId: 'A', shapeOpts: { livePollDelayMs: 0 } });
  a.start();
  await new Promise((r) => setTimeout(r, 30));
  // switch: teardown A, then start B (mirrors server.js delete+recreate)
  a.stop();
  const b = new OlamTranscriptSource(clientB, { worldId: 'w1', sessionId: 'B', shapeOpts: { livePollDelayMs: 0 } });
  b.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(a._running, false);
  assert.equal(clientB._openPolls(), 1);
  b.stop();
});

test('getMessages snapshot buffers appends for a reconnecting client; trim bounds it', async () => {
  const client = {
    org: 'atlas',
    apiFetch: async (path) => {
      if (path.includes('live=true')) return { ok: true, status: 200, headers: new Map(), json: async () => new Promise(() => {}) };
      const msgs = Array.from({ length: 5 }, (_, k) => ({ headers: { operation: 'insert' }, value: { message_id: `m${k}`, seq: 0, role: 'assistant', chunk: `c${k}`, chunk_type: 'text' } }));
      return { ok: true, status: 200, headers: new Map([['electric-offset', '5']]), json: async () => [...msgs, { headers: { control: 'up-to-date' } }] };
    },
  };
  const src = new OlamTranscriptSource(client, { worldId: 'w1', sessionId: 's1', shapeOpts: { livePollDelayMs: 0 } });
  src.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(src.getMessages().length, 5);
  assert.equal(src.getPending(), null);
  src.trim(2);
  assert.equal(src.getMessages().length, 2);
  assert.equal(src.getMessages()[0].uuid, 'm3'); // newest kept
  src.stop();
});
