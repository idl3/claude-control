import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHELL_KEYS } from '../lib/shell.js';

// The key bar can only send what the allow-list permits — verify the bar's
// vocabulary is present and arbitrary / dangerous strings are not.

test('SHELL_KEYS allows the key-bar vocabulary', () => {
  for (const k of ['Up', 'Down', 'Left', 'Right', 'Tab', 'Escape',
    'Home', 'End', 'PPage', 'NPage',
    'C-c', 'C-d', 'C-r', 'C-z', 'C-l', 'C-a', 'C-e', 'C-u', 'C-k', 'C-w']) {
    assert.ok(SHELL_KEYS.has(k), `expected SHELL_KEYS to allow ${k}`);
  }
});

test('SHELL_KEYS allows modified nav keys (hardware modifier + arrow combos)', () => {
  for (const k of ['M-Left', 'C-Right', 'S-Up', 'C-M-S-Up', 'M-S-Left', 'C-Home', 'M-PPage']) {
    assert.ok(SHELL_KEYS.has(k), `expected SHELL_KEYS to allow ${k}`);
  }
});

test('SHELL_KEYS rejects arbitrary / injected strings', () => {
  assert.ok(!SHELL_KEYS.has('rm -rf /'));
  assert.ok(!SHELL_KEYS.has('Enter; echo pwned'));
  assert.ok(!SHELL_KEYS.has('C-'));
  assert.ok(!SHELL_KEYS.has(''));
});
