import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Redirect the pane registry to a temp dir BEFORE importing the lib, so the
// module-level PANES_DIR (which honors CC_PANES_DIR) points at the sandbox —
// same seam used by test/codex-pane-registry-persist.test.js.
const PANES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-panes-gc-throttle-'));
process.env.CC_PANES_DIR = PANES_DIR;

const { SessionRegistry } = await import('../lib/sessions.js');

// ---------------------------------------------------------------------------
// R11: gcPaneRegistry() used to run a full readdir+parse+existsSync pass over
// PANES_DIR on every single _doRefresh() cycle (every 4 s in production),
// duplicating the pass readPaneRegistry() already does the same tick.
// _doRefresh() now only fires gcPaneRegistry() every PANE_GC_INTERVAL_CYCLES
// (5) cycles. This test proves the throttle end-to-end: a stale pin file
// survives refresh() calls 1-4 after the initial cycle and is only removed
// once the 5th-cycle boundary is crossed.
// ---------------------------------------------------------------------------
test('_doRefresh throttles gcPaneRegistry to every 5th cycle (R11)', async () => {
  const reg = new SessionRegistry({
    projectsRoot: path.join(os.tmpdir(), 'no-claude-projects-gc-throttle'),
    tmux: { listWindows: async () => [], isValidTarget: () => true },
  });

  // Cycle 0: refresh() with an empty PANES_DIR — gc fires (0 % 5 === 0) but
  // has nothing to collect. This also advances _refreshCycle to 1.
  await reg.refresh();
  assert.equal(reg._refreshCycle, 1);

  // gcPaneRegistry() is fired-and-forgotten inside _doRefresh (not awaited) —
  // give cycle 0's call (readdir on an empty dir, effectively instant) a beat
  // to fully drain before writing the stale file below, so it can't possibly
  // still be mid-scan and race-collect a file written after it started.
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Now seed a stale pin (transcript file does not exist) directly on disk —
  // the exact condition gcPaneRegistry() collects.
  const staleFile = path.join(PANES_DIR, 'stale-throttle-test.json');
  fs.writeFileSync(
    staleFile,
    JSON.stringify({ paneId: '%stalethrottle', transcriptPath: path.join(PANES_DIR, 'gone.jsonl'), ts: 1 }),
  );
  assert.ok(fs.existsSync(staleFile), 'precondition: stale pin file written');

  // Cycles 1-4 (pre-increment _refreshCycle 1,2,3,4): none satisfy `% 5 === 0`,
  // so gc must NOT run — the stale pin must survive every one of these calls.
  for (let i = 1; i <= 4; i++) {
    await reg.refresh();
    assert.equal(reg._refreshCycle, i + 1, `_refreshCycle should be ${i + 1} after call`);
    assert.ok(fs.existsSync(staleFile), `stale pin must still exist after refresh() #${i} (gc throttled)`);
  }

  // Cycle 5 (pre-increment _refreshCycle === 5): `5 % 5 === 0` — gc fires and
  // must now collect the stale pin.
  await reg.refresh();
  assert.equal(reg._refreshCycle, 6);
  // gcPaneRegistry() is fired-and-forgotten (not awaited) inside _doRefresh —
  // it does real (if tiny) fs I/O, so poll briefly rather than assuming one
  // microtask turn is enough for its readdir+readFile+rm chain to settle.
  const deadline = Date.now() + 2000;
  while (fs.existsSync(staleFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(!fs.existsSync(staleFile), 'stale pin must be collected once the 5th-cycle throttle boundary is crossed');
});

test('readPaneRegistry() itself is NOT throttled — runs every refresh() cycle regardless of gc cadence', async () => {
  const reg = new SessionRegistry({
    projectsRoot: path.join(os.tmpdir(), 'no-claude-projects-gc-throttle-2'),
    tmux: { listWindows: async () => [], isValidTarget: () => true },
  });

  // A live (non-stale) pin should be visible via readPaneRegistry()'s own
  // return value on EVERY cycle, including the ones where gc is skipped —
  // readPaneRegistry() is a separate, un-throttled call each _doRefresh tick.
  const liveTranscript = path.join(PANES_DIR, 'live-throttle-test.jsonl');
  fs.writeFileSync(liveTranscript, '{}');
  fs.writeFileSync(
    path.join(PANES_DIR, 'live-throttle-test.json'),
    JSON.stringify({ paneId: '%livethrottle', transcriptPath: liveTranscript, ts: 1 }),
  );

  const { readPaneRegistry } = await import('../lib/pane-registry.js');
  for (let i = 0; i < 3; i++) {
    await reg.refresh();
    const map = await readPaneRegistry(PANES_DIR);
    assert.ok(map.has('%livethrottle'), `live pin must be readable via readPaneRegistry() on cycle ${i}`);
  }
});
