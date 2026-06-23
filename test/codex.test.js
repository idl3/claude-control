import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  matchesProcess,
  processMatchKind,
  buildTranscriptIndex,
  readCodexTranscriptRecord,
  parseCodexRecord,
  parseCodexSubagentNotification,
  parseCodexSubagentNotificationRecord,
  detectPendingFromCapture,
  buildAnswerProgram,
  parseTuiStatus,
  extractUsageFromTail,
  readRolloutMeta,
  parseLsofRollout,
} from '../lib/codex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures', 'codex');

// ---------------------------------------------------------------------------
// 1. matchesProcess
// ---------------------------------------------------------------------------

test('matchesProcess: true for codex', () => {
  assert.equal(matchesProcess('codex'), true);
});

test('processMatchKind: direct for native codex executable', () => {
  assert.equal(processMatchKind('/Users/me/.codex/vendor/codex/codex resume abc'), 'direct');
});

test('processMatchKind: node-wrapper for node-launched codex shim', () => {
  assert.equal(
    processMatchKind('node /Users/me/.nvm/versions/node/v25.9.0/bin/codex resume abc'),
    'node-wrapper',
  );
});

test('matchesProcess: true for /usr/local/bin/codex', () => {
  assert.equal(matchesProcess('/usr/local/bin/codex'), true);
});

test('matchesProcess: true for codex --foo', () => {
  assert.equal(matchesProcess('codex --foo'), true);
});

test('matchesProcess: true for node-launched codex app-server', () => {
  assert.equal(
    matchesProcess('node /Users/me/.nvm/versions/node/v25.9.0/bin/codex app-server --listen ws://127.0.0.1:60036'),
    true,
  );
});

test('matchesProcess: false for codex-control', () => {
  assert.equal(matchesProcess('codex-control'), false);
});

test('matchesProcess: false for a generic command with codex as an argument', () => {
  assert.equal(matchesProcess('rg codex'), false);
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
    assert.equal(index.byPath.get(destFile)?.sessionId, rec.sessionId);
    assert.equal(index.bySessionId.get(rec.sessionId)?.transcriptPath, destFile);
    assert.equal(index.byDir, undefined);
  } finally {
    fs.rmSync(temp, { recursive: true });
  }
});

// Helper: write a minimal valid session_meta rollout and force its mtime.
function writeRollout(dir, name, cwd, sessionId, mtimeDate) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const meta = {
    type: 'session_meta',
    payload: { id: sessionId, cwd },
    timestamp: new Date(mtimeDate).toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(meta) + '\n');
  fs.utimesSync(file, mtimeDate, mtimeDate);
  return file;
}

test('discovery: retains multiple active rollouts for the same cwd by path', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
  const now = new Date('2026-06-23T12:00:00');
  const dir = path.join(temp, '2026', '06', '23');
  const olderTime = new Date(now.getTime() - 60_000);
  const newerTime = now;
  const older = writeRollout(dir, 'rollout-older.jsonl', '/work/shared', 'older-session', olderTime);
  const newer = writeRollout(dir, 'rollout-newer.jsonl', '/work/shared', 'newer-session', newerTime);

  try {
    const index = await buildTranscriptIndex({ codexSessionsRoot: temp }, now);
    assert.equal(index.byPath.has(older), true);
    assert.equal(index.byPath.has(newer), true);
    assert.equal(index.byCwd.get('/work/shared')?.sessionId, 'newer-session');
  } finally {
    fs.rmSync(temp, { recursive: true });
  }
});

test('discovery window: active session in an old date dir is indexed; stale one is skipped', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
  const now = new Date('2026-06-23T12:00:00');

  // Active: started 2 days ago, mtime = now → must be indexed.
  writeRollout(path.join(temp, '2026', '06', '21'), 'rollout-active.jsonl', '/work/phone-suite', 'aaaa1111', now);
  // Stale: started today, but mtime 5 days ago → must be skipped.
  const stale = new Date(now.getTime() - 5 * 24 * 3600 * 1000);
  writeRollout(path.join(temp, '2026', '06', '23'), 'rollout-stale.jsonl', '/work/dead', 'bbbb2222', stale);

  try {
    const index = await buildTranscriptIndex({ codexSessionsRoot: temp }, now);
    assert.equal(index.byCwd.has('/work/phone-suite'), true, 'active old-dir session must be indexed');
    assert.equal(index.byCwd.has('/work/dead'), false, 'stale session must be skipped');
  } finally {
    fs.rmSync(temp, { recursive: true });
  }
});

