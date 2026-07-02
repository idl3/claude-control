/**
 * Regression tests for parsePanePrompt robustness against bordered two-column
 * TUI pickers. Before the fix, a two-column line like:
 *   │ ❯ 1. Pause Phase B here     │ 3. Push what's done + open  │
 * was matched as a single option whose label contained the entire right column
 * including the literal │ glyph and the other option's text.
 *
 * Root causes fixed (all in parsePanePrompt, lib/prompt.js):
 *   1. normalizeBoxLines() splits each line on │/┃/║ before OPTION_RE runs, so
 *      a two-column line becomes two independent candidate lines.
 *   2. Pure box-drawing rule lines (─────) are dropped by normalizeBoxLines()
 *      before they can become option descriptions.
 *   3. stripBoxGlyphs() removes any residual leading/trailing box-drawing chars
 *      from labels, questions, and descriptions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePanePrompt } from '../lib/prompt.js';

// ---------------------------------------------------------------------------
// BORDERED TWO-COLUMN FIXTURE
//
// Reconstruction of a skill-rendered TUI picker where options are displayed in
// a box-drawn two-column grid. The geometry used here exercises:
//   - top/bottom border lines (pure ─ / └ / ┘ / ┌ / ┐ chars) → must be dropped
//   - left + right │ frame glyphs on every content row → must be split
//   - vertical separator ┼ / ┤ / ├ between columns → split point
//   - ❯ cursor indicator on option 1 (left column)
//   - option 3 starts in the right column of the first content row
//   - option 4 continuation text appears in the right column of a wrapped row
//   - "esc to cancel" footer so the interactive-signal guard passes
// ---------------------------------------------------------------------------

const BORDERED_TWO_COL = [
  '┌────────────────────────────┬────────────────────────────┐',
  '│ ❯ 1. Pause Phase B here    │ 3. Push what\'s done + open  │',
  '│   2. Continue B2–B5 as     │      static-verified code  │',
  '│      static-verified code  │                            │',
  '└────────────────────────────┴────────────────────────────┘',
  'Esc to cancel',
].join('\n');

test('parsePanePrompt: bordered two-column picker — exactly 3 options parsed', () => {
  const r = parsePanePrompt(BORDERED_TWO_COL);
  assert.ok(r, 'expected a non-null prompt from the bordered two-column fixture');
  assert.equal(r.options.length, 3, `expected exactly 3 options, got ${r.options.length}`);
  assert.deepEqual(
    r.options.map((o) => o.key),
    ['1', '2', '3'],
    'option keys must be [1, 2, 3] in order',
  );
});

test('parsePanePrompt: bordered two-column picker — option 1 label has no │ or ─ glyphs', () => {
  const r = parsePanePrompt(BORDERED_TWO_COL);
  assert.ok(r);
  const label1 = r.options[0].label;
  assert.doesNotMatch(label1, /[│┃║─━┌┐└┘├┤┼┬┴╔╗╚╝╠╣╦╩╬]/, `option 1 label contains box-drawing chars: "${label1}"`);
  assert.doesNotMatch(label1, /Push what/, `option 1 label must not contain option 3 text; got: "${label1}"`);
});

test('parsePanePrompt: bordered two-column picker — option 1 label is "Pause Phase B here"', () => {
  const r = parsePanePrompt(BORDERED_TWO_COL);
  assert.ok(r);
  assert.equal(r.options[0].label, 'Pause Phase B here');
});

test('parsePanePrompt: bordered two-column picker — option 2 label is clean (no │)', () => {
  const r = parsePanePrompt(BORDERED_TWO_COL);
  assert.ok(r);
  const label2 = r.options[1].label;
  assert.doesNotMatch(label2, /[│┃║─━]/, `option 2 label contains box-drawing chars: "${label2}"`);
  assert.doesNotMatch(label2, /static-verified code\s*[│]/,
    `option 2 label must not end with │ glyph: "${label2}"`);
});

test('parsePanePrompt: bordered two-column picker — option 3 label is clean (no other-option text)', () => {
  const r = parsePanePrompt(BORDERED_TWO_COL);
  assert.ok(r);
  const label3 = r.options[2].label;
  assert.doesNotMatch(label3, /[│┃║─━]/, `option 3 label contains box-drawing chars: "${label3}"`);
  assert.doesNotMatch(label3, /Pause Phase/, `option 3 label must not contain option 1 text: "${label3}"`);
});

test('parsePanePrompt: bordered two-column picker — no description equals a pure box-rule string', () => {
  const r = parsePanePrompt(BORDERED_TWO_COL);
  assert.ok(r);
  for (const opt of r.options) {
    if (opt.description !== undefined) {
      assert.doesNotMatch(
        opt.description,
        /^[─━—–=_\s┌┐└┘├┤┼┬┴]+$/,
        `option ${opt.key} description is a pure box-rule line: "${opt.description}"`,
      );
    }
  }
});

test('parsePanePrompt: bordered two-column picker — option 1 has cursor (❯)', () => {
  const r = parsePanePrompt(BORDERED_TWO_COL);
  assert.ok(r);
  assert.equal(r.options[0].selected, true, 'option 1 should be selected (❯ cursor)');
  assert.equal(r.options[1].selected, false);
  assert.equal(r.options[2].selected, false);
});

// ---------------------------------------------------------------------------
// SINGLE-COLUMN REGRESSION — prove the fix does NOT break normal pickers
// ---------------------------------------------------------------------------

const SINGLE_COL = [
  'How should I proceed?',
  ' ❯ 1. Run all tests',
  '    2. Run only unit tests',
  '    3. Skip and continue',
  '',
  'Esc to cancel',
].join('\n');

test('parsePanePrompt: single-column picker still works after box-drawing fix', () => {
  const r = parsePanePrompt(SINGLE_COL);
  assert.ok(r, 'single-column picker must still be detected');
  assert.equal(r.options.length, 3);
  assert.deepEqual(r.options.map((o) => o.key), ['1', '2', '3']);
  assert.equal(r.options[0].label, 'Run all tests');
  assert.equal(r.options[1].label, 'Run only unit tests');
  assert.equal(r.options[2].label, 'Skip and continue');
  assert.equal(r.options[0].selected, true);
  assert.equal(r.options[1].selected, false);
  assert.match(r.question, /How should I proceed/);
});

// ---------------------------------------------------------------------------
// HORIZONTAL RULE LINES — must not appear as descriptions
// ---------------------------------------------------------------------------

const WITH_RULES = [
  'Pick an action:',
  '──────────────────────────',
  ' ❯ 1. Deploy now',
  '──────────────────────────',
  '    2. Wait for review',
  '──────────────────────────',
  'Esc to cancel',
].join('\n');

test('parsePanePrompt: horizontal rule lines between options do not become descriptions', () => {
  const r = parsePanePrompt(WITH_RULES);
  assert.ok(r, 'picker with rule lines must still be detected');
  assert.equal(r.options.length, 2);
  // Neither option should have a description that is just dashes
  for (const opt of r.options) {
    if (opt.description !== undefined) {
      assert.doesNotMatch(opt.description, /^[─\s]+$/, `option ${opt.key} description is a rule line`);
    }
  }
  assert.equal(r.options[0].label, 'Deploy now');
  assert.equal(r.options[1].label, 'Wait for review');
});
