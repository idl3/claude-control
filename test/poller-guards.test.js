/**
 * test/poller-guards.test.js
 *
 * Re-entrancy guard tests for SessionRegistry periodic pollers (PLE-55).
 *
 * Strategy: build a minimal SessionRegistry with a stubbed _tmux that resolves
 * after a controllable deferred, then call the guarded method twice concurrently
 * and assert the core work (listWindows call-count) ran exactly once. After the
 * first call resolves a subsequent call must run normally (flag reset). After a
 * rejection the flag must also be reset.
 *
 * _pollCtx / _pollThinking are guarded but delegate to capturePane on each
 * session — unit-driving them in isolation would require constructing session
 * state. We test their guards via the flag directly (structural) rather than
 * call-count, and add a note explaining why.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SessionRegistry } from '../lib/sessions.js';
import { parseCodexPrompt } from '../lib/codex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODEX_EXEC_APPROVAL_CAPTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'codex', 'pane-exec-approval.txt'),
  'utf8',
);

// ── helpers ──────────────────────────────────────────────────────────────────

/** Returns [deferred, resolve, reject]. */
function deferred() {
  let res, rej;
  const p = new Promise((resolve, reject) => { res = resolve; rej = reject; });
  return [p, res, rej];
}

/**
 * Build a minimal SessionRegistry with a controlled stub for _listWindows.
 * The stub resolves only when the caller calls the returned `unblock()` fn.
 *
 * We stub _listWindows (the very first await inside _doRefresh) so we can
 * freeze the body without touching file-system or tmux paths.
 */
function makeRegistry(stubListWindows) {
  const reg = new SessionRegistry({
    projectsRoot: '/tmp/nonexistent-projects',
    tmux: {
      listWindows: stubListWindows,
      isValidTarget: () => false,
    },
  });
  return reg;
}

// ── refresh() skip-if-busy ────────────────────────────────────────────────────

test('refresh(): second call while first is in-flight is a no-op (skip-if-busy)', async () => {
  let callCount = 0;
  const [blocker, unblock] = deferred();

  const stub = async () => {
    callCount++;
    await blocker; // freeze here until we unblock
    return [];
  };

  const reg = makeRegistry(stub);

  // Fire two overlapping calls.
  const p1 = reg.refresh();
  const p2 = reg.refresh(); // should skip — flag already set

  // Unblock the first.
  unblock();
  await Promise.all([p1, p2]);

  assert.equal(callCount, 1, 'listWindows must be called exactly once when second call overlaps');
});

test('refresh(): call runs again after the first resolves (flag reset)', async () => {
  let callCount = 0;
  const reg = makeRegistry(async () => { callCount++; return []; });

  await reg.refresh();
  await reg.refresh();

  assert.equal(callCount, 2, 'listWindows must be called twice for two sequential calls');
});

test('refresh(): flag resets after a rejection so next call still runs', async () => {
  // _listWindows() has a built-in try/catch and returns [] on error, so we
  // can't make refresh() itself reject through that path. Instead we stub
  // _doRefresh() directly on the instance so a genuine throw propagates through
  // the guard wrapper (refresh → _doRefresh). This proves the finally() resets
  // the flag even when the body throws.
  const reg = makeRegistry(async () => []);

  let doRefreshCalls = 0;
  let shouldThrow = true;

  reg._doRefresh = async () => {
    doRefreshCalls++;
    if (shouldThrow) throw new Error('stub body error');
    return [];
  };

  // First call: _doRefresh throws → refresh() rejects.
  await assert.rejects(() => reg.refresh(), /stub body error/);
  assert.equal(reg._refreshing, false, 'flag must be false after rejected call');

  // Flag is reset; second call must enter _doRefresh again.
  shouldThrow = false;
  await reg.refresh();
  assert.equal(doRefreshCalls, 2, '_doRefresh must run again after flag was reset');
});

