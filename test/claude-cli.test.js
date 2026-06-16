import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeConfig } from '../lib/config.js';
import { parseResult, resolveClaudeBin } from '../lib/claude-cli.js';

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cli-'));
  process.env.CLAUDE_CONTROL_DATA = dataDir;
});

afterEach(() => {
  delete process.env.CLAUDE_CONTROL_DATA;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseResult — pure envelope parsing, no spawning
// ---------------------------------------------------------------------------

test('parseResult returns .result from a valid success envelope', () => {
  const envelope = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 100,
    result: 'Hello from Claude',
    total_cost_usd: 0.0001,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  const result = parseResult(envelope);
  assert.equal(result, 'Hello from Claude');
});

test('parseResult throws on is_error:true envelope', () => {
  const envelope = JSON.stringify({
    type: 'result',
    is_error: true,
    result: 'something went wrong',
  });
  assert.throws(() => parseResult(envelope), /is_error/);
});

test('parseResult throws on non-JSON stdout', () => {
  assert.throws(() => parseResult('not json at all'), /invalid JSON/);
});

test('parseResult throws when .result field is missing', () => {
  const envelope = JSON.stringify({ type: 'result', is_error: false });
  assert.throws(() => parseResult(envelope), /missing .result/);
});

// ---------------------------------------------------------------------------
// resolveClaudeBin — config-driven path, no real spawning needed for the
// config path (we write a real existing file: process.execPath).
// ---------------------------------------------------------------------------

test('resolveClaudeBin returns configured path when claudeBin is a real file', () => {
  // Use node itself as a stand-in for a real existing executable path.
  writeConfig({ claudeBin: process.execPath });
  const bin = resolveClaudeBin();
  assert.equal(bin, process.execPath);
});

test('resolveClaudeBin returns null or a string without throwing when no config', () => {
  // No claudeBin set → auto-resolve via PATH / common dirs.
  // We do NOT force null; on a machine with claude installed it may return a path.
  // We just assert it does not throw and returns string|null.
  let result;
  assert.doesNotThrow(() => {
    result = resolveClaudeBin();
  });
  assert.ok(result === null || typeof result === 'string');
});

test('resolveClaudeBin ignores claudeBin if the path does not exist', () => {
  writeConfig({ claudeBin: '/does/not/exist/claude-fake-bin' });
  // Should not return the non-existent path; returns null or another resolved path.
  const bin = resolveClaudeBin();
  assert.ok(bin !== '/does/not/exist/claude-fake-bin', 'should not return a non-existent path');
});