test('readCodexTranscriptRecord: reads an exact rollout path outside the date index window', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-exact-test-'));
  const destFile = path.join(temp, 'rollout-exact.jsonl');
  fs.copyFileSync(path.join(FIX, 'sample-rollout.jsonl'), destFile);

  try {
    const rec = await readCodexTranscriptRecord(destFile);
    assert.notEqual(rec, null);
    assert.equal(rec.transcriptPath, destFile);
    assert.equal(rec.cwd, '/private/tmp/codex-spike');
    assert.equal(rec.sessionId, '019ee8dc-bd3a-7140-a6fa-43829d915da3');
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

test('parseCodexRecord: encrypted reasoning with no summary → null', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'reasoning',
      summary: [],
      encrypted_content: 'gAAAAABq...',
    },
    timestamp: '2026-06-21T06:27:31.667Z',
  });
  assert.equal(parseCodexRecord(line), null);
});

test('parseCodexRecord: reasoning summary → role assistant, thinking block', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'reasoning',
      summary: [{ text: 'Checked the component layout.' }, { text: 'Next, validate spacing.' }],
      encrypted_content: 'gAAAAABq...',
    },
    timestamp: '2026-06-21T06:27:31.667Z',
  });
  const msg = parseCodexRecord(line);
  assert.notEqual(msg, null);
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.blocks.length, 1);
  assert.equal(msg.blocks[0].kind, 'thinking');
  assert.equal(msg.blocks[0].text, 'Checked the component layout.\nNext, validate spacing.');
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

test('parseCodexSubagentNotification: completed status → normalized done update', () => {
  const text = '<subagent_notification>\n'
    + '{"agent_path":"019ef0af-cfbf-7891-abe5-53ccba4038dd","status":{"completed":"all done"}}\n'
    + '</subagent_notification>';

  const update = parseCodexSubagentNotification(text);
  assert.notEqual(update, null);
  assert.equal(update.agentId, '019ef0af-cfbf-7891-abe5-53ccba4038dd');
  assert.equal(update.agentPath, '019ef0af-cfbf-7891-abe5-53ccba4038dd');
  assert.equal(update.status, 'done');
  assert.equal(update.state, 'completed');
  assert.equal(update.statusKind, 'completed');
  assert.equal(update.result, 'all done');
  assert.equal(update.error, null);
});

test('parseCodexSubagentNotification: running status → normalized running update', () => {
  const text = '<subagent_notification>{"agent_path":"parent/agent-running","status":{"running":true}}</subagent_notification>';

  const update = parseCodexSubagentNotification(text);
  assert.notEqual(update, null);
  assert.equal(update.agentId, 'agent-running');
  assert.equal(update.agentPath, 'parent/agent-running');
  assert.equal(update.status, 'running');
  assert.equal(update.state, 'running');
  assert.equal(update.statusKind, 'running');
  assert.equal(update.result, null);
  assert.equal(update.error, null);
});

test('parseCodexSubagentNotification: failed status → normalized error update', () => {
  const text = '<subagent_notification>{"agent_path":"agent-failed","status":{"failed":"boom"}}</subagent_notification>';

  const update = parseCodexSubagentNotification(text);
  assert.notEqual(update, null);
  assert.equal(update.agentId, 'agent-failed');
  assert.equal(update.status, 'done');
  assert.equal(update.state, 'error');
  assert.equal(update.statusKind, 'failed');
  assert.equal(update.result, null);
  assert.equal(update.error, 'boom');
});

test('parseCodexSubagentNotification: ordinary mention outside exact wrapper → null', () => {
  const text = 'Codex emitted <subagent_notification>{"agent_path":"x","status":{"completed":"ok"}}</subagent_notification>';
  assert.equal(parseCodexSubagentNotification(text), null);
});

test('parseCodexRecord: exact subagent_notification message → null', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text: '<subagent_notification>\n{"agent_path":"agent-1","status":{"completed":"ok"}}\n</subagent_notification>',
      }],
    },
  });

  assert.equal(parseCodexRecord(line), null);
});

test('parseCodexRecord: exact assistant subagent_notification message → null', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: '<subagent_notification>{"agent_path":"agent-1","status":{"running":true}}</subagent_notification>',
      }],
    },
  });

  assert.equal(parseCodexRecord(line), null);
});

