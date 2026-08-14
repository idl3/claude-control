import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SessionRegistry } from '../lib/sessions.js';

function makePane({ ccAgent = 'codewhale', target = 'test:1.1' } = {}) {
  return {
    target,
    sessionName: 'test',
    windowIndex: 1,
    paneIndex: 1,
    windowId: '@codewhale',
    paneId: '%codewhale',
    windowName: 'whale-session',
    active: true,
    cwd: '/work/repo',
    cmd: 'codewhale',
    ccShell: false,
    ccAgent,
    ccTransport: 'tmux',
    ccEndpoint: null,
    panePid: 4242,
  };
}

function makeRegistry(pane) {
  const registry = new SessionRegistry({
    projectsRoot: '/nonexistent-codewhale-projects',
    tmux: {
      listWindows: async () => [pane],
      capturePane: async () => '',
      isValidTarget: () => true,
    },
  });
  registry._buildPaneProc = async () => new Map([
    [pane.target, {
      isClaude: false,
      isCodex: false,
      isCodeWhale: true,
      kind: 'codewhale',
      startMs: Date.now() - 5_000,
      pid: 4242,
      appServer: false,
      appServerEndpoint: null,
    }],
  ]);
  return registry;
}

test('@cc_agent=codewhale stays a first-class harness with terminal presentation', async () => {
  const pane = makePane();
  const registry = makeRegistry(pane);

  await registry.refresh();
  const session = registry.getSessions().find((candidate) => candidate.target === pane.target);

  assert.ok(session, 'pane produced a session row');
  assert.equal(session.kind, 'codewhale');
  assert.equal(session.presentation, 'terminal');
  assert.equal(session.transport, 'tmux');
  assert.equal(session.transcriptPath, null);
  assert.equal(session.isClaude, false);
});

test('an untagged CodeWhale process is discovered by the process classifier', async () => {
  const pane = makePane({ ccAgent: null, target: 'test:2.1' });
  const registry = makeRegistry(pane);

  await registry.refresh();
  const session = registry.getSessions().find((candidate) => candidate.target === pane.target);

  assert.ok(session);
  assert.equal(session.kind, 'codewhale');
  assert.equal(session.presentation, 'terminal');
});
