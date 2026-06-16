import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseRecord, TranscriptTailer } from '../lib/transcript.js';

// ── parseRecord unit tests ───────────────────────────────────────────────────

test('user record with string content → one text block', () => {
  const line = JSON.stringify({
    type: 'user',
    uuid: 'uuid-1',
    timestamp: '2024-01-01T00:00:00Z',
    message: { content: 'Hello, Claude!' },
  });
  const result = parseRecord(line);
  assert.ok(result, 'expected non-null result');
  assert.equal(result.role, 'user');
  assert.equal(result.uuid, 'uuid-1');
  assert.equal(result.ts, '2024-01-01T00:00:00Z');
  assert.equal(result.rawType, 'user');
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].kind, 'text');
  assert.equal(result.blocks[0].text, 'Hello, Claude!');
});

test('assistant record with text + thinking + tool_use blocks → mapped blocks incl inputSummary', () => {
  const line = JSON.stringify({
    type: 'assistant',
    uuid: 'uuid-2',
    timestamp: '2024-01-01T00:01:00Z',
    message: {
      content: [
        { type: 'thinking', thinking: 'Hmm let me think...' },
        { type: 'text', text: 'Here is my answer.' },
        {
          type: 'tool_use',
          id: 'toolu_abc',
          name: 'Bash',
          input: { command: 'ls -la', description: 'List files' },
        },
      ],
    },
  });
  const result = parseRecord(line);
  assert.ok(result, 'expected non-null result');
  assert.equal(result.role, 'assistant');
  assert.equal(result.blocks.length, 3);

  const thinking = result.blocks[0];
  assert.equal(thinking.kind, 'thinking');
  assert.equal(thinking.text, 'Hmm let me think...');

  const text = result.blocks[1];
  assert.equal(text.kind, 'text');
  assert.equal(text.text, 'Here is my answer.');

  const toolUse = result.blocks[2];
  assert.equal(toolUse.kind, 'tool_use');
  assert.equal(toolUse.id, 'toolu_abc');
  assert.equal(toolUse.name, 'Bash');
  assert.ok(typeof toolUse.inputSummary === 'string', 'inputSummary should be a string');
  assert.ok(toolUse.input, 'input object should be present');
});

test('tool_use AskUserQuestion block is represented correctly', () => {
  const questions = [
    {
      question: 'Which environment?',
      header: 'Deployment Target',
      multiSelect: false,
      options: [
        { label: 'staging', description: 'Staging environment' },
        { label: 'production', description: 'Production environment' },
      ],
    },
  ];
  const line = JSON.stringify({
    type: 'assistant',
    uuid: 'uuid-3',
    timestamp: '2024-01-01T00:02:00Z',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_q1',
          name: 'AskUserQuestion',
          input: { questions },
        },
      ],
    },
  });
  const result = parseRecord(line);
  assert.ok(result);
  assert.equal(result.blocks.length, 1);
  const block = result.blocks[0];
  assert.equal(block.kind, 'tool_use');
  assert.equal(block.name, 'AskUserQuestion');
  assert.equal(block.id, 'toolu_q1');
  assert.deepEqual(block.input.questions, questions);
});

test('last-prompt / non-message line → null', () => {
  const lastPrompt = JSON.stringify({ type: 'last-prompt', prompt: 'foo' });
  assert.equal(parseRecord(lastPrompt), null);

  const summary = JSON.stringify({ type: 'summary', content: 'a summary' });
  assert.equal(parseRecord(summary), null);
});

test('malformed JSON → null', () => {
  assert.equal(parseRecord('not json at all'), null);
  assert.equal(parseRecord('{broken json:'), null);
  assert.equal(parseRecord(''), null);
});

// ── TranscriptTailer integration test ────────────────────────────────────────

