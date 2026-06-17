import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHELL_KEYS, shellKey } from '../lib/shell.js';

test('SHELL_KEYS allow-list contains exactly the safe control keys', () => {
  for (const k of ['Enter', 'C-c', 'C-d', 'Up', 'Down', 'Tab', 'Escape']) {
    assert.ok(SHELL_KEYS.has(k), `expected ${k} allowed`);
  }
  assert.ok(!SHELL_KEYS.has('rm'));
  assert.ok(!SHELL_KEYS.has('C-z'));
  assert.ok(!SHELL_KEYS.has(''));
});

test('shellKey rejects a non-allow-listed key before touching tmux', async () => {
  await assert.rejects(() => shellKey('rm -rf /'), /key not allowed/);
  await assert.rejects(() => shellKey('x'), /key not allowed/);
});
