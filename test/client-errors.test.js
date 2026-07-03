import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordClientError, clientErrorsPath } from '../lib/client-errors.js';

let dir;
let prev;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-err-'));
  prev = process.env.CLAUDE_CONTROL_DIR;
  process.env.CLAUDE_CONTROL_DIR = dir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.CLAUDE_CONTROL_DIR;
  else process.env.CLAUDE_CONTROL_DIR = prev;
});

test('recordClientError appends a JSONL line with the crash fields', () => {
  const rec = recordClientError(
    { source: 'react-boundary', message: 'boom', stack: 'Error: boom\n at x', componentStack: '\n in Thread', sessionId: '0:5.1', url: 'http://x/', label: 'transcript' },
    { userAgent: 'TestUA/1' },
  );
  assert.equal(rec.source, 'react-boundary');
  assert.equal(rec.message, 'boom');
  assert.equal(rec.sessionId, '0:5.1');
  assert.equal(rec.userAgent, 'TestUA/1'); // server-observed UA folded in

  const lines = fs.readFileSync(clientErrorsPath(), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.message, 'boom');
  assert.match(parsed.ts, /^\d{4}-\d\d-\d\dT/); // ISO timestamp
});

test('recordClientError clips huge fields + never throws on odd input', () => {
  const rec = recordClientError({ source: 'window.onerror', stack: 'x'.repeat(50000) });
  assert.ok(rec.stack.length <= 8000, 'stack clipped');
  // odd/missing fields default to empty strings, no throw
  const rec2 = recordClientError({});
  assert.equal(rec2.message, '');
  assert.equal(rec2.source, 'unknown');
});

test('appends multiple crashes as separate lines', () => {
  recordClientError({ source: 'a', message: 'one' });
  recordClientError({ source: 'b', message: 'two' });
  const lines = fs.readFileSync(clientErrorsPath(), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => JSON.parse(l).message), ['one', 'two']);
});
