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

test('strips ANSI from labels (with Esc footer as the signal)', () => {
  const cap =
    'Do you want to proceed?\n 1. \x1b[32mYes\x1b[0m\n 2. No\nEsc to cancel\n';
  const p = parsePanePrompt(cap);
  assert.ok(p);
  assert.equal(p.options[0].label, 'Yes');
});

test('accepts a plan-approval prompt (cursor signal)', () => {
  const cap = [
    'Would you like to proceed?',
    ' ❯ 1. Yes, and auto-accept edits',
    ' 2. Yes, and manually approve edits',
    ' 3. No, keep planning',
  ].join('\n');
  const p = parsePanePrompt(cap);
  assert.ok(p);
  assert.equal(p.options.length, 3);
  assert.equal(p.options[0].selected, true);
});

test('rejects assistant numbered PROSE (no cursor, no Esc footer)', () => {
  // The exact false-positive class: a plan written as a numbered list, followed
  // by more prose — must NOT pop an approval modal.
  const cap = [
    "Here's what I'll do next:",
    ' 1. Resolve the delegate and assign the ticket',
    ' 2. Watch the four signals as it runs',
    '',
    'Just ping me with "live" and I will fire it.',
    'bypass permissions on · 1 shell',
  ].join('\n');
  assert.equal(parsePanePrompt(cap), null);
});

test('rejects a numbered list with no TUI signal', () => {
  assert.equal(parsePanePrompt('steps:\n 1. one\n 2. two\nmore prose'), null);
});

test('rejects a pane with no numbered options', () => {
  assert.equal(parsePanePrompt('just some output\nno menu here'), null);
});

test('detects a picker that starts mid-sequence (option 1 scrolled off-screen)', () => {
  // A real picker can start above the capture window; the Esc footer is the
  // signal, not a visible "1." (requiring start-at-1 silently dropped questions).
  const r = parsePanePrompt('Would you like to proceed?\n 2. a\n 3. b\nEsc to cancel');
  assert.ok(r);
  assert.deepEqual(r.options.map((o) => o.key), ['2', '3']);
});