test('TranscriptTailer: detects pending AskUserQuestion, clears on tool_result', { timeout: 5000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-test-'));
  const filePath = path.join(dir, 'transcript.jsonl');

  const TOOL_USE_ID = 'toolu_pending_1';

  const records = [
    // A normal user message
    JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: '2024-01-01T00:00:00Z',
      sessionId: 'sess1',
      cwd: '/home/user',
      message: { content: 'Do the thing' },
    }),
    // An assistant message with an AskUserQuestion tool_use (no result yet = pending)
    JSON.stringify({
      type: 'assistant',
      uuid: 'u2',
      timestamp: '2024-01-01T00:01:00Z',
      sessionId: 'sess1',
      cwd: '/home/user',
      message: {
        content: [
          {
            type: 'tool_use',
            id: TOOL_USE_ID,
            name: 'AskUserQuestion',
            input: {
              questions: [
                {
                  question: 'Pick one?',
                  header: 'Choice',
                  multiSelect: false,
                  options: [
                    { label: 'yes', description: 'Yes please' },
                    { label: 'no', description: 'No thanks' },
                  ],
                },
              ],
            },
          },
        ],
      },
    }),
  ];

  fs.writeFileSync(filePath, records.join('\n') + '\n', 'utf8');

  const tailer = new TranscriptTailer(filePath, { maxBuffer: 100, debounceMs: 50 });
  await tailer.start();

  // After start, pending should be detected
  const pending = tailer.getPending();
  assert.ok(pending, 'pending should be non-null after start');
  assert.equal(pending.toolUseId, TOOL_USE_ID);
  assert.ok(Array.isArray(pending.questions), 'questions should be an array');
  assert.equal(pending.questions.length, 1);
  assert.equal(pending.questions[0].question, 'Pick one?');

  // Now simulate the answer arriving: append a tool_result
  const resolved = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      tailer.stop();
      reject(new Error('timeout waiting for pending event'));
    }, 3000);

    // Listen for pending-cleared event
    tailer.once('pending', (p) => {
      clearTimeout(timer);
      resolve(p);
    });

    // Append the tool_result line to the file
    const toolResult = JSON.stringify({
      type: 'user',
      uuid: 'u3',
      timestamp: '2024-01-01T00:02:00Z',
      sessionId: 'sess1',
      cwd: '/home/user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: TOOL_USE_ID,
            content: 'Your questions have been answered: yes',
          },
        ],
      },
    });
    fs.appendFileSync(filePath, toolResult + '\n', 'utf8');
  });

  assert.equal(resolved, null, 'pending should become null after tool_result');
  assert.equal(tailer.getPending(), null, 'getPending() should return null');

  // Verify the 'append' event also fired for these new records
  const messages = tailer.getMessages();
  assert.ok(messages.length >= 2, 'buffer should have at least 2 messages');

  tailer.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Initial-tail history retention (reload bug) ──────────────────────────────

// Helpers to build synthetic transcript lines.
function userLine(uuid, text) {
  return JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2024-01-01T00:00:00Z',
    sessionId: 'sess-hist',
    cwd: '/home/user',
    message: { content: text },
  });
}

// An assistant turn whose tool output is `padBytes` of text — emulates Claude's
// huge tool results that dominate the byte tail in a busy session.
function bigAssistantLine(uuid, padBytes) {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2024-01-01T00:00:00Z',
    sessionId: 'sess-hist',
    cwd: '/home/user',
    message: {
      content: [{ type: 'text', text: 'x'.repeat(padBytes) }],
    },
  });
}

