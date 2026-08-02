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

// When a tmux server restarts (reboot), pane-ids reset (%0, %2, …) but the
// pre-reboot pins (%84, %252, …) linger — their transcript is still live, so
// transcript-existence GC never collects them. Two pins then reference the SAME
// transcript. The resumed session's pin is always the most recently written, so
// newest ts wins: one transcript → one live binding.
test('dedupes pins that share a transcript — newest ts wins (reboot pane-id churn)', async () => {
  const dir = await tmpDir();
  const transcript = path.join(dir, 'session.jsonl');
  await fs.writeFile(transcript, '{}');
  await fs.writeFile(
    path.join(dir, '252.json'),
    JSON.stringify({ paneId: '%252', sessionId: 's', transcriptPath: transcript, ts: 1000 }),
  );
  await fs.writeFile(
    path.join(dir, '11.json'),
    JSON.stringify({ paneId: '%11', sessionId: 's', transcriptPath: transcript, ts: 2000 }),
  );
  const map = await readPaneRegistry(dir);
  assert.equal(map.size, 1, 'one transcript resolves to exactly one pane binding');
  assert.ok(map.has('%11'), 'newest-ts pin (the resumed live pane) wins');
  assert.ok(!map.has('%252'), 'the superseded pre-reboot pin is dropped');
});

test('does not dedupe distinct transcripts', async () => {
  const dir = await tmpDir();
  await writePaneLive(dir, '28.json', '%28');
  await writePaneLive(dir, '29.json', '%29');
  const map = await readPaneRegistry(dir);
  assert.equal(map.size, 2, 'different transcripts are never merged');
});

// ─── gcPaneRegistry ──────────────────────────────────────────────────────────
// Contract: gc deletes a pin IFF (a) its transcript file is gone, OR (b) it is
// superseded by a newer-ts pin for the SAME transcript. The live tmux pane set
// is NOT consulted — a flickering scan must never delete a live pin.

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

test('gc removes a pin superseded by a newer pin for the same live transcript', async () => {
  const dir = await tmpDir();
  const transcript = path.join(dir, 'session.jsonl');
  await fs.writeFile(transcript, '{}');
  // Pre-reboot pin (old pane id, older ts) beside the resumed pin (newer ts).
  await fs.writeFile(
    path.join(dir, '252.json'),
    JSON.stringify({ paneId: '%252', transcriptPath: transcript, ts: 1000 }),
  );
  await fs.writeFile(
    path.join(dir, '11.json'),
    JSON.stringify({ paneId: '%11', transcriptPath: transcript, ts: 2000 }),
  );

  await gcPaneRegistry(dir);

  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.deepEqual(files, ['11.json'], 'older superseded pin collected; newest live pin survives');
});

test('gc keeps distinct-transcript pins (no false supersede)', async () => {
  const dir = await tmpDir();
  await writePaneLive(dir, '28.json', '%28');
  await writePaneLive(dir, '29.json', '%29');

  await gcPaneRegistry(dir);

  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(files, ['28.json', '29.json'], 'different transcripts are never deduped');
});

test('gc on a missing dir is a no-op (no throw)', async () => {
  const dir = await tmpDir();
  await gcPaneRegistry(path.join(dir, 'does-not-exist'));
  // reaching here without throwing is the assertion
  assert.ok(true);
});
