import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  matchesProcess,
  buildTranscriptIndex,
  parseCodexRecord,
  detectPendingFromCapture,
  buildAnswerProgram,
  parseTuiStatus,
} from '../lib/codex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures', 'codex');

// ---------------------------------------------------------------------------
// 1. matchesProcess
// ---------------------------------------------------------------------------

test('matchesProcess: true for codex', () => {
  assert.equal(matchesProcess('codex'), true);
});

test('matchesProcess: true for /usr/local/bin/codex', () => {
  assert.equal(matchesProcess('/usr/local/bin/codex'), true);
});

test('matchesProcess: true for codex --foo', () => {
  assert.equal(matchesProcess('codex --foo'), true);
});

test('matchesProcess: false for codex-control', () => {
  assert.equal(matchesProcess('codex-control'), false);
});

test('matchesProcess: false for 2.1.162', () => {
  assert.equal(matchesProcess('2.1.162'), false);
});

test('matchesProcess: false for zsh', () => {
  assert.equal(matchesProcess('zsh'), false);
});

test('matchesProcess: false for empty string', () => {
  assert.equal(matchesProcess(''), false);
});

// ---------------------------------------------------------------------------
// 2. buildTranscriptIndex — discovery with injected clock
// ---------------------------------------------------------------------------

test('discovery: indexes sample-rollout.jsonl by cwd, sets agentType=codex', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
  // Use the same date the fixture session was captured on.
  const now = new Date('2026-06-21T12:00:00');
  // Compute YYYY/MM/DD using LOCAL date parts, same way the adapter does.
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const dateDir = path.join(temp, yyyy, mm, dd);
  fs.mkdirSync(dateDir, { recursive: true });

  const destFile = path.join(dateDir, 'rollout-test.jsonl');
  fs.copyFileSync(path.join(FIX, 'sample-rollout.jsonl'), destFile);

  try {
    const index = await buildTranscriptIndex({ codexSessionsRoot: temp }, now);
    assert.equal(index.byCwd.has('/private/tmp/codex-spike'), true);
    const rec = index.byCwd.get('/private/tmp/codex-spike');
    assert.equal(rec.agentType, 'codex');
    assert.equal(rec.sessionId, '019ee8dc-bd3a-7140-a6fa-43829d915da3');
    assert.equal(index.byDir, undefined);
  } finally {
    fs.rmSync(temp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 3. discovery resilience
// ---------------------------------------------------------------------------

test('discovery resilience: empty file and bad JSON do not throw, index nothing', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
  const now = new Date('2026-06-21T12:00:00');
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const dateDir = path.join(temp, yyyy, mm, dd);
  fs.mkdirSync(dateDir, { recursive: true });

  // Empty rollout file.
  fs.writeFileSync(path.join(dateDir, 'rollout-empty.jsonl'), '');
  // Invalid JSON rollout file.
  fs.writeFileSync(path.join(dateDir, 'rollout-bad.jsonl'), '{not json');

  let index;
  await assert.doesNotReject(async () => {
    index = await buildTranscriptIndex({ codexSessionsRoot: temp }, now);
  });
  assert.equal(index.byCwd.size, 0);

  fs.rmSync(temp, { recursive: true });
});

// ---------------------------------------------------------------------------
// 4. parseCodexRecord — per-type assertions
// ---------------------------------------------------------------------------

// Read relevant lines from the fixture for call_id linkage test.
const fixtureLines = fs.readFileSync(path.join(FIX, 'sample-rollout.jsonl'), 'utf8').split('\n');
// Line 12 (0-indexed: 11) = function_call; Line 14 (0-indexed: 13) = function_call_output
const fcLine = fixtureLines[11]; // function_call exec_command
const fcoLine = fixtureLines[13]; // function_call_output

test('parseCodexRecord: assistant message → role assistant, text block', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello from codex' }],
    },
    timestamp: '2026-06-21T06:27:24.071Z',
  });
  const msg = parseCodexRecord(line);
  assert.notEqual(msg, null);
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.blocks.length, 1);
  assert.equal(msg.blocks[0].kind, 'text');
  assert.equal(msg.blocks[0].text, 'Hello from codex');
  assert.equal(msg.rawType, 'message');
});

