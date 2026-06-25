import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { detectTranscriptPending, extractTailRecord } from '../lib/sessions.js';

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

// ---------------------------------------------------------------------------
// extractTailRecord — file-read path: large AskUserQuestion straddles 64 KB
// ---------------------------------------------------------------------------

test('extractTailRecord: detects AskUserQuestion whose record start is before the 64 KB tail window', async () => {
  const tmpDir = os.tmpdir();
  const tmpPath = path.join(tmpDir, `push-pending-large-${process.pid}.jsonl`);
  try {
    // Build a filler line small enough to repeat. Each filler is a minimal
    // assistant text record. We need enough filler so that the LARGE ask record
    // starts more than TAIL_BYTES (64 KB) before EOF.
    const fillerLine = JSON.stringify({
      type: 'assistant',
      cwd: '/tmp/test',
      sessionId: 'sess-filler',
      message: { content: [{ type: 'text', text: 'filler' }] },
    });

    // The large ask record: pad the question string to ~70 KB so the record's
    // own START is before the 64 KB-from-EOF window even with no filler.
    // A 70 KB ask record as the last line means:
    //   file size  ≈ 70 KB
    //   64KB tail window starts at: 70KB - 64KB = 6 KB from file start
    //   ask record START = 0 (or a few bytes of filler) → clearly before 6 KB
    const bigId = 'toolu_big_' + process.pid;
    const bigQuestion = 'Q'.repeat(70_000);
    const bigAskLine = JSON.stringify({
      type: 'assistant',
      cwd: '/tmp/test',
      sessionId: 'sess-filler',
      message: {
        content: [
          { type: 'text', text: 'thinking…' },
          {
            type: 'tool_use',
            id: bigId,
            name: 'AskUserQuestion',
            input: { questions: [{ question: bigQuestion, options: [{ label: 'Yes' }] }] },
          },
        ],
      },
    });

    // A handful of filler lines precede the ask record so the file has a
    // recognizable header; the ask record is still the last (and largest) line.
    const fillerCount = 5;
    const lines = [];
    for (let i = 0; i < fillerCount; i++) lines.push(fillerLine);
    lines.push(bigAskLine);
    await fs.writeFile(tmpPath, lines.join('\n') + '\n', 'utf8');

    // Verify the file is indeed larger than 64 KB so the bug condition holds.
    const stat = await fs.stat(tmpPath);
    assert.ok(
      stat.size > 64 * 1024,
      `file must exceed 64 KB to trigger the truncation scenario (got ${stat.size} bytes)`,
    );

    // The ask record START must be BEFORE the 64 KB-from-EOF window start.
    // tailWindowStart = stat.size - 64*1024  (the byte offset where readTail begins)
    // askRecordStart  = stat.size - bigAskLine.length - 1 (the '\n' terminator)
    // We need: askRecordStart < tailWindowStart, i.e. the record opens before
    // the 64 KB read offset → the first line of the initial buffer is partial
    // and the open question would be missed without the enlarged re-read.
    const TAIL_BYTES = 64 * 1024;
    const tailWindowStart = stat.size - TAIL_BYTES;
    const askRecordStart = stat.size - bigAskLine.length - 1;
    assert.ok(
      askRecordStart < tailWindowStart,
      `ask record start (${askRecordStart}) must be before the 64 KB tail window start (${tailWindowStart}) to trigger the truncation bug`,
    );

    // extractTailRecord must detect the pending question via the enlarged read.
    const result = await extractTailRecord(tmpPath, stat.mtimeMs, stat.birthtimeMs);
    assert.ok(result, 'extractTailRecord should return a result');
    assert.equal(
      result.transcriptPending,
      true,
      'large AskUserQuestion straddling the 64 KB boundary must be detected as pending',
    );
    assert.equal(
      result.pendingToolUseId,
      bigId,
      'pendingToolUseId must match the large AskUserQuestion id',
    );
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
});