test('parseCodexRecord: assistant mention of subagent_notification outside exact wrapper stays text', () => {
  const text = 'The literal <subagent_notification>{"agent_path":"agent-1","status":{"completed":"ok"}}</subagent_notification> tag was mentioned.';
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    },
  });

  const msg = parseCodexRecord(line);
  assert.notEqual(msg, null);
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.blocks.length, 1);
  assert.equal(msg.blocks[0].kind, 'text');
  assert.equal(msg.blocks[0].text, text);
});

test('parseCodexSubagentNotificationRecord: extracts notification from message record', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: '<subagent_notification>{"agent_path":"agent-record","status":{"completed":"ok"}}</subagent_notification>',
      }],
    },
    timestamp: '2026-06-23T06:00:00.000Z',
  });

  const update = parseCodexSubagentNotificationRecord(line);
  assert.notEqual(update, null);
  assert.equal(update.agentId, 'agent-record');
  assert.equal(update.status, 'done');
  assert.equal(update.result, 'ok');
  assert.equal(update.role, 'assistant');
  assert.equal(update.ts, '2026-06-23T06:00:00.000Z');
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

test('parseTuiStatus: header captures model + effort (gpt-5.5 xhigh)', () => {
  const capture = `│ model:     gpt-5.5 xhigh   fast   /model to change │`;
  assert.equal(parseTuiStatus(capture).model, 'gpt-5.5 xhigh');
});

test('parseTuiStatus: footer line captures model + effort when header not in view', () => {
  // What the 8-line bottom ctx-poll capture actually sees once output scrolls
  // the header box away: the persistent "model effort speed · cwd" footer.
  const capture = `• Edited file\n› Run /review\n  gpt-5.5 xhigh Fast · ~/Projects/claude-control`;
  assert.equal(parseTuiStatus(capture).model, 'gpt-5.5 xhigh');
});

test('parseTuiStatus: footer without an effort token captures the model only', () => {
  const capture = `  gpt-5.5 Fast · ~/Projects/claude-control`;
  assert.equal(parseTuiStatus(capture).model, 'gpt-5.5');
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

// ---------------------------------------------------------------------------
// 11. extractUsageFromTail — pure unit tests
// ---------------------------------------------------------------------------

test('extractUsageFromTail: returns newest token_count primary rate_limits', () => {
  const older = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: null,
      rate_limits: { primary: { used_percent: 5.0, window_minutes: 300 } },
    },
  });
  const newer = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: null,
      rate_limits: { primary: { used_percent: 12.0, window_minutes: 300 } },
    },
  });
  // Newest is at the end of the blob — extractUsageFromTail reads from the bottom.
  const text = `${older}\n${newer}\n`;
  const result = extractUsageFromTail(text);
  assert.notEqual(result, null);
  assert.equal(result.usagePct, 12.0);
  assert.equal(result.usageWindowMin, 300);
});

test('extractUsageFromTail: newest token_count wins (later line overrides earlier)', () => {
  const lines = [
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: null,
        rate_limits: { primary: { used_percent: 1.0, window_minutes: 300 } },
      },
    }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: null,
        rate_limits: { primary: { used_percent: 2.0, window_minutes: 300 } },
      },
    }),
  ];
  const result = extractUsageFromTail(lines.join('\n'));
  assert.equal(result.usagePct, 2.0);
});

test('extractUsageFromTail: returns null when no token_count lines present', () => {
  const text = JSON.stringify({ type: 'session_meta', payload: { cwd: '/tmp' } }) + '\n';
  assert.equal(extractUsageFromTail(text), null);
});

test('extractUsageFromTail: skips unparseable lines, still finds valid one', () => {
  const valid = JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: null,
      rate_limits: { primary: { used_percent: 7.0, window_minutes: 10080 } },
    },
  });
  const text = `{not valid json}\n${valid}\n{also bad\n`;
  const result = extractUsageFromTail(text);
  assert.notEqual(result, null);
  assert.equal(result.usagePct, 7.0);
  assert.equal(result.usageWindowMin, 10080);
});

test('extractUsageFromTail: null for empty string', () => {
  assert.equal(extractUsageFromTail(''), null);
});

test('extractUsageFromTail: null for null input', () => {
  assert.equal(extractUsageFromTail(null), null);
});

// ---------------------------------------------------------------------------
// 12. buildTranscriptIndex — usagePct populated from fixture token_count
// ---------------------------------------------------------------------------

