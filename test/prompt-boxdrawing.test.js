/**
 * Regression tests for parsePanePrompt against Claude Code's AskUserQuestion
 * picker, which renders a bordered PREVIEW/tooltip panel to the RIGHT of the
 * option list. `tmux capture-pane` flattens that 2-D overlay into the option
 * lines, so a captured row looks like:
 *
 *   "  2. Continue B2–B5 as    │ stop Phase B at 1/6; resume with app running… │"
 *
 * Before the fix the parser folded that box text into option 2 (either merged
 * into the label with a literal │, or into the description). The fix strips the
 * floating box by truncating each line at the first box-drawing glyph
 * (stripFloatingBox in lib/prompt.js) — real option labels never contain them.
 *
 * The fixture below is a faithful reconstruction of a REAL capture (Atlas
 * /execute Phase-B picker). NOTE: earlier work modelled this as a "two-column
 * options grid" — that scenario does not exist; only the preview panel is boxed,
 * and the option list itself is unbordered.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePanePrompt } from '../lib/prompt.js';

// ---------------------------------------------------------------------------
// FLOATING PREVIEW-BOX FIXTURE (real capture geometry)
//   - unbordered option list on the left (❯ cursor on option 1)
//   - a floating preview box (┌─┐ │ └─┘) flattened onto the option rows
//   - option 2's label wraps to a second line ("static-verified code")
//   - a footer hint ("Notes: …") sits below the box, past the option column
//   - "Esc to cancel" footer so the interactive-signal guard passes
// ---------------------------------------------------------------------------
const RULE = '─'.repeat(70);
const FLOATING_BOX = [
  '◇ Phase B',
  '',
  'B1 done. How do you want to handle the rest of Phase B (B2–B6)?',
  '',
  `❯ 1. Pause Phase B here           ┌${RULE}┐`,
  '  2. Continue B2–B5 as            │ stop Phase B at 1/6; resume with app running / Phase C                 │',
  `    static-verified code          └${RULE}┘`,
  " 3. Push what's done + open",
  '   PRs                            Notes: press n to add notes',
  '',
  'Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel',
].join('\n');

test('floating-box picker: exactly 3 options, clean labels', () => {
  const r = parsePanePrompt(FLOATING_BOX);
  assert.ok(r, 'expected a non-null prompt');
  assert.equal(r.options.length, 3, `expected 3 options, got ${r.options.length}`);
  assert.deepEqual(
    r.options.map((o) => o.label),
    ['Pause Phase B here', 'Continue B2–B5 as', "Push what's done + open"],
  );
});

test('floating-box picker: the preview box never leaks into any option', () => {
  const r = parsePanePrompt(FLOATING_BOX);
  assert.ok(r);
  const blob = JSON.stringify(r);
  // The core bug: the tooltip text merged into option 2.
  assert.doesNotMatch(blob, /stop Phase B at 1\/6/, 'preview-box text leaked into an option');
  // No box-drawing glyph survives anywhere in the parsed result.
  assert.doesNotMatch(blob, /[─-╿]/, 'a box-drawing glyph leaked into the parsed prompt');
});

test('floating-box picker: option 2 label + wrapped description are clean', () => {
  const r = parsePanePrompt(FLOATING_BOX);
  assert.ok(r);
  assert.equal(r.options[1].label, 'Continue B2–B5 as');
  // The wrapped second line becomes the description — and ONLY that, not the box.
  assert.equal(r.options[1].description, 'static-verified code');
});

test('floating-box picker: cursor selects option 1', () => {
  const r = parsePanePrompt(FLOATING_BOX);
  assert.ok(r);
  assert.equal(r.options[0].selected, true);
});

// ---------------------------------------------------------------------------
// NON-BORDERED PICKER — must be completely unaffected (no box glyphs → no-op).
// ---------------------------------------------------------------------------
const PLAIN = [
  'Which environment?',
  '',
  '❯ 1. staging',
  '  2. production',
  '  3. local',
  '',
  'Enter to select · Esc to cancel',
].join('\n');

test('plain picker (no box): parses unchanged', () => {
  const r = parsePanePrompt(PLAIN);
  assert.ok(r);
  assert.deepEqual(r.options.map((o) => o.label), ['staging', 'production', 'local']);
  assert.equal(r.options[0].selected, true);
});
