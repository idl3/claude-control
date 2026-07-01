import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Collab, safeRoomId, idleRecipients } from '../lib/collab.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'));
}
const A = { paneId: '%1', target: '0:1.0', kind: 'claude', title: 'Alice', sessionId: 'sa' };
const B = { paneId: '%2', target: '0:2.0', kind: 'codex', title: 'Bob', sessionId: 'sb' };

test('safeRoomId accepts slugs, rejects traversal', () => {
  assert.equal(safeRoomId('abc123'), 'abc123');
  assert.equal(safeRoomId('a-b-c'), 'a-b-c');
  assert.equal(safeRoomId('../etc/passwd'), null);
  assert.equal(safeRoomId('has/slash'), null);
  assert.equal(safeRoomId(''), null);
});

test('open → list → join → post → read cursor', () => {
  const c = new Collab({ dir: tmpDir() });
  const { roomId, code } = c.open(A, { topic: 'refactor' });
  assert.match(roomId, /^[a-z0-9]{6}$/);

  const open = c.listOpen();
  assert.equal(open.length, 1);
  assert.equal(open[0].topic, 'refactor');

  const joined = c.join(B, { code });
  assert.equal(joined.roomId, roomId);
  assert.equal(joined.members.length, 2);

  const { seq, recipients } = c.post(roomId, A, 'hello Bob');
  assert.equal(recipients.length, 1);
  assert.equal(recipients[0].paneId, '%2'); // only the OTHER member

  // B reads from cursor 0 → sees the join + message; re-reading from that seq is empty.
  const first = c.read(roomId, 0);
  const msg = first.messages.find((m) => m.type === 'message');
  assert.equal(msg.text, 'hello Bob');
  assert.equal(msg.from.title, 'Alice');
  assert.equal(c.read(roomId, seq).messages.length, 0);
});

test('post rejects a non-member', () => {
  const c = new Collab({ dir: tmpDir() });
  const { roomId } = c.open(A, {});
  assert.throws(() => c.post(roomId, B, 'sneaky'), /not a member/);
});

test('append-only log persists across instances (context restore)', () => {
  const dir = tmpDir();
  let c = new Collab({ dir });
  const { roomId, code } = c.open(A, { topic: 't' });
  c.join(B, { code });
  c.post(roomId, A, 'one');
  c.post(roomId, B, 'two');

  // New instance loads registry from disk; history replays the whole log.
  c = new Collab({ dir });
  const { log } = c.history(roomId);
  const texts = log.filter((r) => r.type === 'message').map((r) => r.text);
  assert.deepEqual(texts, ['one', 'two']);
  // The log file is genuinely append-only JSONL.
  const raw = fs.readFileSync(path.join(dir, `${roomId}.jsonl`), 'utf8').trim().split('\n');
  assert.ok(raw.length >= 4); // open, join, message, message
});

test('join by unknown code/roomId throws', () => {
  const c = new Collab({ dir: tmpDir() });
  assert.throws(() => c.join(B, { code: 'zzzz' }), /room not found/);
  assert.throws(() => c.join(B, { roomId: 'nope' }), /room not found/);
});

test('leave removes member and closes an empty room', () => {
  const c = new Collab({ dir: tmpDir() });
  const { roomId, code } = c.open(A, {});
  c.join(B, { code });
  c.leave(roomId, '%1');
  assert.deepEqual(c.members(roomId).map((m) => m.paneId), ['%2']);
  c.leave(roomId, '%2');
  assert.equal(c.listOpen().length, 0); // undiscoverable once empty
});

test('idleRecipients keeps only idle panes', () => {
  const recipients = [{ paneId: '%2' }, { paneId: '%3' }, { paneId: '%4' }];
  assert.deepEqual(
    idleRecipients(recipients, ['%2', '%4']).map((m) => m.paneId),
    ['%2', '%4'],
  );
  assert.deepEqual(idleRecipients(recipients, []), []);
});
