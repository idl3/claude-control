import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { computeCtxPctFromUsage, extractTailRecord } from '../lib/sessions.js';

// ---------------------------------------------------------------------------
// computeCtxPctFromUsage — pure token-math + window-detection unit tests
// ---------------------------------------------------------------------------

test('computeCtxPctFromUsage: null/unavailable usage returns null (no faked value)', () => {
  assert.equal(computeCtxPctFromUsage(null, null), null);
  assert.equal(computeCtxPctFromUsage(undefined, 'Opus 4.8'), null);
  assert.equal(computeCtxPctFromUsage(NaN, null), null);
  assert.equal(computeCtxPctFromUsage(-5, null), null);
});

test('computeCtxPctFromUsage: 0 used tokens reads as 100% remaining', () => {
  assert.equal(computeCtxPctFromUsage(0, null), 100);
});

test('computeCtxPctFromUsage: half the default 200k window reads 50% remaining', () => {
  assert.equal(computeCtxPctFromUsage(100_000, null), 50);
});

test('computeCtxPctFromUsage: fully-used default window reads 0% remaining', () => {
  assert.equal(computeCtxPctFromUsage(200_000, null), 0);
});

test('computeCtxPctFromUsage: exceeding 200k with no 1M label still resolves via usage-implies-1M', () => {
  // 600k used tokens is impossible under a 200k window, so the 1M window is
  // inferred purely from the usage figure — no TUI label needed.
  assert.equal(computeCtxPctFromUsage(600_000, null), 40); // round(100 * (1 - 600000/1000000))
});

test('computeCtxPctFromUsage: "1M context" model label forces the extended window even at low usage', () => {
  assert.equal(computeCtxPctFromUsage(100_000, 'Opus 4.8 (1M context)'), 90);
});

test('computeCtxPctFromUsage: result is clamped to 0..100', () => {
  // 1.2M used against the (label-forced) 1M window would be negative before clamping.
  assert.equal(computeCtxPctFromUsage(1_200_000, 'Opus 4.8 (1M context)'), 0);
});

// ---------------------------------------------------------------------------
// extractTailRecord — contextUsedTokens parsed from the LAST assistant
// message's usage block in a real transcript tail
// ---------------------------------------------------------------------------

function assistantLine({ model, usage }) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    sessionId: 'sess-1',
    cwd: '/tmp/proj',
    message: { model, content: [{ type: 'text', text: 'ok' }], usage },
  });
}

test('extractTailRecord: contextUsedTokens = input + cache_creation + cache_read of the LAST assistant usage', async () => {
  const tmpPath = path.join(os.tmpdir(), `ctx-usage-${process.pid}-${Date.now()}.jsonl`);
  try {
    const lines = [
      assistantLine({
        model: 'claude-opus-4-8',
        usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 },
      }),
      JSON.stringify({ type: 'user', message: { content: 'go on' } }),
      // Last assistant record — this one must win, not the first.
      assistantLine({
        model: 'claude-opus-4-8',
        usage: { input_tokens: 2, cache_creation_input_tokens: 2602, cache_read_input_tokens: 629_068, output_tokens: 1076 },
      }),
    ];
    await fs.writeFile(tmpPath, lines.join('\n') + '\n', 'utf8');
    const stat = await fs.stat(tmpPath);

    const result = await extractTailRecord(tmpPath, stat.mtimeMs, stat.birthtimeMs);
    assert.ok(result, 'extractTailRecord should return a result');
    assert.equal(result.contextUsedTokens, 2 + 2602 + 629_068);
    assert.equal(result.model, 'claude-opus-4-8');
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
});

test('extractTailRecord: assistant message with no usage block leaves contextUsedTokens null', async () => {
  const tmpPath = path.join(os.tmpdir(), `ctx-usage-nousage-${process.pid}-${Date.now()}.jsonl`);
  try {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        sessionId: 'sess-2',
        cwd: '/tmp/proj',
        message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'no usage here' }] },
      }),
    ];
    await fs.writeFile(tmpPath, lines.join('\n') + '\n', 'utf8');
    const stat = await fs.stat(tmpPath);

    const result = await extractTailRecord(tmpPath, stat.mtimeMs, stat.birthtimeMs);
    assert.ok(result);
    assert.equal(result.contextUsedTokens, null);
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
});