test('TranscriptTailer: user messages within the byte window survive a busy-session reload', { timeout: 5000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-hist-'));
  const filePath = path.join(dir, 'transcript.jsonl');

  // Build a file whose tail is dominated by huge assistant/tool turns. With the
  // OLD 1 MB byte cap, the early user turns fall outside the window and vanish
  // on a fresh subscribe. With the new 8 MB default they survive.
  const lines = [];

  // Early user messages (the ones that used to disappear). ~2.4 MB upstream of
  // the big block below — past the old 1 MB cap but inside the new 8 MB one.
  const earlyUsers = ['EARLY_USER_A', 'EARLY_USER_B', 'EARLY_USER_C'];
  for (const marker of earlyUsers) lines.push(userLine(marker, marker));

  // ~2.4 MB of padding between the early users and the recent tail, so the
  // early users sit > 1 MB from EOF but well < 8 MB from EOF.
  for (let i = 0; i < 4; i++) lines.push(bigAssistantLine(`pad-${i}`, 600 * 1024));

  // A recent user turn + a couple more huge assistant turns near EOF.
  lines.push(userLine('RECENT_USER', 'RECENT_USER'));
  for (let i = 0; i < 2; i++) lines.push(bigAssistantLine(`tail-${i}`, 600 * 1024));

  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');

  // Sanity: the file is bigger than the old 1 MB cap but smaller than 8 MB,
  // and the early users sit beyond the last 1 MB.
  const size = fs.statSync(filePath).size;
  assert.ok(size > 1 * 1024 * 1024, 'file should exceed the old 1 MB tail cap');
  assert.ok(size < 8 * 1024 * 1024, 'file should fit inside the new 8 MB window');

  const tailer = new TranscriptTailer(filePath, { debounceMs: 50 });
  await tailer.start();

  const texts = tailer
    .getMessages()
    .filter((m) => m.role === 'user')
    .map((m) => m.blocks.map((b) => b.text).join(''));

  for (const marker of earlyUsers) {
    assert.ok(
      texts.includes(marker),
      `early user message ${marker} should be retained with the 8 MB default tail`,
    );
  }
  assert.ok(texts.includes('RECENT_USER'), 'recent user message should be retained');

  tailer.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('TranscriptTailer: CLAUDE_CONTROL_TAIL_BYTES env override shrinks the window', { timeout: 5000 }, async (t) => {
  // The byte-cap default is resolved at module load, so override it BEFORE
  // importing a fresh copy of the module (cache-busted via query string).
  const prev = process.env.CLAUDE_CONTROL_TAIL_BYTES;
  process.env.CLAUDE_CONTROL_TAIL_BYTES = String(512 * 1024); // 512 KB
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONTROL_TAIL_BYTES;
    else process.env.CLAUDE_CONTROL_TAIL_BYTES = prev;
  });

  const mod = await import('../lib/transcript.js?tail-override=1');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-env-'));
  const filePath = path.join(dir, 'transcript.jsonl');

  const lines = [];
  // An early user turn followed by ~1 MB of padding pushes it outside the
  // 512 KB override window — it must NOT be retained.
  lines.push(userLine('OUTSIDE_USER', 'OUTSIDE_USER'));
  for (let i = 0; i < 2; i++) lines.push(bigAssistantLine(`pad-${i}`, 600 * 1024));
  lines.push(userLine('INSIDE_USER', 'INSIDE_USER'));

  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');

  const tailer = new mod.TranscriptTailer(filePath, { debounceMs: 50 });
  await tailer.start();

  const texts = tailer
    .getMessages()
    .filter((m) => m.role === 'user')
    .map((m) => m.blocks.map((b) => b.text).join(''));

  assert.ok(texts.includes('INSIDE_USER'), 'user inside the override window is retained');
  assert.ok(
    !texts.includes('OUTSIDE_USER'),
    'user beyond the 512 KB override window is dropped — proves the env override governs the byte cap',
  );

  tailer.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('TranscriptTailer: CLAUDE_CONTROL_MAX_BUFFER env override caps the message count', { timeout: 5000 }, async (t) => {
  const prev = process.env.CLAUDE_CONTROL_MAX_BUFFER;
  process.env.CLAUDE_CONTROL_MAX_BUFFER = '5';
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONTROL_MAX_BUFFER;
    else process.env.CLAUDE_CONTROL_MAX_BUFFER = prev;
  });

  const mod = await import('../lib/transcript.js?buf-override=1');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-buf-'));
  const filePath = path.join(dir, 'transcript.jsonl');

  // 20 small user messages, all inside the (large) byte window.
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(userLine(`u-${i}`, `msg-${i}`));
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');

  // Construct with no explicit maxBuffer so the module default (from env) applies.
  const tailer = new mod.TranscriptTailer(filePath, { debounceMs: 50 });
  await tailer.start();

  const msgs = tailer.getMessages();
  assert.equal(msgs.length, 5, 'buffer should be capped to the env-set default of 5');
  // Most-recent five retained.
  assert.equal(msgs[msgs.length - 1].blocks.map((b) => b.text).join(''), 'msg-19');

  tailer.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('TranscriptTailer: append event fires for new records', { timeout: 5000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-append-'));
  const filePath = path.join(dir, 'transcript.jsonl');

  const initial = JSON.stringify({
    type: 'user',
    uuid: 'ua1',
    timestamp: '2024-01-01T00:00:00Z',
    sessionId: 'sess2',
    cwd: '/home/user',
    message: { content: 'initial' },
  });
  fs.writeFileSync(filePath, initial + '\n', 'utf8');

  const tailer = new TranscriptTailer(filePath, { maxBuffer: 100, debounceMs: 50 });
  await tailer.start();

  const appended = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      tailer.stop();
      reject(new Error('timeout waiting for append event'));
    }, 3000);

    tailer.once('append', (msgs) => {
      clearTimeout(timer);
      resolve(msgs);
    });

    const newRecord = JSON.stringify({
      type: 'assistant',
      uuid: 'ua2',
      timestamp: '2024-01-01T00:01:00Z',
      sessionId: 'sess2',
      cwd: '/home/user',
      message: {
        content: [{ type: 'text', text: 'I respond.' }],
      },
    });
    fs.appendFileSync(filePath, newRecord + '\n', 'utf8');
  });

  assert.ok(Array.isArray(appended), 'append event should pass an array of messages');
  assert.ok(appended.length >= 1, 'at least one message appended');
  assert.equal(appended[0].role, 'assistant');

  tailer.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
