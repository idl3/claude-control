import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sumTreeRssMB, paneRecordMatchesCwd, paneRecordBelongsToPane, isPinSuperseded } from '../lib/sessions.js';
import { writePaneRegistryRecord, deletePaneRegistryRecord, readPaneRegistry } from '../lib/pane-registry.js';

// ── sumTreeRssMB: a pane's memory is the RSS of its whole process subtree ──────
function table(rows) {
  // rows: [pid, ppid, rssKb]
  const children = new Map();
  const rssKb = new Map();
  for (const [pid, ppid, rss] of rows) {
    rssKb.set(String(pid), rss);
    const k = String(ppid);
    if (!children.has(k)) children.set(k, []);
    children.get(k).push(String(pid));
  }
  return { children, rssKb };
}

test('sumTreeRssMB sums the pid and all descendants, in MB', () => {
  // shell(500) -> claude(600, 1GB) -> [mcp(700, 256MB), node(800, 512MB)]
  const t = table([
    [500, 1, 10 * 1024], // shell 10MB
    [600, 500, 1024 * 1024], // claude 1024MB
    [700, 600, 256 * 1024], // mcp 256MB
    [800, 600, 512 * 1024], // node 512MB
  ]);
  // subtree under the shell(500) = 10 + 1024 + 256 + 512 = 1802 MB
  assert.equal(sumTreeRssMB(500, t), 1802);
  // subtree under claude(600) = 1024 + 256 + 512 = 1792 MB
  assert.equal(sumTreeRssMB(600, t), 1792);
  // a leaf sums only itself
  assert.equal(sumTreeRssMB(700, t), 256);
});

test('sumTreeRssMB returns null for a pid not in the table (pane gone)', () => {
  const t = table([[1, 0, 1024]]);
  assert.equal(sumTreeRssMB(999, t), null);
});

test('sumTreeRssMB is cycle-safe (a ppid loop cannot infinite-loop)', () => {
  // Pathological: 10 <-> 11 point at each other. Must terminate and not double-count.
  const t = table([
    [10, 11, 1024],
    [11, 10, 1024],
  ]);
  assert.equal(sumTreeRssMB(10, t), 2); // 1024 + 1024 KB = 2 MB, each counted once
});

// ── GC guard: cwd equality, now only the no-process-start FALLBACK ────────────
test('paneRecordMatchesCwd (fallback) compares recorded launch cwd to the live pane', () => {
  // The real incident: an old olam record survived onto a now-pleri-org %N. A
  // descendant path must NOT match (that leniency is what mis-bound %28).
  assert.equal(paneRecordMatchesCwd('/Users/e/Projects/pleri-org/olam', '/Users/e/Projects/pleri-org'), false);
  // exact match (the correct binding) stays.
  assert.equal(paneRecordMatchesCwd('/Users/e/Projects/grain', '/Users/e/Projects/grain'), true);
  // trailing-slash difference is normalised away.
  assert.equal(paneRecordMatchesCwd('/Users/e/Projects/grain/', '/Users/e/Projects/grain'), true);
  // a subdir record on a parent-cwd pane is a DIFFERENT session → reject.
  assert.equal(paneRecordMatchesCwd('/Users/e/Projects/grain/pkg', '/Users/e/Projects/grain'), false);
  // legacy record without cwd → nothing to contradict, keep it.
  assert.equal(paneRecordMatchesCwd(null, '/Users/e/Projects/grain'), true);
});

// ── deletePaneRegistryRecord: terminate unregisters the pane binding ──────────
test('deletePaneRegistryRecord removes a record and is idempotent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-term-'));
  const transcript = path.join(dir, 't.jsonl');
  await fs.writeFile(transcript, '{}');
  await writePaneRegistryRecord({ paneId: '%42', transcriptPath: transcript, cwd: '/x' }, dir);

  let map = await readPaneRegistry(dir);
  assert.ok(map.has('%42'), 'record exists before delete');

  await deletePaneRegistryRecord('%42', dir);
  map = await readPaneRegistry(dir);
  assert.equal(map.has('%42'), false, 'record gone after delete');

  // idempotent: deleting again does not throw
  await deletePaneRegistryRecord('%42', dir);
});

// ── Pane-record identity: age, not cwd ───────────────────────────────────────
//
// tmux's `pane_current_path` is LIVE — it follows the foreground process. Two
// long-running agents that cd'd from `pleri-org/olam` up to `pleri-org` stopped
// matching their OWN hook records, so the deterministic binding was dropped and
// both sessions rendered with NO transcript at all. A record cannot predate the
// process that wrote it; a record on a recycled %N always does.

const PANE_CWD = '/Users/e/Projects/pleri-org';
const START = 1_700_000_000_000;

test('a record written after the pane process started belongs to it, even after the agent cd-ed away', () => {
  const rec = { cwd: '/Users/e/Projects/pleri-org/olam', ts: START + 60_000 };
  assert.equal(
    paneRecordBelongsToPane(rec, PANE_CWD, START),
    true,
    'the live bug: cwd moved, but the record is younger than the process — still ours',
  );
  assert.equal(paneRecordMatchesCwd(rec.cwd, PANE_CWD), false, 'and the old cwd-only test would have rejected it');
});

test('a record predating the pane process is a recycled-%N leftover and is rejected', () => {
  const rec = { cwd: PANE_CWD, ts: START - 60_000 };
  assert.equal(
    paneRecordBelongsToPane(rec, PANE_CWD, START),
    false,
    'matching cwd is not enough — it was authored by a previous tmux generation',
  );
});

test('record-vs-process timing tolerates ps second-granularity skew', () => {
  // `startMs` is now - elapsedSeconds*1000, so it can land slightly late.
  assert.equal(paneRecordBelongsToPane({ ts: START - 3_000 }, PANE_CWD, START), true, 'within tolerance');
  assert.equal(paneRecordBelongsToPane({ ts: START - 600_000 }, PANE_CWD, START), false, 'well outside it');
});

test('with no process start (ps failed / non-agent pane) it falls back to strict cwd equality', () => {
  assert.equal(paneRecordBelongsToPane({ cwd: PANE_CWD, ts: START }, PANE_CWD, null), true);
  assert.equal(paneRecordBelongsToPane({ cwd: '/Users/e/Projects/pleri-org/olam', ts: START }, PANE_CWD, null), false);
  assert.equal(paneRecordBelongsToPane({ ts: START }, PANE_CWD, null), true, 'legacy record with no cwd — nothing to contradict');
});

test('a missing record never belongs to a pane', () => {
  assert.equal(paneRecordBelongsToPane(null, PANE_CWD, START), false);
  assert.equal(paneRecordBelongsToPane(undefined, PANE_CWD, null), false);
});

test('pin supersession uses the same identity test — a cd-ed pane still expires a stale pin', () => {
  const reg = { transcriptPath: '/p/new.jsonl', cwd: '/Users/e/Projects/pleri-org/olam', ts: START + 60_000 };
  assert.equal(
    isPinSuperseded('/p/old.jsonl', reg, PANE_CWD, START),
    true,
    'the hook record is younger than the pin AND genuinely this pane’s — it wins',
  );
  const recycled = { ...reg, ts: START - 600_000 };
  assert.equal(
    isPinSuperseded('/p/old.jsonl', recycled, PANE_CWD, START),
    false,
    'a recycled-%N record must never evict a pin',
  );
});
