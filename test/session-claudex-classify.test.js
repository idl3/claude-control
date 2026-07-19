// CP3 Fix 1: teach the pane classifier about @cc_agent='claudex'.
//
// Claudex spawns the REAL claude binary (server.js's claudex branch just
// injects ANTHROPIC_BASE_URL via tmux -e and tags the pane option
// @cc_agent='claudex' — see server.js's handleSessionNew). That means the
// ps-based process fallback (_buildPaneProc) would classify a claudex pane
// as plain 'claude' if the @cc_agent tag weren't checked FIRST and given
// priority — this is the exact regression this file locks in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { SessionRegistry, encodeCwd, isClaudeKind } from '../lib/sessions.js';

function makePane({
  target = 'test:1.1',
  paneId,
  windowName = 'repo',
  cwd = '/work/repo',
  cmd = '2.1.162', // the claude version string — identical for claude AND claudex, since claudex runs the same binary
  ccAgent = null,
  ccTransport = null,
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
    ccAgent,
    ccTransport,
    ccEndpoint: null,
    panePid: 4242,
  };
}

/** Registry whose _buildPaneProc mirrors what the REAL ps-based fallback would
 *  report for a claudex pane: it IS the claude binary, so ps-based detection
 *  says isClaude:true, kind:'claude' — exactly the misclassification the
 *  @cc_agent tag priority check must override. */
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
      kind: 'claude', // the ps-based classification claudex would ALSO get, absent the tag
      startMs: Date.now() - 5000,
      pid: 4242,
      resumeSessionId: null,
      appServer: false,
      appServerEndpoint: null,
    }],
  ]);
  return reg;
}

function writeTranscript(projectsRoot, cwd, uuid) {
  const slug = encodeCwd(cwd);
  const dir = path.join(projectsRoot, slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${uuid}.jsonl`);
  const now = new Date();
  const rec = {
    type: 'assistant',
    cwd,
    sessionId: uuid,
    timestamp: now.toISOString(),
    message: { model: 'claude-x', content: [{ type: 'text', text: 'hello claudex' }] },
  };
  fs.writeFileSync(file, JSON.stringify(rec) + '\n');
  fs.utimesSync(file, now, now);
  return file;
}

test('@cc_agent=claudex pane classifies as kind "claudex" (not "claude"), tmux transport, transcript-bound', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-claudex-classify-'));
  const projectsRoot = path.join(temp, 'projects');
  const cwd = '/work/repo';
  const uuid = crypto.randomUUID();
  const file = writeTranscript(projectsRoot, cwd, uuid);
  const paneId = `%claudex-${Math.random().toString(36).slice(2)}`;
  const pane = makePane({ cwd, paneId, ccAgent: 'claudex' });

  try {
    const reg = makeRegistry({ pane, projectsRoots: [projectsRoot] });
    await reg.refresh();
    const session = reg.getSessions().find((s) => s.target === pane.target);
    assert.ok(session, 'pane produced a session row');
    assert.equal(session.kind, 'claudex', 'the @cc_agent tag must win over the ps-based "claude" fallback');
    assert.equal(session.isClaude, true, 'claudex is claude-flavored for pane treatment');
    assert.equal(session.transport, 'tmux');
    assert.equal(session.transcriptPath, file, 'claudex writes a normal claude-format transcript and must bind to it');
    assert.equal(session.sessionId, uuid);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('@cc_agent=claudemi pane classifies as kind "claudemi" (not "claude"), tmux transport, transcript-bound', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-claudemi-classify-'));
  const projectsRoot = path.join(temp, 'projects');
  const cwd = '/work/repo';
  const uuid = crypto.randomUUID();
  const file = writeTranscript(projectsRoot, cwd, uuid);
  const paneId = `%claudemi-${Math.random().toString(36).slice(2)}`;
  const pane = makePane({ cwd, paneId, target: 'test:4.1', ccAgent: 'claudemi' });

  try {
    const reg = makeRegistry({ pane, projectsRoots: [projectsRoot] });
    await reg.refresh();
    const session = reg.getSessions().find((s) => s.target === pane.target);
    assert.ok(session, 'pane produced a session row');
    assert.equal(session.kind, 'claudemi', 'the @cc_agent tag must win over the ps-based "claude" fallback');
    assert.equal(session.isClaude, true, 'claudemi is claude-flavored for pane treatment');
    assert.equal(session.transport, 'tmux');
    assert.equal(session.transcriptPath, file, 'claudemi writes a normal claude-format transcript and must bind to it');
    assert.equal(session.sessionId, uuid);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('control: @cc_agent=claude pane still classifies as kind "claude" (unaffected baseline)', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-claude-classify-'));
  const projectsRoot = path.join(temp, 'projects');
  const cwd = '/work/repo';
  const uuid = crypto.randomUUID();
  writeTranscript(projectsRoot, cwd, uuid);
  const paneId = `%claude-${Math.random().toString(36).slice(2)}`;
  const pane = makePane({ cwd, paneId, target: 'test:2.1', ccAgent: 'claude' });

  try {
    const reg = makeRegistry({ pane, projectsRoots: [projectsRoot] });
    await reg.refresh();
    const session = reg.getSessions().find((s) => s.target === pane.target);
    assert.ok(session);
    assert.equal(session.kind, 'claude');
    assert.equal(session.isClaude, true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('control: no @cc_agent tag falls back to ps-based classification ("claude") — pre-existing behavior unchanged', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-untagged-classify-'));
  const projectsRoot = path.join(temp, 'projects');
  const cwd = '/work/repo';
  const uuid = crypto.randomUUID();
  writeTranscript(projectsRoot, cwd, uuid);
  const paneId = `%untagged-${Math.random().toString(36).slice(2)}`;
  const pane = makePane({ cwd, paneId, target: 'test:3.1', ccAgent: null });

  try {
    const reg = makeRegistry({ pane, projectsRoots: [projectsRoot] });
    await reg.refresh();
    const session = reg.getSessions().find((s) => s.target === pane.target);
    assert.ok(session);
    assert.equal(session.kind, 'claude');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

// ── isClaudeKind (exported helper) — the single source of truth every
// claude-pane behavior gate (lib/sessions.js, lib/picker-send-guard.js via
// server.js) is built on. ─────────────────────────────────────────────────

test('isClaudeKind: true for claude, claudex, and claudemi; false for codex/terminal/null/undefined', () => {
  assert.equal(isClaudeKind('claude'), true);
  assert.equal(isClaudeKind('claudex'), true);
  assert.equal(isClaudeKind('claudemi'), true);
  assert.equal(isClaudeKind('codex'), false);
  assert.equal(isClaudeKind('terminal'), false);
  assert.equal(isClaudeKind(null), false);
  assert.equal(isClaudeKind(undefined), false);
});
