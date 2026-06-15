import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePanePrompt } from '../lib/prompt.js';

test('parses a Claude Code permission prompt with selected option', () => {
  const cap = [
    'Bash command',
    '  ls -la ~/projects/grain',
    '',
    'Do you want to proceed?',
    ' 1. Yes',
    ' \x1b[7m ❯ 2. Yes, and don’t ask again[0m'.replace('[0m', '\x1b[0m'),
    ' 3. No',
    '',
    'Esc to cancel · ctrl+e to explain',
  ].join('\n');
  const p = parsePanePrompt(cap);
  assert.ok(p, 'expected a prompt');
  assert.equal(p.question, 'Do you want to proceed?');
  assert.equal(p.options.length, 3);
  assert.deepEqual(
    p.options.map((o) => o.key),
    ['1', '2', '3'],
  );
  assert.equal(p.options[0].label, 'Yes');
  assert.equal(p.options[2].label, 'No');
  assert.equal(p.options[1].selected, true);
});

test('strips ANSI from labels', () => {
  const cap = 'Do you want to proceed?\n 1. \x1b[32mYes\x1b[0m\n 2. No\n';
  const p = parsePanePrompt(cap);
  assert.equal(p.options[0].label, 'Yes');
});

test('rejects a normal numbered list (no prompt hint)', () => {
  assert.equal(parsePanePrompt('steps:\n 1. one\n 2. two\nmore prose'), null);
});

test('rejects a pane with no numbered options', () => {
  assert.equal(parsePanePrompt('just some output\nno menu here'), null);
});

test('requires options to start at 1', () => {
  assert.equal(parsePanePrompt('Do you want to proceed?\n 2. a\n 3. b'), null);
});
