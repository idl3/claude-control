/**
 * test/turn-complete.test.js
 *
 * Unit tests for extractTailRecord()'s `turnComplete` field — the hard JSONL
 * evidence the SessionRegistry uses to clear a stale "working…" indicator.
 *
 * turnComplete is true ONLY when the NEWEST MAIN-LINE conversation record is a
 * terminal assistant turn (stop_reason ∈ end_turn / stop_sequence / max_tokens).
 * If any main-line record is newer than it — a fresh user turn, or a pending
 * tool_result — the agent is still working → false. `tool_use` and `pause_turn`
 * are mid-turn → false. Sub-agent (sidechain) records are skipped entirely: a
 * sidechain's end_turn is not the main turn's end.
 *
 * Run: node --test test/turn-complete.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { extractTailRecord } from '../lib/sessions.js';

let seq = 0;
/** Write JSONL records to a fresh temp file and return its path. */
function writeJsonl(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-turn-'));
  const file = path.join(dir, `t-${seq++}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const TS = '2026-01-01T00:00:00.000Z';
const userText = (text) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
  timestamp: TS,
  cwd: '/x',
  sessionId: 's1',
});
const assistant = (stopReason, text = 'ok') => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    model: 'claude-opus-4-8',
    stop_reason: stopReason,
    content: [{ type: 'text', text }],
    usage: { input_tokens: 10 },
  },
  timestamp: TS,
  cwd: '/x',
  sessionId: 's1',
});
const assistantToolUse = (id) => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    model: 'claude-opus-4-8',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }],
  },
  timestamp: TS,
  cwd: '/x',
  sessionId: 's1',
});
const userToolResult = (id) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] },
  timestamp: TS,
  cwd: '/x',
  sessionId: 's1',
});
// A sub-agent (sidechain) assistant record — marked isSidechain like a real
// Claude Code Task transcript. Must NOT count as the main turn's end.
const sidechainAssistant = (stopReason, text = 'subagent done') => ({
  type: 'assistant',
  isSidechain: true,
  parentUuid: 'sc-parent',
  message: {
    role: 'assistant',
    model: 'claude-opus-4-8',
    stop_reason: stopReason,
    content: [{ type: 'text', text }],
    usage: { input_tokens: 5 },
  },
  timestamp: TS,
  cwd: '/x',
  sessionId: 's1',
});

test('turnComplete=true when the last assistant record ended with end_turn', async () => {
  const file = writeJsonl([userText('hi'), assistant('end_turn', 'done')]);
  const rec = await extractTailRecord(file, Date.now());
  assert.equal(rec.turnComplete, true);
});

test('turnComplete=true for stop_sequence and max_tokens', async () => {
  for (const sr of ['stop_sequence', 'max_tokens']) {
    const file = writeJsonl([userText('hi'), assistant(sr)]);
    const rec = await extractTailRecord(file, Date.now());
    assert.equal(rec.turnComplete, true, `stop_reason ${sr} should complete the turn`);
  }
});

test('turnComplete=false when the last assistant record is a tool_use (mid-turn)', async () => {
  const file = writeJsonl([userText('run ls'), assistantToolUse('tu_1')]);
  const rec = await extractTailRecord(file, Date.now());
  assert.equal(rec.turnComplete, false);
});

test('turnComplete=false for pause_turn (agent will resume)', async () => {
  const file = writeJsonl([userText('hi'), assistant('pause_turn')]);
  const rec = await extractTailRecord(file, Date.now());
  assert.equal(rec.turnComplete, false);
});

test('turnComplete=false when a user tool_result trails the newest assistant (mid-tool-loop)', async () => {
  // Agent called a tool (tool_use), the tool result came back, but the agent
  // has NOT yet produced its next assistant turn — the turn is still open.
  const file = writeJsonl([
    userText('run ls'),
    assistantToolUse('tu_1'),
    userToolResult('tu_1'),
  ]);
  const rec = await extractTailRecord(file, Date.now());
  assert.equal(rec.turnComplete, false);
});

test('turnComplete=true when a completed assistant turn FOLLOWS a resolved tool loop', async () => {
  // tool_use → tool_result → assistant end_turn: the newest record is the
  // terminal assistant turn with no tool_result after it.
  const file = writeJsonl([
    userText('run ls'),
    assistantToolUse('tu_1'),
    userToolResult('tu_1'),
    assistant('end_turn', 'here are the files'),
  ]);
  const rec = await extractTailRecord(file, Date.now());
  assert.equal(rec.turnComplete, true);
});

test('turnComplete=false when there is no assistant record at all', async () => {
  const file = writeJsonl([userText('hi'), userText('anyone there?')]);
  const rec = await extractTailRecord(file, Date.now());
  assert.equal(rec.turnComplete, false);
});

test('turnComplete=false when a NEW user turn follows a prior end_turn (P2 stale)', async () => {
  // A long single-shot follow-up: the user sent a new message after the prior
  // turn's end_turn, and the assistant is now generating (no new assistant
  // record yet). Reading the STALE prior end_turn must NOT force-idle the
  // still-working session — the newest main-line record is the user message.
  const file = writeJsonl([
    userText('hi'),
    assistant('end_turn', 'first answer'),
    userText('now do the big thing'),
  ]);
  const rec = await extractTailRecord(file, Date.now());
  assert.equal(rec.turnComplete, false);
});

test('turnComplete=false when a sidechain end_turn is newest but the main line still works (P3)', async () => {
  // Main line is mid-tool-loop (tool_use, no result yet). A sub-agent finished
  // and wrote a sidechain end_turn as the newest record. The sidechain terminal
  // record must be skipped: the main turn is NOT complete.
  const file = writeJsonl([
    userText('spawn a subagent and keep working'),
    assistantToolUse('tu_1'),
    sidechainAssistant('end_turn'),
  ]);
  const rec = await extractTailRecord(file, Date.now());
  assert.equal(rec.turnComplete, false);
});

test('turnComplete=false when stop_reason is absent on the newest assistant record', async () => {
  const noStop = {
    type: 'assistant',
    message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'streaming…' }] },
    timestamp: TS,
    cwd: '/x',
    sessionId: 's1',
  };
  const file = writeJsonl([userText('hi'), noStop]);
  const rec = await extractTailRecord(file, Date.now());
  assert.equal(rec.turnComplete, false);
});