// ── _pollCtx / _pollThinking: structural guard verification ──────────────────
//
// These workers iterate over this._sessions and call capturePane per session.
// Driving them meaningfully in isolation would require constructing full session
// objects and a capturePane stub for each — significant test scaffolding for a
// one-line guard. Instead we verify the guard flag directly: set it manually,
// call the worker, assert capturePane was never called (the flag short-circuits
// before any iteration begins), then clear the flag and verify a call goes
// through. This is sufficient to prove the skip-if-busy contract.

test('_pollCtx: skips body when flag is already set', async () => {
  let captureCalls = 0;
  const reg = new SessionRegistry({
    projectsRoot: '/tmp/nonexistent',
    tmux: {
      listWindows: async () => [],
      isValidTarget: () => true,
      capturePane: async () => { captureCalls++; return ''; },
    },
  });
  // Inject a fake session so there's something to iterate over.
  reg._sessions = [{ target: 'test:0.0', kind: 'claude' }];

  // Pre-set the flag (simulates a concurrent in-flight call).
  reg._pollingCtx = true;
  await reg._pollCtx();
  assert.equal(captureCalls, 0, '_pollCtx must not call capturePane when flag is set');

  // Clear flag; next call should proceed.
  reg._pollingCtx = false;
  await reg._pollCtx();
  assert.equal(captureCalls, 1, '_pollCtx must call capturePane once when flag is clear');
});

test('_pollThinking: skips body when flag is already set', async () => {
  let captureCalls = 0;
  const reg = new SessionRegistry({
    projectsRoot: '/tmp/nonexistent',
    tmux: {
      listWindows: async () => [],
      isValidTarget: () => true,
      capturePane: async () => { captureCalls++; return ''; },
    },
  });
  reg._sessions = [{ target: 'test:0.0', kind: 'claude' }];

  reg._pollingThinking = true;
  await reg._pollThinking();
  assert.equal(captureCalls, 0, '_pollThinking must not call capturePane when flag is set');

  reg._pollingThinking = false;
  await reg._pollThinking();
  assert.equal(captureCalls, 1, '_pollThinking must call capturePane once when flag is clear');
});

// ── _pollCtx: shouldScrapePane idle gate (R7) ────────────────────────────────
//
// _pollCtx used to capture-pane unconditionally for every discovered session.
// It now shares _pollThinking's shouldScrapePane/_activeUntil gate, so an idle
// session (no thinking/compacting/pending/errored flag, transcript present but
// stale, no fresh fs.watch window) must be skipped by BOTH pollers. This test
// proves parity: same idle session, same zero-capture result, on both workers.

test('_pollCtx: idle session (gated, like _pollThinking) makes zero capturePane calls', async () => {
  let ctxCaptureCalls = 0;
  let thinkingCaptureCalls = 0;
  const reg = new SessionRegistry({
    projectsRoot: '/tmp/nonexistent',
    tmux: {
      listWindows: async () => [],
      isValidTarget: () => true,
      capturePane: async () => { ctxCaptureCalls++; thinkingCaptureCalls++; return ''; },
    },
  });
  // Idle session: has a transcriptPath (so the gate can evaluate it) but no
  // live flags and no recent activity anywhere (_activeUntil map empty,
  // lastActivityMs unset) — shouldScrapePane must resolve to "skip".
  reg._sessions = [{
    target: 'test:0.0',
    kind: 'claude',
    transcriptPath: '/p/idle-session.jsonl',
    thinking: false,
    compacting: false,
    pending: false,
    errored: false,
  }];

  await reg._pollCtx();
  assert.equal(ctxCaptureCalls, 0, '_pollCtx must skip capturePane for an idle-gated session');

  await reg._pollThinking();
  assert.equal(thinkingCaptureCalls, 0, '_pollThinking must skip capturePane for the same idle session (sibling parity)');
});

