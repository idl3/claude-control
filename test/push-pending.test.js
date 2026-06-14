import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectTranscriptPending } from '../lib/sessions.js';

// Build an assistant record carrying an AskUserQuestion tool_use block.
function askRecord(id, question) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'thinking…' },
        {
          type: 'tool_use',
          id,
          name: 'AskUserQuestion',
          input: { questions: [{ question, options: [{ label: 'Yes' }] }] },
        },
      ],
    },
  });
}

// Build a user record carrying a tool_result that resolves a tool_use id.
function resultRecord(id) {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, content: 'answered' }],
    },
  });
}

test('detectTranscriptPending: open AskUserQuestion (no tool_result) is pending', () => {
  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
    askRecord('toolu_abc', 'Which database should we use?'),
  ];
  const res = detectTranscriptPending(lines);
  assert.equal(res.transcriptPending, true);
  assert.equal(res.pendingToolUseId, 'toolu_abc');
  assert.equal(res.pendingQuestion, 'Which database should we use?');
});

test('detectTranscriptPending: resolved AskUserQuestion is NOT pending', () => {
  const lines = [
    askRecord('toolu_abc', 'Which database should we use?'),
    resultRecord('toolu_abc'),
  ];
  const res = detectTranscriptPending(lines);
  assert.equal(res.transcriptPending, false);
  assert.equal(res.pendingToolUseId, null);
  assert.equal(res.pendingQuestion, null);
});

test('detectTranscriptPending: only the unresolved question of several is pending', () => {
  const lines = [
    askRecord('toolu_1', 'First?'),
    resultRecord('toolu_1'),
    askRecord('toolu_2', 'Second?'),
  ];
  const res = detectTranscriptPending(lines);
  assert.equal(res.transcriptPending, true);
  assert.equal(res.pendingToolUseId, 'toolu_2');
  assert.equal(res.pendingQuestion, 'Second?');
});

test('detectTranscriptPending: question text is truncated to 140 chars', () => {
  const long = 'x'.repeat(300);
  const res = detectTranscriptPending([askRecord('toolu_long', long)]);
  assert.equal(res.transcriptPending, true);
  assert.equal(res.pendingQuestion.length, 140);
});

test('detectTranscriptPending: tolerates a partial leading line and junk', () => {
  const lines = [
    '{"type":"assistant","message":{"content":[{"type":"tool_use"', // truncated/garbage
    'not json at all',
    '',
    askRecord('toolu_ok', 'Real question?'),
  ];
  const res = detectTranscriptPending(lines);
  assert.equal(res.transcriptPending, true);
  assert.equal(res.pendingToolUseId, 'toolu_ok');
});

test('detectTranscriptPending: empty input → no pending', () => {
  const res = detectTranscriptPending([]);
  assert.deepEqual(res, {
    transcriptPending: false,
    pendingToolUseId: null,
    pendingQuestion: null,
  });
});
