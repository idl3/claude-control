import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SessionRegistry } from '../lib/sessions.js';

// Build the codex date-dir path components the same way lib/codex.js's
// datePath() does (local-date YYYY/MM/DD), so fixtures always land inside
// the LOOKBACK_DAYS window regardless of the current date.
function codexDateDir(date = new Date()) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return [yyyy, mm, dd];
}

function writeRollout(dir, cwd, sessionId, when) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${sessionId}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({
    type: 'session_meta',
    payload: { id: sessionId, cwd },
    timestamp: when.toISOString(),
  }) + '\n');
  fs.utimesSync(file, when, when);
  return file;
}

function makePane({
  target = 'test:1.1',
  paneId = '%codexapp',
  windowName = 'raw-events',
  cwd = '/work/repo',
  cmd = 'node',
  ccTransport = null,
  ccEndpoint = null,
} = {}) {
  return {
    target,
    sessionName: 'test',
    windowIndex: 1,
    paneIndex: 1,
    windowId: '@codexapp',
    paneId,
    windowName,
    active: true,
    cwd,
    cmd,
    ccShell: false,
    ccTransport,
    ccEndpoint,
    panePid: 12345,
  };
}

function makeRegistry({
  pane,
  capture,
  codexSessionsRoot,
  appServer = false,
  appServerEndpoint = null,
}) {
  const reg = new SessionRegistry({
    projectsRoot: path.join(os.tmpdir(), 'no-claude-projects'),
    codexSessionsRoot,
    tmux: {
      listWindows: async () => [pane],
      capturePane: async () => capture,
      isValidTarget: () => true,
    },
  });
  reg._buildPaneProc = async () => new Map([
    [pane.target, {
      isClaude: false,
      isCodex: true,
      kind: 'codex',
      startMs: Date.now() - 5_000,
      pid: 12345,
      appServer,
      appServerEndpoint,
    }],
  ]);
  return reg;
}

test('Codex app-server pane without marker is rpc and not bound to stale cwd fallback', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-appserver-session-'));
  const cwd = '/work/repo';
  writeRollout(path.join(temp, ...codexDateDir()), cwd, 'stale-session', new Date());
  const pane = makePane({ cwd });
  const reg = makeRegistry({
    pane,
    codexSessionsRoot: temp,
    appServer: true,
    appServerEndpoint: 'ws://127.0.0.1:60606',
    capture: [
      'codex app-server (WebSockets)',
      '  listening on: ws://127.0.0.1:60606',
      '  readyz: http://127.0.0.1:60606/readyz',
    ].join('\n'),
  });

  try {
    const sessions = await reg.refresh();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].kind, 'codex');
    assert.equal(sessions[0].transport, 'rpc');
    assert.equal(sessions[0].endpoint, 'ws://127.0.0.1:60606');
    assert.equal(sessions[0].transcriptPath, null);
    assert.equal(sessions[0].sessionId, null);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Codex process endpoint is enough to classify rpc even if appServer flag is absent', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-appserver-endpoint-'));
  const cwd = '/work/repo';
  writeRollout(path.join(temp, ...codexDateDir()), cwd, 'stale-session', new Date());
  const pane = makePane({ cwd, target: 'test:4.1', paneId: '%codexendpoint' });
  const reg = makeRegistry({
    pane,
    codexSessionsRoot: temp,
    appServer: false,
    appServerEndpoint: 'ws://127.0.0.1:60606',
    capture: 'ordinary scrollback that does not mention app-server',
  });

  try {
    const sessions = await reg.refresh();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].kind, 'codex');
    assert.equal(sessions[0].transport, 'rpc');
    assert.equal(sessions[0].endpoint, 'ws://127.0.0.1:60606');
    assert.equal(sessions[0].transcriptPath, null);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('normal Codex pane still uses cwd fallback when no exact rollout is open', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tui-session-'));
  const cwd = '/work/repo';
  const rollout = writeRollout(path.join(temp, ...codexDateDir()), cwd, 'live-session', new Date());
  const pane = makePane({ cwd, target: 'test:2.1', paneId: '%codextui', windowName: 'codex-tui' });
  const reg = makeRegistry({
    pane,
    codexSessionsRoot: temp,
    capture: [
      'model: gpt-5.5',
      'The transcript can mention codex app-server --listen ws://127.0.0.1:60606',
      '› Ready',
    ].join('\n'),
  });

  try {
    const sessions = await reg.refresh();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].kind, 'codex');
    assert.equal(sessions[0].transport, 'tmux');
    assert.equal(sessions[0].transcriptPath, rollout);
    assert.equal(sessions[0].sessionId, 'live-session');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('explicit Codex rpc pane marker is preserved in session transport', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rpc-session-'));
  const cwd = '/work/repo';
  const pane = makePane({
    cwd,
    target: 'test:3.1',
    paneId: '%codexrpc',
    ccTransport: 'rpc',
    ccEndpoint: 'ws://127.0.0.1:60606',
  });
  const reg = makeRegistry({
    pane,
    codexSessionsRoot: temp,
    appServer: true,
    capture: [
      'codex app-server (WebSockets)',
      '  listening on: ws://127.0.0.1:60606',
    ].join('\n'),
  });

  try {
    const sessions = await reg.refresh();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].kind, 'codex');
    assert.equal(sessions[0].transport, 'rpc');
    assert.equal(sessions[0].endpoint, 'ws://127.0.0.1:60606');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
