import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SessionRegistry } from '../lib/sessions.js';

// Regression coverage for the move-window re-key fix (server.js 'move-window'
// handler): after tmux.moveWindow() renumbers the window in its destination
// session, the handler calls registry.refreshNow() then resolves the moved
// session by its STABLE paneId (not by recomputing the stale pre-move
// target string). See server.js ~L3310-3338.

/** Minimal Window-shaped pane matching lib/tmux.js's listPanes() output. */
function mkPane(overrides = {}) {
  const sessionName = overrides.sessionName ?? 'Sess';
  const windowIndex = overrides.windowIndex ?? 1;
  const paneIndex = overrides.paneIndex ?? 1;
  return {
    sessionName,
    windowIndex,
    windowName: overrides.windowName ?? 'win',
    target: overrides.target ?? `${sessionName}:${windowIndex}.${paneIndex}`,
    active: overrides.active ?? false,
    paneActive: overrides.paneActive ?? false,
    panePid: overrides.panePid ?? 1234,
    cwd: overrides.cwd ?? '/tmp',
    cmd: overrides.cmd ?? 'zsh',
    windowId: overrides.windowId ?? '@1',
    paneIndex,
    paneId: overrides.paneId ?? '%1',
    ccShell: overrides.ccShell ?? false,
    ccAgent: overrides.ccAgent ?? null,
    ccTransport: overrides.ccTransport ?? null,
    ccEndpoint: overrides.ccEndpoint ?? null,
  };
}

// --- (i) refreshNow() reflects a mutation applied while a refresh is in-flight ---
//
// Models the exact race refreshNow() exists to close: a periodic refresh()
// tick is already in flight (started BEFORE the move) when the move-window
// handler fires. A naive refresh() would just hand back that stale in-flight
// promise; refreshNow() must await it, then always run a brand-new pass.
test('refreshNow() reflects a mutation applied while a refresh is in-flight', async () => {
  let callCount = 0;
  let releaseFirstCall;
  const firstCallGate = new Promise((resolve) => { releaseFirstCall = resolve; });
  const staleView = [mkPane({ sessionName: 'Src', windowId: '@1', paneIndex: 1, paneId: '%1' })];
  const freshView = [mkPane({ sessionName: 'Dst', windowId: '@1', paneIndex: 1, paneId: '%1' })];

  const tmux = {
    listWindows: async () => {
      callCount += 1;
      if (callCount === 1) {
        await firstCallGate; // held open to simulate an in-flight periodic tick
        return staleView;
      }
      return freshView; // the world after the move
    },
  };
  const reg = new SessionRegistry({ projectsRoot: '/nonexistent', tmux });

  const inFlight = reg.refresh(); // simulates the pre-existing periodic tick
  const refreshNowPromise = reg.refreshNow(); // fires right after the move

  releaseFirstCall(); // let the gated in-flight pass complete
  await inFlight;
  const staleSessions = reg.getSessions();

  const freshSessions = await refreshNowPromise;

  assert.equal(callCount, 2, 'refreshNow() must always force its own fresh _doRefresh() pass');
  assert.equal(staleSessions.find((s) => s.paneId === '%1')?.sessionName, 'Src');
  assert.equal(freshSessions.find((s) => s.paneId === '%1')?.sessionName, 'Dst');
});

// --- (ii) moved pane resolvable by stable paneId immediately after refreshNow() ---

test('a moved pane is resolvable by its stable paneId immediately after refreshNow()', async () => {
  let panes = [mkPane({ sessionName: 'Src', windowId: '@1', paneIndex: 1, paneId: '%1' })];
  const tmux = { listWindows: async () => panes };
  const reg = new SessionRegistry({ projectsRoot: '/nonexistent', tmux });

  await reg.refreshNow();
  const before = reg.getSessions().find((s) => s.paneId === '%1');
  assert.ok(before, 'pane must be found before the move');
  assert.equal(before.id, 'Src:1.1');

  // Simulate the move: tmux now reports the same stable paneId under a
  // different session, renumbered by the move.
  panes = [mkPane({ sessionName: 'Dst', windowId: '@1', paneIndex: 1, windowIndex: 3, paneId: '%1' })];

  await reg.refreshNow();
  const moved = reg.getSessions().find((s) => s.paneId === '%1');
  assert.ok(moved, 'moved pane must resolve by its stable paneId right after refreshNow()');
  assert.equal(moved.id, 'Dst:3.1');
  assert.notEqual(moved.id, before.id);
});

// --- (iii) pane-dedup prefers a real session over an ephemeral _ccpty_* mirror ---
//
// Grouped tmux sessions expose the same (windowId, paneIndex) pane under
// multiple session names. An ephemeral pty-bridge mirror session must never
// win that dedup and mask the real session — checked both input orders,
// since tmux's own listing order isn't guaranteed.

test('pane-dedup prefers a real session over an ephemeral mirror (ephemeral listed first)', async () => {
  const real = mkPane({ sessionName: 'Real', windowId: '@9', paneIndex: 1, paneId: '%9' });
  const ephemeral = mkPane({ sessionName: '_ccpty_real', windowId: '@9', paneIndex: 1, paneId: '%9' });
  const tmux = { listWindows: async () => [ephemeral, real] };
  const reg = new SessionRegistry({ projectsRoot: '/nonexistent', tmux });

  await reg.refreshNow();
  const matches = reg.getSessions().filter((s) => s.paneId === '%9');
  assert.equal(matches.length, 1, 'the pane must be represented exactly once');
  assert.equal(matches[0].sessionName, 'Real');
});

test('pane-dedup prefers a real session over an ephemeral mirror (real listed first)', async () => {
  const real = mkPane({ sessionName: 'Real', windowId: '@9', paneIndex: 1, paneId: '%9' });
  const ephemeral = mkPane({ sessionName: '_ccpty_real', windowId: '@9', paneIndex: 1, paneId: '%9' });
  const tmux = { listWindows: async () => [real, ephemeral] };
  const reg = new SessionRegistry({ projectsRoot: '/nonexistent', tmux });

  await reg.refreshNow();
  const matches = reg.getSessions().filter((s) => s.paneId === '%9');
  assert.equal(matches.length, 1, 'the pane must be represented exactly once');
  assert.equal(matches[0].sessionName, 'Real');
});