test('parseCodexRecord: user message → role user, text block', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Do this for me.' }],
    },
    timestamp: '2026-06-21T06:27:24.071Z',
  });
  const msg = parseCodexRecord(line);
  assert.notEqual(msg, null);
  assert.equal(msg.role, 'user');
  assert.equal(msg.blocks.length, 1);
  assert.equal(msg.blocks[0].text, 'Do this for me.');
});

test('parseCodexRecord: developer message → null (system injection filtered)', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: '<permissions instructions>' }],
    },
  });
  assert.equal(parseCodexRecord(line), null);
});

test('parseCodexRecord: reasoning → role assistant, thinking block [reasoning encrypted]', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'reasoning',
      summary: [],
      encrypted_content: 'gAAAAABq...',
    },
    timestamp: '2026-06-21T06:27:31.667Z',
  });
  const msg = parseCodexRecord(line);
  assert.notEqual(msg, null);
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.blocks.length, 1);
  assert.equal(msg.blocks[0].kind, 'thinking');
  assert.equal(msg.blocks[0].text, '[reasoning encrypted]');
  assert.equal(msg.rawType, 'reasoning');
});

test('parseCodexRecord: function_call → tool_use block with id, name, input, inputSummary', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'exec_command',
      arguments: '{"cmd":"echo hi","workdir":"/tmp"}',
      call_id: 'call_abc123',
    },
    timestamp: '2026-06-21T06:27:33.129Z',
  });
  const msg = parseCodexRecord(line);
  assert.notEqual(msg, null);
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.uuid, 'call_abc123');
  assert.equal(msg.blocks.length, 1);
  const b = msg.blocks[0];
  assert.equal(b.kind, 'tool_use');
  assert.equal(b.id, 'call_abc123');
  assert.equal(b.name, 'exec_command');
  assert.equal(b.input.cmd, 'echo hi');
  assert.ok(b.inputSummary.length > 0);
  assert.equal(msg.rawType, 'function_call');
});

test('parseCodexRecord: function_call_output → tool_result block', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: 'call_abc123',
      output: 'Process exited with code 0\nhi\n',
    },
    timestamp: '2026-06-21T06:27:33.677Z',
  });
  const msg = parseCodexRecord(line);
  assert.notEqual(msg, null);
  assert.equal(msg.role, 'user');
  assert.equal(msg.blocks.length, 1);
  const b = msg.blocks[0];
  assert.equal(b.kind, 'tool_result');
  assert.equal(b.forId, 'call_abc123');
  assert.ok(b.text.length > 0);
  assert.equal(b.isError, false);
  assert.equal(msg.rawType, 'function_call_output');
});

test('parseCodexRecord: custom_tool_call apply_patch → tool_use name=apply_patch, input.patch has Begin Patch', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      status: 'completed',
      call_id: 'call_patch1',
      name: 'apply_patch',
      input: '*** Begin Patch\n*** Update File: /tmp/hello.txt\n@@\n-hi\n+hello\n*** End Patch\n',
    },
    timestamp: '2026-06-21T06:29:22.785Z',
  });
  const msg = parseCodexRecord(line);
  assert.notEqual(msg, null);
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.uuid, 'call_patch1');
  const b = msg.blocks[0];
  assert.equal(b.kind, 'tool_use');
  assert.equal(b.name, 'apply_patch');
  assert.ok(b.input.patch.includes('Begin Patch'));
  assert.equal(msg.rawType, 'custom_tool_call');
});

