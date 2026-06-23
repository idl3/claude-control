import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readPaneRegistry, writePaneRegistryRecord, gcPaneRegistry, _resetGcStateForTest } from '../lib/pane-registry.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pane-reg-'));
}

/** Write a pane JSON file whose transcript EXISTS (a live binding). */
async function writePaneLive(dir, filename, paneId) {
  const transcript = path.join(dir, `${paneId.replace('%', '')}.jsonl`);
  await fs.writeFile(transcript, '{}');
  await fs.writeFile(
    path.join(dir, filename),
    JSON.stringify({ paneId, transcriptPath: transcript, ts: 1 }),
  );
}

/** Write a pane JSON file whose transcript is MISSING (a stale binding). */
async function writePaneStale(dir, filename, paneId) {
  await fs.writeFile(
    path.join(dir, filename),
    JSON.stringify({ paneId, transcriptPath: path.join(dir, `${paneId}-gone.jsonl`), ts: 1 }),
  );
}

// ─── readPaneRegistry ────────────────────────────────────────────────────────

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

test('writePaneRegistryRecord persists a readable exact pane binding', async () => {
  const dir = await tmpDir();
  const transcript = path.join(dir, 'codex-rollout.jsonl');
  await fs.writeFile(transcript, '{}');

  await writePaneRegistryRecord({
    paneId: '%42',
    sessionId: 'thread-42',
    transcriptPath: transcript,
    cwd: '/workspace',
  }, dir);

  const map = await readPaneRegistry(dir);
  assert.equal(map.size, 1);
  assert.equal(map.get('%42').sessionId, 'thread-42');
  assert.equal(map.get('%42').transcriptPath, transcript);
  assert.equal(map.get('%42').cwd, '/workspace');
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

// ─── gcPaneRegistry ──────────────────────────────────────────────────────────
// New contract: gc deletes a pin IFF its transcript file is gone. The live tmux
// pane set is NOT consulted — a flickering scan must never delete a live pin.

test('gc keeps a pin whose transcript still exists (live binding)', async () => {
  const dir = await tmpDir();
  await writePaneLive(dir, '28.json', '%28');

  // Many passes — a live transcript is never collected, regardless of scans.
  await gcPaneRegistry(dir);
  await gcPaneRegistry(dir);
  await gcPaneRegistry(dir);

  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1, 'live-transcript pin must survive any number of gc passes');
});

test('gc removes a pin whose transcript is gone (stale binding)', async () => {
  const dir = await tmpDir();
  await writePaneStale(dir, '30.json', '%30');

  await gcPaneRegistry(dir);

  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 0, 'pin removed once its transcript no longer exists');
});

test('gc removes stale pins but keeps live ones in the same pass', async () => {
  const dir = await tmpDir();
  await writePaneLive(dir, '28.json', '%28'); // live
  await writePaneStale(dir, '31.json', '%31'); // stale

  await gcPaneRegistry(dir);

  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.deepEqual(files, ['28.json'], 'only the stale pin is removed');
});

test('gc on a missing dir is a no-op (no throw)', async () => {
  const dir = await tmpDir();
  await gcPaneRegistry(path.join(dir, 'does-not-exist'));
  // reaching here without throwing is the assertion
  assert.ok(true);
});
