// Fork-lineage resolution: a resumed/forked Claude session starts a NEW
// sessionId writing a NEW jsonl that copies the ancestor's records (uuids
// preserved). resolveForkDescendant must follow a superseded transcript to
// its live fork — and must NOT steal a still-diverging live ancestor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  lastChainUuid,
  resolveForkDescendant,
  _resetForkCacheForTest,
} from '../lib/sessions.js';

function rec(type, uuid, extra = {}) {
  return JSON.stringify({ type, uuid, sessionId: 'sid', timestamp: '2026-07-06T00:00:00.000Z', ...extra });
}

/** Write a jsonl transcript and pin its mtime (seconds since epoch offset). */
async function writeTranscript(dir, name, lines, mtimeOffsetSec) {
  const p = path.join(dir, name);
  await fs.writeFile(p, `${lines.join('\n')}\n`, 'utf8');
  const t = new Date(Date.now() - 1_000_000 + mtimeOffsetSec * 1000);
  await fs.utimes(p, t, t);
  return p;
}

test('lastChainUuid returns the last user/assistant uuid, skipping system records', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-fork-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const p = await writeTranscript(dir, 'a.jsonl', [
    rec('user', 'u1'),
    rec('assistant', 'u2'),
    rec('system', 'u3'),
    '{"type":"file-history-snapshot","messageId":"m1"}',
  ], 0);
  assert.equal(await lastChainUuid(p), 'u2');
});

test('resolveForkDescendant follows a fork chain to the newest descendant', async (t) => {
  _resetForkCacheForTest();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-fork-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  // ancestor: chain u1..u2. fork copies it (uuids preserved) and continues.
  const ancestor = await writeTranscript(dir, 'aaaa.jsonl', [
    rec('user', 'u1'),
    rec('assistant', 'u2'),
  ], 0);
  const fork = await writeTranscript(dir, 'bbbb.jsonl', [
    rec('user', 'u1'),
    rec('assistant', 'u2'),
    rec('user', 'u3'),
    rec('assistant', 'u4'),
  ], 10);
  // second-hop fork of the fork
  const fork2 = await writeTranscript(dir, 'cccc.jsonl', [
    rec('user', 'u1'),
    rec('assistant', 'u2'),
    rec('user', 'u3'),
    rec('assistant', 'u4'),
    rec('user', 'u5'),
  ], 20);
  // unrelated session in the same project dir — must never be followed
  const unrelated = await writeTranscript(dir, 'zzzz.jsonl', [
    rec('user', 'x1'),
    rec('assistant', 'x2'),
  ], 30);

  assert.equal(await resolveForkDescendant(ancestor), fork2, 'superseded ancestor follows the chain');
  assert.equal(await resolveForkDescendant(fork), fork2, 'mid-chain file follows to the leaf fork');
  assert.equal(await resolveForkDescendant(fork2), fork2, 'live leaf resolves to itself');
  assert.equal(await resolveForkDescendant(unrelated), unrelated, 'unrelated session is untouched');
});

test('resolveForkDescendant does not steal a live ancestor that diverged after the fork', async (t) => {
  _resetForkCacheForTest();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-fork-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  // fork was taken at u2; the ancestor then kept going (u5 not in the fork).
  const ancestor = await writeTranscript(dir, 'aaaa.jsonl', [
    rec('user', 'u1'),
    rec('assistant', 'u2'),
    rec('assistant', 'u5'),
  ], 0);
  await writeTranscript(dir, 'bbbb.jsonl', [
    rec('user', 'u1'),
    rec('assistant', 'u2'),
    rec('user', 'u3'),
  ], 10);

  assert.equal(await resolveForkDescendant(ancestor), ancestor);
});