test('parseCodexRecord: custom_tool_call_output → tool_result forId=call_id', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      call_id: 'call_patch1',
      output: '{"output":"Success.","metadata":{"exit_code":0}}',
    },
    timestamp: '2026-06-21T06:30:15.978Z',
  });
  const msg = parseCodexRecord(line);
  assert.notEqual(msg, null);
  assert.equal(msg.role, 'user');
  const b = msg.blocks[0];
  assert.equal(b.kind, 'tool_result');
  assert.equal(b.forId, 'call_patch1');
  assert.equal(msg.rawType, 'custom_tool_call_output');
});

test('parseCodexRecord: event_msg/agent_message → null', () => {
  const line = JSON.stringify({
    type: 'event_msg',
    payload: { type: 'agent_message', message: 'I will do that.', phase: 'commentary' },
  });
  assert.equal(parseCodexRecord(line), null);
});

test('parseCodexRecord: event_msg/token_count → null', () => {
  const line = JSON.stringify({
    type: 'event_msg',
    payload: { type: 'token_count', info: null },
  });
  assert.equal(parseCodexRecord(line), null);
});

test('parseCodexRecord: turn_context → null', () => {
  const line = JSON.stringify({
    type: 'turn_context',
    payload: { cwd: '/tmp', turn_id: 'x' },
  });
  assert.equal(parseCodexRecord(line), null);
});

test('parseCodexRecord: session_meta → null', () => {
  const line = JSON.stringify({
    type: 'session_meta',
    payload: { id: 'abc', cwd: '/tmp' },
  });
  assert.equal(parseCodexRecord(line), null);
});

test('parseCodexRecord: call_id linkage — function_call id === function_call_output forId (fixture lines 12+14)', () => {
  const fcMsg = parseCodexRecord(fcLine);
  const fcoMsg = parseCodexRecord(fcoLine);
  assert.notEqual(fcMsg, null);
  assert.notEqual(fcoMsg, null);
  const toolUseId = fcMsg.blocks[0].id;
  const toolResultForId = fcoMsg.blocks[0].forId;
  assert.equal(toolUseId, toolResultForId);
});

// ---------------------------------------------------------------------------
// 5. detectPendingFromCapture — exec approval fixture
// ---------------------------------------------------------------------------

const execApprovalCapture = fs.readFileSync(path.join(FIX, 'pane-exec-approval.txt'), 'utf8');
const editApprovalCapture = fs.readFileSync(path.join(FIX, 'pane-edit-approval.txt'), 'utf8');

test('pending exec: transcriptPending=true, kind=exec_command, 3 options, option[0] highlighted', () => {
  const result = detectPendingFromCapture(execApprovalCapture);
  assert.equal(result.transcriptPending, true);
  assert.equal(result.pendingKind, 'exec_command');
  assert.equal(result.header, 'Would you like to run the following command?');
  assert.equal(result.options.length, 3);
  assert.equal(result.options[0].n, 1);
  assert.equal(result.options[0].label, 'Yes, proceed');
  assert.equal(result.options[0].shortcut, 'y');
  assert.equal(result.options[0].highlighted, true);
  assert.equal(result.options[1].highlighted, false);
});

// ---------------------------------------------------------------------------
// 6. detectPendingFromCapture — edit/patch approval fixture
// ---------------------------------------------------------------------------

test("pending edit: transcriptPending=true, kind=apply_patch, 3 options, option1 highlighted, option2 label includes \"don't ask again\"", () => {
  const result = detectPendingFromCapture(editApprovalCapture);
  assert.equal(result.transcriptPending, true);
  assert.equal(result.pendingKind, 'apply_patch');
  assert.equal(result.header, 'Would you like to make the following edits?');
  assert.equal(result.options.length, 3);
  assert.equal(result.options[0].highlighted, true);
  assert.ok(result.options[1].label.includes("don't ask again"));
  assert.equal(result.options[1].shortcut, 'a');
});

// ---------------------------------------------------------------------------
// 7. detectPendingFromCapture — no modal heading → no pending
// ---------------------------------------------------------------------------