test('buildTranscriptIndex: usagePct and usageWindowMin populated from sample-rollout.jsonl', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-test-'));
  const now = new Date('2026-06-21T12:00:00');
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const dateDir = path.join(temp, yyyy, mm, dd);
  fs.mkdirSync(dateDir, { recursive: true });

  const destFile = path.join(dateDir, 'rollout-usage.jsonl');
  fs.copyFileSync(path.join(FIX, 'sample-rollout.jsonl'), destFile);

  try {
    const index = await buildTranscriptIndex({ codexSessionsRoot: temp }, now);
    const rec = index.byCwd.get('/private/tmp/codex-spike');
    assert.notEqual(rec, undefined);
    // sample-rollout.jsonl has token_count events with primary rate_limits.
    assert.equal(typeof rec.usagePct, 'number');
    assert.equal(typeof rec.usageWindowMin, 'number');
    assert.equal(rec.usageWindowMin, 300); // 5h window
    // The fixture's last token_count has used_percent: 3.0.
    assert.equal(rec.usagePct, 3.0);
  } finally {
    fs.rmSync(temp, { recursive: true });
  }
});

test('buildTranscriptIndex: usagePct null when file has no token_count events', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-nousage-test-'));
  const now = new Date('2026-06-21T12:00:00');
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const dateDir = path.join(temp, yyyy, mm, dd);
  fs.mkdirSync(dateDir, { recursive: true });

  // A minimal rollout with only a session_meta — no token_count events.
  const minimalRollout = JSON.stringify({
    timestamp: '2026-06-21T06:27:24.067Z',
    type: 'session_meta',
    payload: {
      id: 'test-no-usage-id',
      cwd: '/private/tmp/no-usage',
    },
  }) + '\n';
  fs.writeFileSync(path.join(dateDir, 'rollout-nousage.jsonl'), minimalRollout);

  try {
    const index = await buildTranscriptIndex({ codexSessionsRoot: temp }, now);
    const rec = index.byCwd.get('/private/tmp/no-usage');
    assert.notEqual(rec, undefined);
    assert.equal(rec.usagePct, null);
    assert.equal(rec.usageWindowMin, null);
  } finally {
    fs.rmSync(temp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 13. readRolloutMeta — direct per-file reader
// ---------------------------------------------------------------------------

test('readRolloutMeta: returns record for a valid rollout fixture', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-meta-test-'));
  const destFile = path.join(temp, 'rollout-test.jsonl');
  fs.copyFileSync(path.join(FIX, 'sample-rollout.jsonl'), destFile);

  try {
    const rec = await readRolloutMeta(destFile);
    assert.notEqual(rec, null, 'should return a record');
    assert.equal(rec.agentType, 'codex');
    assert.equal(rec.cwd, '/private/tmp/codex-spike');
    assert.equal(rec.sessionId, '019ee8dc-bd3a-7140-a6fa-43829d915da3');
    assert.equal(typeof rec.mtime, 'number');
    assert.equal(rec.transcriptPath, destFile);
    assert.equal(rec.transcriptPending, false);
  } finally {
    fs.rmSync(temp, { recursive: true });
  }
});

test('readRolloutMeta: returns null for empty file', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-meta-test-'));
  const f = path.join(temp, 'rollout-empty.jsonl');
  fs.writeFileSync(f, '');
  try {
    const rec = await readRolloutMeta(f);
    assert.equal(rec, null);
  } finally {
    fs.rmSync(temp, { recursive: true });
  }
});

test('readRolloutMeta: returns null for bad JSON first line', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-meta-test-'));
  const f = path.join(temp, 'rollout-bad.jsonl');
  fs.writeFileSync(f, '{not valid json}\n');
  try {
    const rec = await readRolloutMeta(f);
    assert.equal(rec, null);
  } finally {
    fs.rmSync(temp, { recursive: true });
  }
});

test('readRolloutMeta: returns null when first line is not session_meta', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-meta-test-'));
  const f = path.join(temp, 'rollout-nonmeta.jsonl');
  const line = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [] } });
  fs.writeFileSync(f, line + '\n');
  try {
    const rec = await readRolloutMeta(f);
    assert.equal(rec, null);
  } finally {
    fs.rmSync(temp, { recursive: true });
  }
});

test('readRolloutMeta: returns null for non-existent file', async () => {
  const rec = await readRolloutMeta('/nonexistent/path/rollout-nope.jsonl');
  assert.equal(rec, null);
});

