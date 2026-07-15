import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Redirect the pane registry to a temp dir BEFORE importing the lib, so the
// module-level PANES_DIR (which honors CC_PANES_DIR) points at the sandbox.
const PANES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-panes-'));
process.env.CC_PANES_DIR = PANES_DIR;

const { SessionRegistry } = await import('../lib/sessions.js');

function codexDateDir(date = new Date()) {
  return [String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')];
}

function writeRollout(dir, cwd, sessionId, when = new Date()) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${sessionId}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd }, timestamp: when.toISOString() }) + '\n');
  fs.utimesSync(file, when, when);
  return file;
}

function makePane({ cwd, paneId = '%codextui' } = {}) {
  return {
    target: 'test:1.1', sessionName: 'test', windowIndex: 1, paneIndex: 1,
    windowId: '@codextui', paneId, windowName: 'work', active: true,
    cwd, cmd: 'codex', ccShell: false, ccTransport: null, ccEndpoint: null, panePid: 12345,
  };
}

function makeRegistry({ pane, codexSessionsRoot, findOpenRollout }) {
  const reg = new SessionRegistry({
    projectsRoot: path.join(os.tmpdir(), 'no-claude-projects'),
    codexSessionsRoot,
    findOpenRollout,
    tmux: { listWindows: async () => [pane], capturePane: async () => '', isValidTarget: () => true },
  });
  reg._buildPaneProc = async () => new Map([[pane.target, {
    isClaude: false, isCodex: true, kind: 'codex', startMs: Date.now() - 5000, pid: 12345, appServer: false, appServerEndpoint: null,
  }]]);
  return reg;
}

test('interactive Codex pane persists its lsof-resolved binding to the pane registry', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-persist-'));
  const cwd = '/work/repo';
  const rollout = writeRollout(path.join(temp, ...codexDateDir()), cwd, 'live-session');
  const pane = makePane({ cwd });
  const reg = makeRegistry({ pane, codexSessionsRoot: temp, findOpenRollout: async () => rollout });

  const sessions = await reg.refresh();
  assert.equal(sessions[0].kind, 'codex');
  assert.equal(sessions[0].transcriptPath, rollout, 'pane bound to the lsof rollout');

  const regFile = path.join(PANES_DIR, 'codextui.json');
  assert.ok(fs.existsSync(regFile), 'registry record written for the codex pane');
  const record = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  assert.equal(record.paneId, '%codextui');
  assert.equal(record.transcriptPath, rollout);
  assert.equal(record.sessionId, 'live-session');
  assert.equal(record.cwd, cwd);
});

test('a new codex instance in the same pane takes over the registry entry', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-takeover-'));
  const cwd = '/work/repo';
  const oldRollout = writeRollout(path.join(temp, ...codexDateDir()), cwd, 'old-session', new Date(Date.now() - 60000));
  const pane = makePane({ cwd });

  // First session binds + persists.
  await makeRegistry({ pane, codexSessionsRoot: temp, findOpenRollout: async () => oldRollout }).refresh();
  const regFile = path.join(PANES_DIR, 'codextui.json');
  assert.equal(JSON.parse(fs.readFileSync(regFile, 'utf8')).sessionId, 'old-session');

  // New instance in the SAME pane opens a new rollout → overwrite (takeover).
  const newRollout = writeRollout(path.join(temp, ...codexDateDir()), cwd, 'new-session');
  await makeRegistry({ pane, codexSessionsRoot: temp, findOpenRollout: async () => newRollout }).refresh();
  const after = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  assert.equal(after.sessionId, 'new-session', 'new session took over the pane binding');
  assert.equal(after.transcriptPath, newRollout);
});
