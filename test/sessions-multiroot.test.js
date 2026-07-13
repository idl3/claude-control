import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { SessionRegistry, encodeCwd } from '../lib/sessions.js';

function makePane({
  target = 'test:1.1',
  paneId,
  windowName = 'repo',
  cwd = '/work/repo',
  cmd = '2.1.0',
} = {}) {
  return {
    target,
    sessionName: 'test',
    windowIndex: 1,
    paneIndex: 1,
    windowId: '@m',
    paneId,
    windowName,
    active: true,
    cwd,
    cmd,
    ccShell: false,
    ccTransport: null,
    ccEndpoint: null,
    panePid: 4242,
  };
}

function makeRegistry({ pane, projectsRoots }) {
  const reg = new SessionRegistry({
    projectsRoots,
    tmux: {
      listWindows: async () => [pane],
      capturePane: async () => '',
      isValidTarget: () => true,
    },
  });
  reg._buildPaneProc = async () => new Map([
    [pane.target, {
      isClaude: true,
      isCodex: false,
      kind: 'claude',
      startMs: Date.now() - 5000,
      pid: 4242,
      resumeSessionId: null,
      appServer: false,
      appServerEndpoint: null,
    }],
  ]);
  return reg;
}

function writeAltTranscript(altProjects, cwd, uuid) {
  const slug = encodeCwd(cwd);
  const dir = path.join(altProjects, slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${uuid}.jsonl`);
  const now = new Date();
  const rec = {
    type: 'assistant',
    cwd,
    sessionId: uuid,
    timestamp: now.toISOString(),
    message: { model: 'claude-x', content: [{ type: 'text', text: 'hello multiroot' }] },
  };
  fs.writeFileSync(file, JSON.stringify(rec) + '\n');
  fs.utimesSync(file, now, now);
  return file;
}

test('a transcript under an alternate (sibling) root binds to a cwd-matching pane', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-multiroot-'));
  const primary = path.join(temp, 'primary'); // left empty/nonexistent
  const altProjects = path.join(temp, 'alt', 'projects');
  const cwd = '/work/repo';
  const uuid = crypto.randomUUID();
  const altFile = writeAltTranscript(altProjects, cwd, uuid);

  const paneId = `%multiroot-${Math.random().toString(36).slice(2)}`;
  const pane = makePane({ cwd, paneId });

  try {
    const reg = makeRegistry({ pane, projectsRoots: [primary, altProjects] });
    await reg.refresh();
    const session = reg.getSessions().find((s) => s.target === pane.target);
    assert.ok(session, 'pane produced a session row');
    assert.equal(session.transcriptPath, altFile);
    assert.equal(session.sessionId, uuid);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('single-root behavior is preserved when only the alt root is configured', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-multiroot-single-'));
  const altProjects = path.join(temp, 'alt', 'projects');
  const cwd = '/work/repo';
  const uuid = crypto.randomUUID();
  const altFile = writeAltTranscript(altProjects, cwd, uuid);

  const paneId = `%multiroot-${Math.random().toString(36).slice(2)}`;
  const pane = makePane({ cwd, paneId, target: 'test:2.1' });

  try {
    const reg = makeRegistry({ pane, projectsRoots: [altProjects] });
    await reg.refresh();
    const session = reg.getSessions().find((s) => s.target === pane.target);
    assert.ok(session, 'pane produced a session row');
    assert.equal(session.transcriptPath, altFile);
    assert.equal(session.sessionId, uuid);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
