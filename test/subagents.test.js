import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SubAgentsWatcher, CodexSubAgentsWatcher, hasActiveSubAgents } from '../lib/subagents.js';

// ---------------------------------------------------------------------------
// Helper: set up a minimal on-disk subagents dir with one agent fixture.
// ---------------------------------------------------------------------------
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'subagents-test-'));
}

function writeAgentFiles(subagentsDir, agentId, { metaContent = null, jsonlContent = '', skipMeta = false } = {}) {
  fs.mkdirSync(subagentsDir, { recursive: true });
  if (!skipMeta) {
    const meta = metaContent ?? JSON.stringify({ agentType: 'test-agent', description: 'test', toolUseId: `tu-${agentId}` });
    fs.writeFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`), meta);
  }
  fs.writeFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`), jsonlContent);
}

test('CodexSubAgentsWatcher ingests notifications as SubAgent entries', () => {
  const watcher = new CodexSubAgentsWatcher();
  const changes = [];
  watcher.on('change', (entry) => changes.push(entry));

  watcher.ingest({
    agentId: 'codex-agent-1',
    agentPath: 'parent/codex-agent-1',
    status: 'running',
    state: 'running',
    result: null,
    error: null,
    rawStatus: { running: true },
  });
  watcher.ingest({
    agentId: 'codex-agent-1',
    agentPath: 'parent/codex-agent-1',
    status: 'done',
    state: 'completed',
    result: 'Implemented the parser.',
    error: null,
    rawStatus: { completed: 'Implemented the parser.' },
  });

  const snap = watcher.snapshot();
  assert.equal(changes.length, 2);
  assert.equal(snap.length, 1);
  assert.equal(snap[0].agentId, 'codex-agent-1');
  assert.equal(snap[0].agentType, 'codex');
  assert.equal(snap[0].description, 'parent/codex-agent-1');
  assert.equal(snap[0].status, 'done');
  assert.equal(snap[0].messages.length, 2);
  assert.equal(snap[0].messages[1].blocks[0].text, 'Implemented the parser.');

  watcher.stop();
});

// ---------------------------------------------------------------------------
// RUNNING_WINDOW_MS behaviour (regression guard for the 45 s → 600 s fix).
// ---------------------------------------------------------------------------

