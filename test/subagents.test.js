import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SubAgentsWatcher,
  CodexSubAgentsWatcher,
  hasActiveSubAgents,
  listAgents,
  _agentsCacheSizeForTest,
  _bustAgentsCache,
} from '../lib/subagents.js';

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

test('listAgents cache is bounded by LRU eviction', () => {
  _bustAgentsCache();
  const orig = process.env.HOME;
  const tmp = makeTmpDir();
  process.env.HOME = tmp;
  try {
    for (let i = 0; i < 160; i++) {
      listAgents(path.join(tmp, `project-${i}`));
    }
    assert.equal(_agentsCacheSizeForTest(), 128);
  } finally {
    process.env.HOME = orig;
    _bustAgentsCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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

test('historical agents stay summary-only and load one bounded transcript on demand', async () => {
  const tmp = makeTmpDir();
  const parentPath = path.join(tmp, 'session.jsonl');
  fs.writeFileSync(parentPath, '');
  const subDir = path.join(tmp, 'session', 'subagents');
  const old = new Date(Date.now() - 120_000);
  for (let i = 0; i < 80; i++) {
    const id = `historical-${i}`;
    writeAgentFiles(subDir, id, {
      jsonlContent: `${JSON.stringify({ type: 'assistant', uuid: id, message: { content: 'done' } })}\n`,
    });
    fs.utimesSync(path.join(subDir, `agent-${id}.jsonl`), old, old);
  }

  const watcher = new SubAgentsWatcher(parentPath);
  watcher.poll();
  assert.equal([...watcher._agents.values()].filter((a) => a.tailer).length, 0);
  assert.equal(watcher.snapshot().every((a) => a.messagesLoaded === false), true);

  const loaded = await watcher.load('historical-40');
  assert.equal(loaded.messagesLoaded, true);
  assert.equal(loaded.messages.length, 1);
  assert.equal([...watcher._agents.values()].filter((a) => a.tailer).length, 0);

  watcher.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('large historical discovery defers transcript, nested, and definition enrichment', () => {
  const tmp = makeTmpDir();
  const parentPath = path.join(tmp, 'session.jsonl');
  fs.writeFileSync(parentPath, '');
  const subDir = path.join(tmp, 'session', 'subagents');
  const old = new Date(Date.now() - 120_000);
  for (let i = 0; i < 400; i++) {
    const id = `archived-${i}`;
    writeAgentFiles(subDir, id, { jsonlContent: '{}\n' });
    fs.utimesSync(path.join(subDir, `agent-${id}.jsonl`), old, old);
  }

  const watcher = new SubAgentsWatcher(parentPath);
  let modelReads = 0;
  let nestedReads = 0;
  watcher._readLatestModel = () => { modelReads++; return null; };
  watcher._readNested = () => { nestedReads++; return []; };
  watcher.poll();

  const snapshot = watcher.snapshot();
  assert.equal(snapshot.length, 400);
  assert.equal(modelReads, 0, 'summary discovery must not read transcript tails');
  assert.equal(nestedReads, 0, 'summary discovery must not scan nested directories');
  assert.equal(snapshot.every((agent) => agent.model === null && agent.def === null), true);
  assert.equal([...watcher._agents.values()].filter((agent) => agent.tailer).length, 0);

  watcher.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('historical transcript loads are globally limited to four at a time', async () => {
  const tmp = makeTmpDir();
  const parentPath = path.join(tmp, 'session.jsonl');
  fs.writeFileSync(parentPath, '');
  const subDir = path.join(tmp, 'session', 'subagents');
  const old = new Date(Date.now() - 120_000);
  for (let i = 0; i < 12; i++) {
    const id = `queued-${i}`;
    writeAgentFiles(subDir, id, { jsonlContent: '{}\n' });
    fs.utimesSync(path.join(subDir, `agent-${id}.jsonl`), old, old);
  }

  const watcher = new SubAgentsWatcher(parentPath);
  watcher.poll();
  let active = 0;
  let peak = 0;
  watcher._loadSnapshot = async (agent) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return watcher._entry(agent);
  };

  await Promise.all([...watcher._agents.keys()].map((id) => watcher.load(id)));
  assert.equal(peak, 4);

  watcher.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('poll discovers nested agents created after a live parent was tracked', () => {
  const tmp = makeTmpDir();
  const parentPath = path.join(tmp, 'session.jsonl');
  fs.writeFileSync(parentPath, '');
  const subDir = path.join(tmp, 'session', 'subagents');
  const agentId = 'parent-agent';
  writeAgentFiles(subDir, agentId, { jsonlContent: '{}\n' });

  const watcher = new SubAgentsWatcher(parentPath);
  watcher.poll();
  assert.deepEqual(watcher.snapshot()[0].nested, []);

  const nestedDir = path.join(subDir, agentId, 'subagents');
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(
    path.join(nestedDir, 'agent-child.meta.json'),
    JSON.stringify({ agentType: 'reviewer' }),
  );
  watcher.poll();

  assert.deepEqual(watcher.snapshot()[0].nested, [
    { agentId: 'child', agentType: 'reviewer', model: null },
  ]);

  watcher.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Regression: poll() must PUSH a purely time-based running->done transition.
//
// A finishing agent's transcript goes quiet -- no more 'append' events ever
// fire -- so nothing re-emits a 'change' frame when the freshness threshold
// later crosses from 'running' to 'done'. Without the _emitChange sweep at the
// end of poll(), this test fails: no 'change' event carries status 'done' for
// this agentId even though snapshot() correctly reports it as done.
// ---------------------------------------------------------------------------
test('poll emits a change event when a running agent silently goes done (time-based transition)', () => {
  const tmp = makeTmpDir();
  const parentPath = path.join(tmp, 'session.jsonl');
  fs.writeFileSync(parentPath, '');

  const subDir = path.join(tmp, 'session', 'subagents');
  const agentId = 'finishing0001';
  writeAgentFiles(subDir, agentId, { jsonlContent: '{"type":"assistant"}\n' });

  const watcher = new SubAgentsWatcher(parentPath);
  // Stub the follower for determinism — no real disk tailing/async I/O (mirrors
  // how 'large historical discovery...' stubs _readNested/_readLatestModel).
  watcher._startFollower = () => {};

  const changes = [];
  watcher.on('change', (entry) => changes.push(entry));

  watcher.poll();
  assert.equal(watcher.snapshot()[0].status, 'running', 'fresh agent should poll as running');
  assert.equal(changes.length, 0, 'discovery itself does not emit a change');

  // Back-date the jsonl mtime past RUNNING_WINDOW_MS (45s) so the agent goes
  // quiet -- the file itself never changes again, only the clock does.
  const jsonlPath = path.join(subDir, `agent-${agentId}.jsonl`);
  const sixtySecondsAgo = new Date(Date.now() - 60_000);
  fs.utimesSync(jsonlPath, sixtySecondsAgo, sixtySecondsAgo);

  watcher.poll();
  assert.equal(watcher.snapshot()[0].status, 'done', 'agent should now read as done');

  const doneChange = changes.find((c) => c.agentId === agentId && c.status === 'done');
  assert.ok(doneChange, 'poll must emit a change event with status="done" for the finished agent');

  watcher.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// R10: _agents never shrank on its own -- trim() only strips heavy fields,
// markDone() only flips a flag, full clear only happened on stop(). poll()
// now prunes entries that are both 'done' (_statusFor) AND whose jsonl file
// is gone from disk, so a long-running server doesn't accumulate an
// unbounded _agents Map across many completed sub-agent runs.
// ---------------------------------------------------------------------------
test('poll prunes done agents whose jsonl has been deleted, keeps _agents bounded', () => {
  const tmp = makeTmpDir();
  const parentPath = path.join(tmp, 'session.jsonl');
  fs.writeFileSync(parentPath, '');
  const subDir = path.join(tmp, 'session', 'subagents');

  const old = new Date(Date.now() - 120_000); // past RUNNING_WINDOW_MS (45s) -> done
  const goneIds = [];
  for (let i = 0; i < 20; i++) {
    const id = `gone-${i}`;
    goneIds.push(id);
    writeAgentFiles(subDir, id, { jsonlContent: '{}\n' });
    fs.utimesSync(path.join(subDir, `agent-${id}.jsonl`), old, old);
  }
  // One agent that stays done but keeps its jsonl on disk -- must survive the
  // prune (still loadable historical data, not dead weight).
  writeAgentFiles(subDir, 'stays-done', { jsonlContent: '{}\n' });
  fs.utimesSync(path.join(subDir, 'agent-stays-done.jsonl'), old, old);
  // One live agent -- must survive the prune (not done).
  writeAgentFiles(subDir, 'still-running', { jsonlContent: '{}\n' });

  const watcher = new SubAgentsWatcher(parentPath);
  watcher.poll();
  assert.equal(watcher._agents.size, 22, 'all 22 agents tracked after first poll');

  // Delete the jsonl files for the "gone" agents only, simulating cleanup
  // elsewhere on disk (or a very old session dir being reaped).
  for (const id of goneIds) {
    fs.unlinkSync(path.join(subDir, `agent-${id}.jsonl`));
  }

  watcher.poll();
  assert.equal(watcher._agents.size, 2, '_agents must shrink to just the surviving 2 entries');
  assert.ok(watcher._agents.has('stays-done'), 'done agent with jsonl still on disk must survive prune');
  assert.ok(watcher._agents.has('still-running'), 'running agent must survive prune regardless of jsonl state');
  for (const id of goneIds) {
    assert.ok(!watcher._agents.has(id), `pruned agent ${id} must be gone from _agents`);
  }

  // A further poll() with nothing changed must stay stable (idempotent).
  watcher.poll();
  assert.equal(watcher._agents.size, 2, 'prune is idempotent across repeated poll() calls');

  watcher.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});
