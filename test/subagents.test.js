import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SubAgentsWatcher } from '../lib/subagents.js';

// ---------------------------------------------------------------------------
// Helper: set up a minimal on-disk subagents dir with one agent fixture.
// ---------------------------------------------------------------------------
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'subagents-test-'));
}

function writeAgentFiles(subagentsDir, agentId, { metaContent = null, jsonlContent = '' } = {}) {
  fs.mkdirSync(subagentsDir, { recursive: true });
  const meta = metaContent ?? JSON.stringify({ agentType: 'test-agent', description: 'test', toolUseId: `tu-${agentId}` });
  fs.writeFileSync(path.join(subagentsDir, `agent-${agentId}.meta.json`), meta);
  fs.writeFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`), jsonlContent);
}

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

test('agent with stale jsonl (>45 s old, <600 s) shows status=running', async () => {
  const tmp = makeTmpDir();
  const parentPath = path.join(tmp, 'session.jsonl');
  fs.writeFileSync(parentPath, '');

  const subDir = path.join(tmp, 'session', 'subagents');
  const agentId = 'stale0000001';
  writeAgentFiles(subDir, agentId, { jsonlContent: '{"type":"assistant"}\n' });

  // Back-date the jsonl mtime to 60 s ago (> old 45 s window, < new 600 s window).
  const jsonlPath = path.join(subDir, `agent-${agentId}.jsonl`);
  const sixtySecondsAgo = new Date(Date.now() - 60_000);
  fs.utimesSync(jsonlPath, sixtySecondsAgo, sixtySecondsAgo);

  const watcher = new SubAgentsWatcher(parentPath);
  watcher.poll();

  const snap = watcher.snapshot();
  assert.equal(snap.length, 1, 'expected 1 sub-agent in snapshot');
  assert.equal(snap[0].status, 'running',
    `agent 60 s stale should still be 'running' with 600 s window, got '${snap[0].status}'`);

  watcher.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('agent with very stale jsonl (>600 s old) shows status=done', async () => {
  const tmp = makeTmpDir();
  const parentPath = path.join(tmp, 'session.jsonl');
  fs.writeFileSync(parentPath, '');

  const subDir = path.join(tmp, 'session', 'subagents');
  const agentId = 'ancient00001';
  writeAgentFiles(subDir, agentId, { jsonlContent: '{"type":"assistant"}\n' });

  // Back-date to 601 s ago — beyond the new window.
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
