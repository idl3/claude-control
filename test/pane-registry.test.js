import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readPaneRegistry } from '../lib/pane-registry.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pane-reg-'));
}

test('reads valid pane records keyed by paneId', async () => {
  const dir = await tmpDir();
  const transcript = path.join(dir, 't.jsonl');
  await fs.writeFile(transcript, '{}');
  await fs.writeFile(
    path.join(dir, '5.json'),
    JSON.stringify({ paneId: '%5', sessionId: 'abc', transcriptPath: transcript, cwd: '/x', ts: 1 }),
  );
  const map = await readPaneRegistry(dir);
  assert.equal(map.size, 1);
  assert.equal(map.get('%5').transcriptPath, transcript);
});

test('drops records whose transcript no longer exists (stale)', async () => {
  const dir = await tmpDir();
  await fs.writeFile(
    path.join(dir, '6.json'),
    JSON.stringify({ paneId: '%6', transcriptPath: path.join(dir, 'gone.jsonl'), ts: 1 }),
  );
  const map = await readPaneRegistry(dir);
  assert.equal(map.size, 0);
});

test('skips malformed files and missing dir', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'bad.json'), 'not json');
  await fs.writeFile(path.join(dir, 'nofields.json'), JSON.stringify({ foo: 1 }));
  const map = await readPaneRegistry(dir);
  assert.equal(map.size, 0);
  const missing = await readPaneRegistry(path.join(dir, 'does-not-exist'));
  assert.equal(missing.size, 0);
});