test('pending none: capture with no heading → transcriptPending=false', () => {
  const capture = 'Just some terminal output\n  Nothing relevant here\n';
  const result = detectPendingFromCapture(capture);
  assert.equal(result.transcriptPending, false);
  assert.equal(result.pendingKind, null);
  assert.deepEqual(result.options, []);
});

// ---------------------------------------------------------------------------
// 8. buildAnswerProgram
// ---------------------------------------------------------------------------

test('buildAnswerProgram: explicit digit selection → [digit, Enter]', () => {
  const pending = detectPendingFromCapture(execApprovalCapture);
  const result = buildAnswerProgram(pending, [['1']]);
  assert.deepEqual(result, ['1', 'Enter']);
});

test('buildAnswerProgram: empty selections → default to highlighted option 1 → [1, Enter]', () => {
  const pending = detectPendingFromCapture(execApprovalCapture);
  const result = buildAnswerProgram(pending, []);
  assert.deepEqual(result, ['1', 'Enter']);
});

test('buildAnswerProgram: label selection "Yes, proceed" → [1, Enter]', () => {
  const pending = detectPendingFromCapture(execApprovalCapture);
  const result = buildAnswerProgram(pending, [['Yes, proceed']]);
  assert.deepEqual(result, ['1', 'Enter']);
});

// ---------------------------------------------------------------------------
// 9. parseTuiStatus — Codex working-state detection (Fix B)
// ---------------------------------------------------------------------------

test('parseTuiStatus: working true when capture contains "esc to interrupt"', () => {
  const capture = `╭───────────────────────────────────╮
│ model:     gpt-4.5   fast  /model  │
╰───────────────────────────────────╯
• Working (12s • esc to interrupt)
>`;
  const result = parseTuiStatus(capture);
  assert.equal(result.working, true);
  assert.equal(result.model, 'gpt-4.5');
  assert.equal(result.ctxPct, null);
});

test('parseTuiStatus: working true when capture contains "Working (" without "esc to interrupt"', () => {
  const capture = `• Working (5s • thinking…)\n> `;
  const result = parseTuiStatus(capture);
  assert.equal(result.working, true);
});

test('parseTuiStatus: working false for idle composer placeholder', () => {
  const capture = `╭───────────────────────────────────╮
│ model:     gpt-4.5   fast  /model  │
╰───────────────────────────────────╯
> Ask anything…`;
  const result = parseTuiStatus(capture);
  assert.equal(result.working, false);
  assert.equal(result.model, 'gpt-4.5');
});

test('parseTuiStatus: working false for empty capture', () => {
  const result = parseTuiStatus('');
  assert.equal(result.working, false);
  assert.equal(result.model, null);
  assert.equal(result.ctxPct, null);
});

// ---------------------------------------------------------------------------
// 10. buildTranscriptIndex — lastActivityMs from transcript timestamp (Fix C)
// ---------------------------------------------------------------------------

test('buildTranscriptIndex: lastActivityMs is parsed from transcript timestamp', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
  const now = new Date('2026-06-21T12:00:00');
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const dateDir = path.join(temp, yyyy, mm, dd);
  fs.mkdirSync(dateDir, { recursive: true });

  const destFile = path.join(dateDir, 'rollout-test.jsonl');
  fs.copyFileSync(path.join(FIX, 'sample-rollout.jsonl'), destFile);

  try {
    const index = await buildTranscriptIndex({ codexSessionsRoot: temp }, now);
    const rec = index.byCwd.get('/private/tmp/codex-spike');
    assert.notEqual(rec, undefined);
    // lastActivityMs should be a finite number derived from the timestamp, not mtime.
    assert.equal(typeof rec.lastActivityMs, 'number');
    assert.ok(Number.isFinite(rec.lastActivityMs));
    // The fixture session_meta timestamp is known; verify it round-trips.
    assert.equal(rec.lastActivityMs, Date.parse(rec.lastActivity));
  } finally {
    fs.rmSync(temp, { recursive: true });
  }
});