test('_pollCtx: recently-active Claude pane with no effort backfills (one scrape); ancient one stays gated', async () => {
  let backfillCalls = 0;
  let ancientCalls = 0;
  const reg = new SessionRegistry({
    projectsRoot: '/tmp/nonexistent',
    tmux: {
      listWindows: async () => [],
      isValidTarget: () => true,
      capturePane: async (target) => {
        if (target === 'bf:0.0') backfillCalls++;
        if (target === 'old:0.0') ancientCalls++;
        return '';
      },
    },
  });
  const now = Date.now();
  reg._sessions = [
    // Idle by the 20s scrape window (5 min old) but recently-active within the
    // effort-backfill window AND missing effort → should be scraped once.
    {
      target: 'bf:0.0', kind: 'claude', transcriptPath: '/p/bf.jsonl',
      thinking: false, compacting: false, pending: false, errored: false,
      lastActivityMs: now - 5 * 60_000, effort: null,
    },
    // Ancient (2h old) + missing effort → stays gated (battery invariant).
    {
      target: 'old:0.0', kind: 'claude', transcriptPath: '/p/old.jsonl',
      thinking: false, compacting: false, pending: false, errored: false,
      lastActivityMs: now - 2 * 60 * 60_000, effort: null,
    },
  ];

  await reg._pollCtx();
  assert.equal(backfillCalls, 1, 'recently-active Claude pane missing effort is backfill-scraped');
  assert.equal(ancientCalls, 0, 'long-idle pane stays gated even when missing effort');
});

test('_pollCtx: active session (recent transcript activity) still calls capturePane', async () => {
  let captureCalls = 0;
  const reg = new SessionRegistry({
    projectsRoot: '/tmp/nonexistent',
    tmux: {
      listWindows: async () => [],
      isValidTarget: () => true,
      capturePane: async () => { captureCalls++; return ''; },
    },
  });
  const transcriptPath = '/p/active-session.jsonl';
  reg._sessions = [{
    target: 'test:0.0',
    kind: 'claude',
    transcriptPath,
    thinking: false,
    compacting: false,
    pending: false,
    errored: false,
  }];
  // Seed _activeUntil as _syncTranscriptWatchers would for a recently-changed
  // transcript, so the gate sees this pane as live.
  reg._activeUntil.set(transcriptPath, Date.now() + 20_000);

  await reg._pollCtx();
  assert.equal(captureCalls, 1, '_pollCtx must still capture an active-gated session');
});

test('_pollCtx: flag resets after rejection so next call runs', async () => {
  let callCount = 0;
  let shouldThrow = true;
  const reg = new SessionRegistry({
    projectsRoot: '/tmp/nonexistent',
    tmux: {
      listWindows: async () => [],
      isValidTarget: () => true,
      capturePane: async () => {
        callCount++;
        if (shouldThrow) throw new Error('capture failed');
        return '';
      },
    },
  });
  reg._sessions = [{ target: 'test:0.0', kind: 'claude' }];

  // The per-session inner catch absorbs the capturePane error; _pollCtx itself
  // won't reject. The flag must still reset.
  await reg._pollCtx();
  assert.equal(callCount, 1, 'first call attempted capturePane');

  // Flag should be clear; second call must attempt capturePane again.
  shouldThrow = false;
  await reg._pollCtx();
  assert.equal(callCount, 2, 'second call must run after flag was reset by first call');
});

// ── teardown: verify skip-if-busy "teeth" ───────────────────────────────────
//
// This test demonstrates that removing the guard from refresh() would cause
// callCount === 2 instead of 1, making the "ran once" assertion above fail.
// We can't remove the guard in the same process, so instead we prove the
// inverse: without the flag check, two concurrent calls would both reach the
// stub. We simulate the un-guarded scenario by calling _doRefresh() directly
// (the private body with no guard).

test('teeth: _doRefresh() called twice concurrently increments callCount to 2 (guard needed)', async () => {
  let callCount = 0;
  const [blocker, unblock] = deferred();

  const stub = async () => {
    callCount++;
    await blocker;
    return [];
  };

  const reg = makeRegistry(stub);

  // Call the un-guarded body twice — both proceed.
  const p1 = reg._doRefresh();
  const p2 = reg._doRefresh();
  unblock();
  await Promise.all([p1, p2]);

  assert.equal(callCount, 2, 'without guard, both concurrent _doRefresh() calls reach the stub');
});

