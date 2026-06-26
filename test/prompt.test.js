import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePanePrompt, detectPanePicker } from '../lib/prompt.js';

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

// ── detectPanePicker tests ────────────────────────────────────────────────────

test('detectPanePicker: narrow-pane AskUserQuestion with wrapped footer and mid-word option wrap', () => {
  // Footer split across 3 physical lines, option 3 label wrapped mid-word,
  // option 5 without a dot separator, ❯ cursor on option 5.
  const cap = [
    'What should I do next?',
    '',
    '──────────────────',
    ' 3 Deep-verify',
    ' the result',
    ' 4. Review the plan',
    ' ❯ 5 Type something',
    ' 6. Chat about this',
    '',
    'Enter to select · ↑/↓',
    'to navigate · Esc to',
    'cancel',
  ].join('\n');

  const p = detectPanePicker(cap);
  assert.ok(p, 'expected non-null result');
  assert.equal(p.options.length, 4, 'expected 4 options');
  assert.deepEqual(p.options.map((o) => o.key), ['3', '4', '5', '6']);
  assert.equal(p.options[0].label, 'Deep-verify the result', 'option 3 label should be rejoined');
  assert.equal(p.options[2].selected, true, 'option 5 (❯ cursor) should be selected');
  assert.equal(p.options[0].selected, false);
});

test('detectPanePicker: narrow picker starting at key 1 has non-empty question', () => {
  const cap = [
    'Pick a verification strategy:',
    '',
    ' 1. Run unit tests',
    ' ❯ 2. Run all tests',
    ' 3. Skip verification',
    '',
    'Enter to select · ↑/↓',
    'to navigate · Esc to',
    'cancel',
  ].join('\n');

  const p = detectPanePicker(cap);
  assert.ok(p, 'expected non-null result');
  assert.ok(p.question && p.question.length > 0, 'question should be non-empty');
  assert.match(p.question, /Pick a verification strategy/);
});

test('detectPanePicker: plain numbered prose with no footer and no cursor returns null (false-positive guard)', () => {
  // A numbered plan written in assistant prose. NO footer signature, NO ❯ cursor.
  const cap = [
    "Here's my plan:",
    ' 1. Analyze the codebase',
    ' 2. Identify bottlenecks',
    ' 3. Propose refactoring',
    '',
    'Let me know if you want to proceed.',
  ].join('\n');

  assert.equal(detectPanePicker(cap), null, 'plain numbered prose must return null');
});

test('detectPanePicker: box-drawing separator line not present in any label or question', () => {
  const cap = [
    'What to do?',
    '──────────────────',
    ' ❯ 1. Option Alpha',
    ' 2. Option Beta',
    '',
    'Enter to select · ↑/↓',
    'to navigate · Esc to',
    'cancel',
  ].join('\n');

  const p = detectPanePicker(cap);
  assert.ok(p, 'expected non-null');
  // No label or question should contain box-drawing chars
  const allText = [p.question || '', ...p.options.map((o) => o.label)].join(' ');
  assert.doesNotMatch(allText, /[─━—–=_]{3,}/, 'box-drawing chars must not appear in parsed output');
});

test('detectPanePicker: existing wide-pane system prompt still parsed (parsePanePrompt compat)', () => {
  // Confirm the existing parsePanePrompt tests are unaffected — wide-pane permission
  // prompt with a proper OPTION_RE-format line and Esc footer.
  const cap = [
    'Do you want to proceed?',
    ' 1. Yes',
    ' ❯ 2. Yes, and don\'t ask again',
    ' 3. No',
    '',
    'Esc to cancel · ctrl+e to explain',
  ].join('\n');

  const p = parsePanePrompt(cap);
  assert.ok(p, 'parsePanePrompt wide-pane system prompt should still work');
  assert.equal(p.question, 'Do you want to proceed?');
  assert.equal(p.options.length, 3);
});
