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
