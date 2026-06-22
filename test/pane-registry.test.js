import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readPaneRegistry, gcPaneRegistry, _resetGcStateForTest } from '../lib/pane-registry.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pane-reg-'));
}

/** Write a minimal valid pane JSON file into `dir`. */
async function writePane(dir, filename, paneId) {
  await fs.writeFile(
    path.join(dir, filename),
    JSON.stringify({ paneId, transcriptPath: path.join(dir, 'transcript.jsonl'), ts: 1 }),
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

test('gc empty-scan guard: gcPaneRegistry(new Set()) removes NOTHING', async () => {
  _resetGcStateForTest();
  const dir = await tmpDir();
  await writePane(dir, '%28.json', '%28');
  await writePane(dir, '%29.json', '%29');

  await gcPaneRegistry(new Set(), dir);

  const remaining = await fs.readdir(dir);
  const jsonFiles = remaining.filter((f) => f.endsWith('.json'));
  assert.equal(jsonFiles.length, 2, 'both files must still exist after empty-scan gc');
});

test('gc keeps file and resets counter when pane is present in livePaneIds', async () => {
  _resetGcStateForTest();
  const dir = await tmpDir();
  await writePane(dir, '%10.json', '%10');

  // Two passes with pane present — should not delete
  await gcPaneRegistry(new Set(['%10']), dir);
  await gcPaneRegistry(new Set(['%10']), dir);

  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1, 'file kept when pane is live');
});

test('gc absent for 1 pass (K=3) — file still present', async () => {
  _resetGcStateForTest();
  const dir = await tmpDir();
  await writePane(dir, '%20.json', '%20');

  await gcPaneRegistry(new Set(), dir); // empty guard — skipped entirely
  await gcPaneRegistry(new Set(['%99']), dir); // pass 1 — %20 absent (miss=1)

  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1, 'file kept after 1 miss');
});

test('gc absent for 2 passes (K=3) — file still present', async () => {
  _resetGcStateForTest();
  const dir = await tmpDir();
  await writePane(dir, '%21.json', '%21');

  await gcPaneRegistry(new Set(['%99']), dir); // miss 1
  await gcPaneRegistry(new Set(['%99']), dir); // miss 2

  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1, 'file kept after 2 misses (threshold is 3)');
});

test('gc absent for 3 consecutive passes (K=3) — file removed', async () => {
  _resetGcStateForTest();
  const dir = await tmpDir();
  await writePane(dir, '%22.json', '%22');

  await gcPaneRegistry(new Set(['%99']), dir); // miss 1
  await gcPaneRegistry(new Set(['%99']), dir); // miss 2
  await gcPaneRegistry(new Set(['%99']), dir); // miss 3 → delete

  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 0, 'file removed after 3 consecutive misses');
});

test('gc absent twice then present — counter resets, file kept', async () => {
  _resetGcStateForTest();
  const dir = await tmpDir();
  await writePane(dir, '%23.json', '%23');

  await gcPaneRegistry(new Set(['%99']), dir); // miss 1
  await gcPaneRegistry(new Set(['%99']), dir); // miss 2
  await gcPaneRegistry(new Set(['%23']), dir); // present → counter reset
  await gcPaneRegistry(new Set(['%99']), dir); // miss 1 (fresh start)
  await gcPaneRegistry(new Set(['%99']), dir); // miss 2

  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1, 'file kept — counter reset on re-appearance prevents premature delete');
});
