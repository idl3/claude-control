import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db.js';
import * as agentsCore from '../src/core/agents.js';
import { send, poll } from '../src/core/messages.js';

function freshDb(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(dir, 'collab.db');
  const db = openDb(dbPath);
  return { dir, db };
}

test('direct + broadcast delivery: recipient sees both, others see only the broadcast', () => {
  const { dir, db } = freshDb('collab-message-');
  try {
    agentsCore.register(db, { harness: 'test', agentId: 'a' });
    agentsCore.register(db, { harness: 'test', agentId: 'b' });

    const direct = send(db, { agentId: 'a', to: 'b', body: 'direct to b' });
    const broadcast = send(db, { agentId: 'a', body: 'broadcast to all' });

    const bInbox = poll(db, { agentId: 'b' });
    assert.equal(bInbox.messages.length, 2);
    assert.deepEqual(
      bInbox.messages.map((m) => m.id).sort((x, y) => x - y),
      [direct.messageId, broadcast.messageId].sort((x, y) => x - y),
    );

    const aInbox = poll(db, { agentId: 'a' });
    assert.equal(aInbox.messages.length, 1, 'A only sees the broadcast, not its own direct-to-B message');
    assert.equal(aInbox.messages[0]!.id, broadcast.messageId);
    assert.equal(aInbox.messages[0]!.toAgent, null);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ack via poll({ack_through}) advances the cursor; re-poll returns nothing new', () => {
  const { dir, db } = freshDb('collab-message-ack-');
  try {
    agentsCore.register(db, { harness: 'test', agentId: 'a' });
    agentsCore.register(db, { harness: 'test', agentId: 'b' });

    const m1 = send(db, { agentId: 'a', to: 'b', body: 'msg 1' });
    const m2 = send(db, { agentId: 'a', to: 'b', body: 'msg 2' });

    const first = poll(db, { agentId: 'b' });
    assert.equal(first.messages.length, 2);
    assert.equal(first.cursor, 0);

    const acked = poll(db, { agentId: 'b', ackThrough: m2.messageId });
    assert.equal(acked.cursor, m2.messageId);
    assert.equal(acked.messages.length, 0, 'nothing new after acking through the latest message');

    const m3 = send(db, { agentId: 'a', to: 'b', body: 'msg 3' });
    const afterNewMessage = poll(db, { agentId: 'b' });
    assert.equal(afterNewMessage.messages.length, 1);
    assert.equal(afterNewMessage.messages[0]!.id, m3.messageId);
    void m1;
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('at-least-once: an unacked message redelivers on every poll', () => {
  const { dir, db } = freshDb('collab-message-redeliver-');
  try {
    agentsCore.register(db, { harness: 'test', agentId: 'a' });
    agentsCore.register(db, { harness: 'test', agentId: 'b' });

    const m1 = send(db, { agentId: 'a', to: 'b', body: 'msg 1' });

    const poll1 = poll(db, { agentId: 'b' });
    assert.equal(poll1.messages.length, 1);
    assert.equal(poll1.messages[0]!.id, m1.messageId);

    // No ack_through given -> cursor unchanged -> message redelivers.
    const poll2 = poll(db, { agentId: 'b' });
    assert.equal(poll2.messages.length, 1);
    assert.equal(poll2.messages[0]!.id, m1.messageId);

    const poll3 = poll(db, { agentId: 'b' });
    assert.equal(poll3.messages.length, 1, 'still redelivers a third time with no ack');

    // Now ack, and it stops redelivering.
    const acked = poll(db, { agentId: 'b', ackThrough: m1.messageId });
    assert.equal(acked.messages.length, 0);
    const poll4 = poll(db, { agentId: 'b' });
    assert.equal(poll4.messages.length, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
