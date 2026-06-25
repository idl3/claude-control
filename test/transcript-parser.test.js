// test/transcript-parser.test.js
// Verifies that TranscriptTailer accepts a custom `parser` option and routes
// both call-sites (_initialLoad and _readIncremental) through it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { TranscriptTailer, parseRecord } from '../lib/transcript.js';
import { parseCodexRecord } from '../lib/codex.js';

// ---------------------------------------------------------------------------
// Helper: write lines to a temp file and return the path.
// ---------------------------------------------------------------------------
function writeTmp(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-parser-'));
  const filePath = path.join(dir, 'test.jsonl');
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  return { filePath, dir };
}

// ---------------------------------------------------------------------------
// 1. Default parser (Claude parseRecord) is used when no parser option given.
// ---------------------------------------------------------------------------

test('TranscriptTailer: default parser handles Claude JSONL', async () => {
  const claudeLine = JSON.stringify({
    type: 'assistant',
    uuid: 'uuid-1',
    timestamp: '2026-06-21T00:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello from Claude' }],
    },
  });

  const { filePath, dir } = writeTmp([claudeLine]);
  const tailer = new TranscriptTailer(filePath, { maxBuffer: 100 });

  try {
    await tailer.start();
    const msgs = tailer.getMessages();
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'assistant');
    assert.equal(msgs[0].blocks[0].kind, 'text');
    assert.equal(msgs[0].blocks[0].text, 'Hello from Claude');
  } finally {
    tailer.stop();
    fs.rmSync(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 1b. queued_command attachments (messages typed while the agent was busy) are
//     surfaced as user messages — Claude Code does NOT write a type=user record
//     for them, so without this the cockpit never renders/reconciles the send.
// ---------------------------------------------------------------------------

test('parseRecord: human queued_command becomes a user message (queued:true)', () => {
  const rec = JSON.stringify({
    type: 'attachment',
    uuid: 'q-1',
    timestamp: '2026-06-24T10:30:49.336Z',
    attachment: {
      type: 'queued_command',
      prompt: 'Yeah Baby!',
      commandMode: 'prompt',
      origin: { kind: 'human' },
    },
  });
  const msg = parseRecord(rec);
  assert.ok(msg, 'queued_command yields a message');
  assert.equal(msg.role, 'user');
  assert.equal(msg.queued, true);
  assert.equal(msg.rawType, 'queued_command');
  assert.equal(msg.blocks[0].kind, 'text');
  assert.equal(msg.blocks[0].text, 'Yeah Baby!');
});

test('parseRecord: non-human / non-prompt queued_command is ignored', () => {
  const agentQueued = JSON.stringify({
    type: 'attachment',
    uuid: 'q-2',
    attachment: { type: 'queued_command', prompt: 'x', commandMode: 'prompt', origin: { kind: 'agent' } },
  });
  const blankPrompt = JSON.stringify({
    type: 'attachment',
    uuid: 'q-3',
    attachment: { type: 'queued_command', prompt: '   ', commandMode: 'prompt', origin: { kind: 'human' } },
  });
  assert.equal(parseRecord(agentQueued), null, 'agent-origin queue ignored');
  assert.equal(parseRecord(blankPrompt), null, 'blank prompt ignored');
});

// ---------------------------------------------------------------------------
// 2. Custom parser (parseCodexRecord) routes codex lines correctly.
// ---------------------------------------------------------------------------

test('TranscriptTailer: custom parser=parseCodexRecord handles Codex JSONL', async () => {
  const codexLine = JSON.stringify({
    type: 'response_item',
    id: 'codex-uuid-1',
    timestamp: '2026-06-21T06:27:24.071Z',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello from Codex' }],
    },
  });

  const { filePath, dir } = writeTmp([codexLine]);
  const tailer = new TranscriptTailer(filePath, {
    maxBuffer: 100,
    parser: parseCodexRecord,
  });

  try {
    await tailer.start();
    const msgs = tailer.getMessages();
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'assistant');
    assert.equal(msgs[0].blocks[0].kind, 'text');
    assert.equal(msgs[0].blocks[0].text, 'Hello from Codex');
    assert.equal(msgs[0].rawType, 'message');
  } finally {
    tailer.stop();
    fs.rmSync(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Default parser does NOT parse Codex lines (they have type:'response_item').
// ---------------------------------------------------------------------------

test('TranscriptTailer: default parser returns 0 messages for Codex JSONL lines', async () => {
  const codexLine = JSON.stringify({
    type: 'response_item',
    id: 'codex-uuid-2',
    timestamp: '2026-06-21T06:27:24.071Z',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'This is Codex output' }],
    },
  });

  const { filePath, dir } = writeTmp([codexLine]);
  const tailer = new TranscriptTailer(filePath, { maxBuffer: 100 });

  try {
    await tailer.start();
    const msgs = tailer.getMessages();
    // Claude's parseRecord only handles type:'user' and type:'assistant', so
    // response_item lines yield 0 messages.
    assert.equal(msgs.length, 0);
  } finally {
    tailer.stop();
    fs.rmSync(dir, { recursive: true });
  }
});
