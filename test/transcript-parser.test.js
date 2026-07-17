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
// 1c. Image attachment content blocks become a `kind:'image'` marker block —
//     NOT the base64 payload — so the client can tell "an attachment landed"
//     without carrying the (potentially huge) image data over the WS. This is
//     what lets pendingSend.ts's echoMatches reconcile an image-only send
//     (see web/src/lib/pendingSend.vitest.ts for the client-side half).
// ---------------------------------------------------------------------------

test('parseRecord: an image-only user message yields a single image block, no text block', () => {
  const rec = JSON.stringify({
    type: 'user',
    uuid: 'img-1',
    timestamp: '2026-07-17T00:00:00.000Z',
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    },
  });
  const msg = parseRecord(rec);
  assert.ok(msg, 'image-only record yields a message');
  assert.equal(msg.role, 'user');
  assert.equal(msg.blocks.length, 1);
  assert.equal(msg.blocks[0].kind, 'image');
  // No base64 payload leaks into the normalized block.
  assert.equal(msg.blocks[0].data, undefined);
  assert.equal(msg.blocks[0].source, undefined);
});

test('parseRecord: a text+image user message keeps its text block alongside the image marker', () => {
  const rec = JSON.stringify({
    type: 'user',
    uuid: 'img-2',
    timestamp: '2026-07-17T00:00:01.000Z',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'check this screenshot' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } },
      ],
    },
  });
  const msg = parseRecord(rec);
  assert.ok(msg);
  assert.equal(msg.blocks.length, 2);
  assert.equal(msg.blocks[0].kind, 'text');
  assert.equal(msg.blocks[0].text, 'check this screenshot');
  assert.equal(msg.blocks[1].kind, 'image');
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
