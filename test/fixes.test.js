// Regression tests for audit findings fixed post-build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { encodeCwd, isCwdConsistent } from '../lib/sessions.js';
import { TranscriptTailer } from '../lib/transcript.js';

// ── sessions: encodeCwd + collision-safe cwd consistency ───────────────────
test('encodeCwd maps / and . to -', () => {
  assert.equal(encodeCwd('/Users/ernie/Projects/atlas'), '-Users-ernie-Projects-atlas');
  assert.equal(encodeCwd('/Users/ernie/.claude'), '-Users-ernie--claude');
});

test('isCwdConsistent accepts equal and descendant cwds (mid-session cd)', () => {
  // atlas session that cd'd into a subdir — must still match
  assert.ok(isCwdConsistent('/Users/ernie/Projects/atlas/atlas-core', '/Users/ernie/Projects/atlas'));
  assert.ok(isCwdConsistent('/Users/ernie/Projects/atlas', '/Users/ernie/Projects/atlas'));
  assert.ok(isCwdConsistent(null, '/Users/ernie/Projects/atlas')); // unknown -> trust
});

test('isCwdConsistent rejects encodeCwd sibling collisions (my.lib vs my-lib)', () => {
  // /p/my.lib and /p/my-lib both encode to -p-my-lib; reject the wrong binding
  assert.equal(isCwdConsistent('/p/my.lib', '/p/my-lib'), false);
  assert.equal(isCwdConsistent('/p/other', '/p/my-lib'), false);
});

// ── transcript: trim() relieves memory pressure ────────────────────────────
test('TranscriptTailer.trim caps the retained buffer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-trim-'));
  const file = path.join(dir, 's.jsonl');
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push(JSON.stringify({ type: 'user', uuid: 'u' + i, timestamp: 't', message: { content: 'm' + i } }));
  }
  fs.writeFileSync(file, rows.join('\n') + '\n');
  const t = new TranscriptTailer(file, { maxBuffer: 500 });
  await t.start();
  assert.equal(t.getMessages().length, 20);
  t.trim(5);
  const kept = t.getMessages();
  assert.equal(kept.length, 5);
  assert.equal(kept[kept.length - 1].blocks[0].text, 'm19'); // newest retained
  t.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── transcript: a record split across the startup boundary is not dropped ──
test('TranscriptTailer reassembles a record that completes after start()', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-partial-'));
  const file = path.join(dir, 's.jsonl');
  // One complete record, then a partial record with NO trailing newline.
  const complete = JSON.stringify({ type: 'user', uuid: 'a', timestamp: 't', message: { content: 'first' } });
  const partial = '{"type":"assistant","uuid":"b","timestamp":"t","message":{"content":[{"type":"text","text":"sec';
  fs.writeFileSync(file, complete + '\n' + partial);

  const t = new TranscriptTailer(file, { maxBuffer: 500 });
  await t.start();
  assert.equal(t.getMessages().length, 1); // partial not yet a message

  const appended = once(t, 'append');
  // Complete the partial record.
  fs.appendFileSync(file, 'ond"}]}}\n');
  const [msgs] = await appended;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].blocks[0].text, 'second'); // reassembled, not corrupted/dropped
  assert.equal(t.getMessages().length, 2);
  t.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
