import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHELL_KEYS, shellKey } from '../lib/shell.js';

test('SHELL_KEYS allow-list contains the safe control keys', () => {
  // Widened for the on-screen key bar: arrows, Tab, Esc, paging, and the full
  // C-a..C-z / M-a..M-z range (still a closed allow-list of known tmux tokens).
  for (const k of ['Enter', 'C-c', 'C-d', 'C-z', 'Up', 'Down', 'Tab', 'Escape', 'PPage', 'M-b']) {
    assert.ok(SHELL_KEYS.has(k), `expected ${k} allowed`);
  }
  // Arbitrary / injected strings are never allowed.
  assert.ok(!SHELL_KEYS.has('rm'));
  assert.ok(!SHELL_KEYS.has('x')); // bare letters are not keys
  assert.ok(!SHELL_KEYS.has('C-'));
  assert.ok(!SHELL_KEYS.has(''));
});

test('shellKey rejects a non-allow-listed key before touching tmux', async () => {
  await assert.rejects(() => shellKey('rm -rf /'), /key not allowed/);
  await assert.rejects(() => shellKey('x'), /key not allowed/);
});