test('agent with recently-written jsonl shows status=running', async () => {
  const tmp = makeTmpDir();
  // parent transcript path: <tmp>/session.jsonl
  const parentPath = path.join(tmp, 'session.jsonl');
  fs.writeFileSync(parentPath, '');

  const subDir = path.join(tmp, 'session', 'subagents');
  const agentId = 'deadbeef1234';
  writeAgentFiles(subDir, agentId, { jsonlContent: '{"type":"assistant"}\n' });

  const watcher = new SubAgentsWatcher(parentPath);
  watcher.poll();

  const snap = watcher.snapshot();
  assert.equal(snap.length, 1, 'expected 1 sub-agent in snapshot');
  assert.equal(snap[0].status, 'running',
    `agent with fresh mtime should be 'running', got '${snap[0].status}'`);

  watcher.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// PLE-57 regression: finished agents (quiet file > RUNNING_WINDOW = 45 s, no
// doneByParent) must show 'done' promptly — NOT 'running' for 10 minutes.
// This test FAILS against the old 600 s RUNNING_WINDOW_MS and passes with 45 s.
test('finished agent (quiet file 60 s, doneByParent=false) shows status=done (PLE-57 teeth)', async () => {
  const tmp = makeTmpDir();
  const parentPath = path.join(tmp, 'session.jsonl');
  fs.writeFileSync(parentPath, '');

  const subDir = path.join(tmp, 'session', 'subagents');
  const agentId = 'stale0000001';
  writeAgentFiles(subDir, agentId, { jsonlContent: '{"type":"assistant"}\n' });

  // Back-date the jsonl mtime to 60 s ago (> RUNNING_WINDOW 45 s, doneByParent never set).
  // With the old 600 s window this reads 'running'; with 45 s it correctly reads 'done'.
  const jsonlPath = path.join(subDir, `agent-${agentId}.jsonl`);
  const sixtySecondsAgo = new Date(Date.now() - 60_000);
  fs.utimesSync(jsonlPath, sixtySecondsAgo, sixtySecondsAgo);

  const watcher = new SubAgentsWatcher(parentPath);
  watcher.poll();

  const snap = watcher.snapshot();
  assert.equal(snap.length, 1, 'expected 1 sub-agent in snapshot');
  assert.equal(snap[0].status, 'done',
    `finished agent (60 s quiet, no doneByParent) should be 'done' within 45 s window, got '${snap[0].status}'`);

  watcher.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('agent with very stale jsonl (>45 s old) shows status=done', async () => {
  const tmp = makeTmpDir();
  const parentPath = path.join(tmp, 'session.jsonl');
  fs.writeFileSync(parentPath, '');

  const subDir = path.join(tmp, 'session', 'subagents');
  const agentId = 'ancient00001';
  writeAgentFiles(subDir, agentId, { jsonlContent: '{"type":"assistant"}\n' });

  // Back-date to 601 s ago — well beyond RUNNING_WINDOW (45 s).
  const jsonlPath = path.join(subDir, `agent-${agentId}.jsonl`);
  const old = new Date(Date.now() - 601_000);
  fs.utimesSync(jsonlPath, old, old);

  const watcher = new SubAgentsWatcher(parentPath);
  watcher.poll();

  const snap = watcher.snapshot();
  assert.equal(snap.length, 1, 'expected 1 sub-agent in snapshot');
  assert.equal(snap[0].status, 'done',
    `agent 601 s stale should be 'done', got '${snap[0].status}'`);

  watcher.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Agent quiet for 30 s (> ACTIVE_WINDOW 20 s, < RUNNING_WINDOW 45 s) stays running.
// This guards against over-eager expiry for slow-but-still-running agents.
test('agent quiet for 30 s (inside RUNNING_WINDOW of 45 s) stays running', async () => {
  const tmp = makeTmpDir();
  const parentPath = path.join(tmp, 'session.jsonl');
  fs.writeFileSync(parentPath, '');

  const subDir = path.join(tmp, 'session', 'subagents');
  const agentId = 'slowagent0001';
  writeAgentFiles(subDir, agentId, { jsonlContent: '{"type":"assistant"}\n' });

  const jsonlPath = path.join(subDir, `agent-${agentId}.jsonl`);
  const thirtySecondsAgo = new Date(Date.now() - 30_000);
  fs.utimesSync(jsonlPath, thirtySecondsAgo, thirtySecondsAgo);

  const watcher = new SubAgentsWatcher(parentPath);
  watcher.poll();

  const snap = watcher.snapshot();
  assert.equal(snap.length, 1, 'expected 1 sub-agent in snapshot');
  assert.equal(snap[0].status, 'running',
    `agent 30 s quiet (inside 45 s RUNNING_WINDOW) should be 'running', got '${snap[0].status}'`);

  watcher.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a FRESH file stays running even after markDone (background launch-ack must not mark a still-writing agent done)', async () => {
  const tmp = makeTmpDir();
  const parentPath = path.join(tmp, 'session.jsonl');
  fs.writeFileSync(parentPath, '');

  const subDir = path.join(tmp, 'session', 'subagents');
  const agentId = 'freshandwriting';
  const toolUseId = 'tu-freshandwriting';
  writeAgentFiles(subDir, agentId, {
    metaContent: JSON.stringify({ agentType: 'test-agent', description: 'test', toolUseId }),
    jsonlContent: '{"type":"assistant"}\n',
  });

  const watcher = new SubAgentsWatcher(parentPath);
  watcher.poll();
  assert.equal(watcher.snapshot()[0].status, 'running', 'should be running before markDone');

  // A background agent's launch-ack tool_result arrives immediately → markDone —
  // but the file is still being written, so it must remain RUNNING.
  watcher.markDone(toolUseId);
  assert.equal(watcher.snapshot()[0].status, 'running',
    `fresh file must read running despite a premature doneByParent — got '${watcher.snapshot()[0].status}'`);

  watcher.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('doneByParent marks done once the file goes quiet (> ACTIVE_WINDOW)', async () => {
  const tmp = makeTmpDir();
  const parentPath = path.join(tmp, 'session.jsonl');
  fs.writeFileSync(parentPath, '');

  const subDir = path.join(tmp, 'session', 'subagents');
  const agentId = 'quietdone';
  const toolUseId = 'tu-quietdone';
  writeAgentFiles(subDir, agentId, {
    metaContent: JSON.stringify({ agentType: 'test-agent', description: 'test', toolUseId }),
    jsonlContent: '{"type":"assistant"}\n',
  });
  // Backdate the jsonl mtime past the active window so it reads as quiescent.
  const jsonl = path.join(subDir, `agent-${agentId}.jsonl`);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(jsonl, old, old);

  const watcher = new SubAgentsWatcher(parentPath);
  watcher.poll();
  watcher.markDone(toolUseId);

  assert.equal(watcher.snapshot()[0].status, 'done',
    'a quiet file + doneByParent should be done');

  watcher.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('poll discovers new agent file added after construction', async () => {
  const tmp = makeTmpDir();
  const parentPath = path.join(tmp, 'session.jsonl');
  fs.writeFileSync(parentPath, '');

  const subDir = path.join(tmp, 'session', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });

  const watcher = new SubAgentsWatcher(parentPath);
  watcher.poll();
  assert.equal(watcher.snapshot().length, 0, 'no agents yet');

  // Add agent AFTER watcher is constructed.
  const agentId = 'latearrival01';
  writeAgentFiles(subDir, agentId);

  watcher.poll();
  assert.equal(watcher.snapshot().length, 1, 'poll should discover the newly-added agent');

  watcher.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// hasActiveSubAgents — cheap per-session probe used by the rail (bug 3)
// ---------------------------------------------------------------------------

test('hasActiveSubAgents: true when an agent jsonl was written recently', () => {
  const tmp = makeTmpDir();
  const parentPath = path.join(tmp, 'sess.jsonl');
  fs.writeFileSync(parentPath, '');
  writeAgentFiles(path.join(tmp, 'sess', 'subagents'), 'a1', { jsonlContent: '{}\n' });
  assert.equal(hasActiveSubAgents(parentPath), true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('hasActiveSubAgents: false when the jsonl is stale (> window)', () => {
  const tmp = makeTmpDir();
  const parentPath = path.join(tmp, 'sess.jsonl');
  fs.writeFileSync(parentPath, '');
  const dir = path.join(tmp, 'sess', 'subagents');
  writeAgentFiles(dir, 'a1', { jsonlContent: '{}\n' });
  const old = Date.now() / 1000 - 120; // 120 s ago
  fs.utimesSync(path.join(dir, 'agent-a1.jsonl'), old, old);
  assert.equal(hasActiveSubAgents(parentPath), false);
  // ...but a generous window still counts it.
  assert.equal(hasActiveSubAgents(parentPath, 200_000), true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('hasActiveSubAgents: false when no subagents dir exists', () => {
  const tmp = makeTmpDir();
  const parentPath = path.join(tmp, 'sess.jsonl');
  fs.writeFileSync(parentPath, '');
  assert.equal(hasActiveSubAgents(parentPath), false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('hasActiveSubAgents: false for empty/missing transcript path', () => {
  assert.equal(hasActiveSubAgents(''), false);
  assert.equal(hasActiveSubAgents(null), false);
});

// ---------------------------------------------------------------------------
// TEETH: jsonl-only (no .meta.json) — the actual bug fix.
// Old code: poll() only found agents via META_RE → snapshot empty.
// New code: poll() finds agents via SUBAGENT_JSONL_RE → snapshot has 1 entry.
// ---------------------------------------------------------------------------

test('TEETH — jsonl-only (no .meta.json): hasActiveSubAgents true AND snapshot length=1 with correct agentId', () => {
  const tmp = makeTmpDir();
  const parentPath = path.join(tmp, 'session.jsonl');
  fs.writeFileSync(parentPath, '');

  const subDir = path.join(tmp, 'session', 'subagents');
  const agentId = 'nometaagent1';

  // Write ONLY the .jsonl — no .meta.json.
  writeAgentFiles(subDir, agentId, { jsonlContent: '{"type":"assistant"}\n', skipMeta: true });

  // hasActiveSubAgents must see it (rail signal).
  assert.equal(hasActiveSubAgents(parentPath), true,
    'hasActiveSubAgents should be true when jsonl exists and is fresh');

  // SubAgentsWatcher must also discover it (transcript/toolbar signal).
  const watcher = new SubAgentsWatcher(parentPath);
  watcher.poll();

  const snap = watcher.snapshot();
  assert.equal(snap.length, 1, 'snapshot should contain 1 sub-agent even without .meta.json');
  assert.equal(snap[0].agentId, agentId, 'agentId should match the discovered agent');
  // Meta fields default to null when .meta.json is absent — that is correct.
  assert.equal(snap[0].toolUseId, null, 'toolUseId should be null without meta');
  assert.equal(snap[0].agentType, null, 'agentType should be null without meta');

  watcher.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Meta-late upgrade: jsonl first → meta arrives on next poll.
// ---------------------------------------------------------------------------

test('meta-late upgrade: toolUseId/agentType null on first poll, populated after .meta.json arrives', () => {
  const tmp = makeTmpDir();
  const parentPath = path.join(tmp, 'session.jsonl');
  fs.writeFileSync(parentPath, '');

  const subDir = path.join(tmp, 'session', 'subagents');
  const agentId = 'metalateagent';

  // First: only the jsonl exists.
  writeAgentFiles(subDir, agentId, { jsonlContent: '{"type":"assistant"}\n', skipMeta: true });

  const changes = [];
  const watcher = new SubAgentsWatcher(parentPath);
  watcher.on('change', (entry) => changes.push(entry));
  watcher.poll();

  let snap = watcher.snapshot();
  assert.equal(snap.length, 1, 'should discover agent from jsonl alone');
  assert.equal(snap[0].toolUseId, null, 'toolUseId should be null before meta arrives');
  assert.equal(snap[0].agentType, null, 'agentType should be null before meta arrives');

  // Now the .meta.json arrives (as it does in practice a beat after the jsonl).
  const meta = JSON.stringify({ agentType: 'test-agent', description: 'doing work', toolUseId: `tu-${agentId}` });
  fs.writeFileSync(path.join(subDir, `agent-${agentId}.meta.json`), meta);

  watcher.poll(); // upgrade pass

  snap = watcher.snapshot();
  assert.equal(snap.length, 1, 'still 1 agent after meta upgrade (no duplicate)');
  assert.equal(snap[0].toolUseId, `tu-${agentId}`, 'toolUseId should be populated after meta upgrade');
  assert.equal(snap[0].agentType, 'test-agent', 'agentType should be populated after meta upgrade');
  assert.equal(snap[0].description, 'doing work', 'description should be populated after meta upgrade');

  // A 'change' event must have been emitted for the upgrade.
  const upgradedChanges = changes.filter((e) => e.toolUseId !== null);
  assert.ok(upgradedChanges.length >= 1, 'should emit a change event when meta fields are upgraded');

  watcher.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});