test('readRolloutMeta: record shape is identical to buildTranscriptIndex output for same file', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-meta-shape-test-'));
  const now = new Date('2026-06-21T12:00:00');
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const dateDir = path.join(temp, yyyy, mm, dd);
  fs.mkdirSync(dateDir, { recursive: true });
  const destFile = path.join(dateDir, 'rollout-shape.jsonl');
  fs.copyFileSync(path.join(FIX, 'sample-rollout.jsonl'), destFile);

  try {
    const index = await buildTranscriptIndex({ codexSessionsRoot: temp }, now);
    const indexRec = index.byCwd.get('/private/tmp/codex-spike');
    assert.notEqual(indexRec, undefined);

    const directRec = await readRolloutMeta(destFile, now);
    assert.notEqual(directRec, null);

    // All fields should match between the two paths.
    assert.equal(directRec.cwd, indexRec.cwd);
    assert.equal(directRec.sessionId, indexRec.sessionId);
    assert.equal(directRec.lastActivity, indexRec.lastActivity);
    assert.equal(directRec.lastActivityMs, indexRec.lastActivityMs);
    assert.equal(directRec.agentType, indexRec.agentType);
    assert.equal(directRec.usagePct, indexRec.usagePct);
    assert.equal(directRec.usageWindowMin, indexRec.usageWindowMin);
    assert.equal(directRec.transcriptPath, indexRec.transcriptPath);
  } finally {
    fs.rmSync(temp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 14. parseLsofRollout — pure stdout parser
// ---------------------------------------------------------------------------

test('parseLsofRollout: returns rollout path from lsof -Fn output', () => {
  const stdout = [
    'p12345',
    'f0',
    'n/dev/null',
    'f1',
    'n/Users/ernie/.config/codex/something.json',
    'f4',
    'n/Users/ernie/.codex/sessions/2026/06/21/rollout-1750484844067-019ee8dc.jsonl',
    'f5',
    'n/usr/lib/libsystem.B.dylib',
  ].join('\n');

  const result = parseLsofRollout(stdout);
  assert.equal(result, '/Users/ernie/.codex/sessions/2026/06/21/rollout-1750484844067-019ee8dc.jsonl');
});

test('parseLsofRollout: returns first rollout when multiple rollout lines present', () => {
  const stdout = [
    'p12345',
    'n/Users/ernie/.codex/sessions/2026/06/20/rollout-first.jsonl',
    'n/Users/ernie/.codex/sessions/2026/06/21/rollout-second.jsonl',
  ].join('\n');

  const result = parseLsofRollout(stdout);
  assert.equal(result, '/Users/ernie/.codex/sessions/2026/06/20/rollout-first.jsonl');
});

test('parseLsofRollout: returns null when no rollout line present', () => {
  const stdout = [
    'p12345',
    'f0',
    'n/dev/null',
    'f1',
    'n/Users/ernie/.config/codex/config.json',
    'f2',
    'n/usr/lib/libsystem.B.dylib',
  ].join('\n');

  assert.equal(parseLsofRollout(stdout), null);
});

test('parseLsofRollout: returns null for empty stdout', () => {
  assert.equal(parseLsofRollout(''), null);
});

test('parseLsofRollout: returns null for null/undefined input', () => {
  assert.equal(parseLsofRollout(null), null);
  assert.equal(parseLsofRollout(undefined), null);
});

test('parseLsofRollout: ignores f-lines and p-lines that contain rollout in name', () => {
  // Only n-lines should be matched; f-lines and p-lines with rollout in name should be ignored.
  const stdout = [
    'p999',
    'f99',
    // This is NOT an n-line — should be ignored.
    '/Users/ernie/.codex/sessions/2026/06/21/rollout-fake.jsonl',
    'n/Users/ernie/.codex/sessions/2026/06/21/rollout-real.jsonl',
  ].join('\n');

  const result = parseLsofRollout(stdout);
  assert.equal(result, '/Users/ernie/.codex/sessions/2026/06/21/rollout-real.jsonl');
});

test('parseLsofRollout: does not match .json files (only .jsonl)', () => {
  const stdout = [
    'p12345',
    'n/Users/ernie/.codex/sessions/2026/06/21/rollout-something.json',
    'n/Users/ernie/.codex/sessions/2026/06/21/rollout-real.jsonl',
  ].join('\n');

  const result = parseLsofRollout(stdout);
  assert.equal(result, '/Users/ernie/.codex/sessions/2026/06/21/rollout-real.jsonl');
});