// ── getPanePrompt(): codex prompt cache reuse (R9 dedup) ────────────────────
//
// server.js's startPromptPoller runs a SEPARATE per-subscription 2 s timer
// that, for codex sessions, used to run its OWN `tmux capture-pane -p -t
// <target>` — byte-identical to the one _pollThinking already runs on the
// SessionRegistry's own 2 s cadence. getPanePrompt() lets startPromptPoller
// reuse _pollThinking's result instead of re-capturing. These tests exercise
// getPanePrompt() directly (the exact contract startPromptPoller consumes)
// rather than server.js's un-exported startPromptPoller function itself.

test('getPanePrompt: absent entry (never captured) → not fresh, null prompt', () => {
  const reg = new SessionRegistry({
    projectsRoot: '/tmp/nonexistent',
    tmux: { listWindows: async () => [], isValidTarget: () => true },
  });
  const result = reg.getPanePrompt('test:0.0');
  assert.deepEqual(result, { prompt: null, fresh: false });
});

test('getPanePrompt: fresh entry after one _pollThinking capture → dedup makes ZERO additional capturePane calls', async () => {
  let captureCalls = 0;
  const reg = new SessionRegistry({
    projectsRoot: '/tmp/nonexistent',
    tmux: {
      listWindows: async () => [],
      isValidTarget: () => true,
      capturePane: async () => { captureCalls++; return CODEX_EXEC_APPROVAL_CAPTURE; },
    },
  });
  reg._sessions = [{
    target: 'test:0.0',
    kind: 'codex',
    transcriptPath: null, // no transcript to gate on → shouldScrapePane scrapes it
  }];

  // Simulate _pollThinking's own 2 s tick — this is the ONE capturePane call
  // that both the old code (startPromptPoller re-capturing) and the new code
  // (startPromptPoller reading the cache) both depend on having happened.
  await reg._pollThinking();
  assert.equal(captureCalls, 1, '_pollThinking made exactly one capturePane call');

  // startPromptPoller's codex branch, post-R9, does exactly this read instead
  // of its own capture-pane call:
  const cached = reg.getPanePrompt('test:0.0');
  assert.equal(cached.fresh, true, 'entry captured moments ago must read as fresh');
  assert.deepEqual(
    cached.prompt,
    parseCodexPrompt(CODEX_EXEC_APPROVAL_CAPTURE),
    'cached prompt must exactly match what a fresh parseCodexPrompt(cap) would have produced',
  );
  assert.ok(cached.prompt.options?.length > 0, 'options must survive the cache (dropped by the reduced _panePromptMap rec)');

  // The critical dedup assertion: reading the cache made NO further capturePane calls.
  assert.equal(captureCalls, 1, 'getPanePrompt() must not trigger any additional capturePane calls');
});

test('getPanePrompt: stale entry (older than the freshness window) → fresh:false, caller must fall back', () => {
  const reg = new SessionRegistry({
    projectsRoot: '/tmp/nonexistent',
    tmux: { listWindows: async () => [], isValidTarget: () => true },
  });
  const prompt = parseCodexPrompt(CODEX_EXEC_APPROVAL_CAPTURE);
  // Directly seed a stale entry — as if _pollThinking captured it 10s ago
  // (well past the freshness window, e.g. the pane went idle and
  // shouldScrapePane has been skipping it on recent _pollThinking ticks).
  reg._codexPromptCache.set('test:0.0', { prompt, at: Date.now() - 10_000 });

  const result = reg.getPanePrompt('test:0.0');
  assert.equal(result.fresh, false, 'a 10s-old entry must read as stale so the caller re-captures');
  // The stale prompt value is still returned (caller ignores it when !fresh);
  // this just documents the accessor does not silently null it out.
  assert.deepEqual(result.prompt, prompt);
});
