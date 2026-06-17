import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnswerKeys, buildAnswerProgram } from '../lib/answer.js';

// Picker model (verified against the live picker):
//   single-select = Down*index then Enter (Enter selects + advances/submits);
//   multi-select  = Space-toggle each chosen option, then Down to the action row
//                   ("Next"/"Submit") at navigable index options.length + 1 (after
//                   the real options + the always-present "Type something" row),
//                   then Enter. Enter on a checkbox only toggles — it does NOT
//                   advance, so the action row is mandatory.

// ── single-select (unchanged) ───────────────────────────────────────────────
test('single-select index 0 → ["Enter"] (cursor already on first option)', () => {
  const q = { multiSelect: false, options: [{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }] };
  assert.deepEqual(buildAnswerKeys(q, ['alpha']), ['Enter']);
});

test('single-select index 2 → ["Down","Down","Enter"]', () => {
  const q = { multiSelect: false, options: [{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }] };
  assert.deepEqual(buildAnswerKeys(q, ['gamma']), ['Down', 'Down', 'Enter']);
});

// ── multi-select ────────────────────────────────────────────────────────────
// 3 options → action row ("Next"/"Submit") at navigable index 4 (opts 0-2,
// "Type something" 3, action 4).
test('multi-select idx 0,2 (3 opts) → toggle then Down to action row 4 + Enter', () => {
  const q = { multiSelect: true, options: [{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }] };
  // Space(0); Down,Down to 2; Space(2); cursor=2; Down,Down to row 4; Enter.
  assert.deepEqual(buildAnswerKeys(q, ['alpha', 'gamma']),
    ['Space', 'Down', 'Down', 'Space', 'Down', 'Down', 'Enter']);
});

test('multi-select idx 1 only (3 opts) → Down,Space then Down*3 to action row + Enter', () => {
  const q = { multiSelect: true, options: [{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }] };
  // Down,Space toggles 1; cursor=1; Down*3 to row 4; Enter.
  assert.deepEqual(buildAnswerKeys(q, ['beta']),
    ['Down', 'Space', 'Down', 'Down', 'Down', 'Enter']);
});

test('multi-select selections visited top-to-bottom regardless of input order', () => {
  const q = { multiSelect: true, options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] };
  // ['c','a'] sorts to [0,2]; same as the 0,2 case above.
  assert.deepEqual(buildAnswerKeys(q, ['c', 'a']),
    ['Space', 'Down', 'Down', 'Space', 'Down', 'Down', 'Enter']);
});

test('multi-select adjacent idx 0,1 (3 opts) → toggle both then Down*3 + Enter', () => {
  const q = { multiSelect: true, options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] };
  // Space(0); Down,Space(1); cursor=1; Down*3 to row 4; Enter.
  assert.deepEqual(buildAnswerKeys(q, ['a', 'b']),
    ['Space', 'Down', 'Space', 'Down', 'Down', 'Down', 'Enter']);
});

// ── error cases ─────────────────────────────────────────────────────────────
test('invalid label throws', () => {
  const q = { multiSelect: false, options: [{ label: 'alpha' }, { label: 'beta' }] };
  assert.throws(() => buildAnswerKeys(q, ['nope']), /no valid option/i);
});

test('empty selection throws', () => {
  const q = { multiSelect: false, options: [{ label: 'alpha' }] };
  assert.throws(() => buildAnswerKeys(q, []), /no valid option/i);
});

test('high option index uses arrow navigation (no number-key ceiling)', () => {
  const opts = Array.from({ length: 12 }, (_, i) => ({ label: `o${i}` }));
  const q = { multiSelect: false, options: opts };
  assert.deepEqual(buildAnswerKeys(q, ['o11']), [...Array(11).fill('Down'), 'Enter']);
});

// ── full program ────────────────────────────────────────────────────────────
test('buildAnswerProgram: single question single-select, Enter submits', () => {
  const pending = { questions: [{ multiSelect: false, options: [{ label: 'x' }, { label: 'y' }] }] };
  assert.deepEqual(buildAnswerProgram(pending, [['y']]), ['Down', 'Enter']);
});

test('buildAnswerProgram: multi-question single + multi, final action row submits', () => {
  const pending = {
    questions: [
      { multiSelect: false, options: [{ label: 'yes' }, { label: 'no' }] },
      { multiSelect: true, options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] },
    ],
  };
  // Q1 single idx 1 -> Down, Enter (advances to Q2).
  // Q2 multi idx 0,2 -> Space,Down,Down,Space then Down,Down to action row 4, Enter (submits).
  assert.deepEqual(buildAnswerProgram(pending, [['no'], ['a', 'c']]), [
    'Down', 'Enter',
    'Space', 'Down', 'Down', 'Space', 'Down', 'Down', 'Enter',
    'Enter', // review screen: confirm "Submit answers"
  ]);
});

test('buildAnswerProgram: three single-select questions chain via Enter', () => {
  const pending = {
    questions: [
      { multiSelect: false, options: [{ label: 'a' }, { label: 'b' }] },
      { multiSelect: false, options: [{ label: 'c' }, { label: 'd' }] },
      { multiSelect: false, options: [{ label: 'e' }, { label: 'f' }] },
    ],
  };
  assert.deepEqual(buildAnswerProgram(pending, [['b'], ['d'], ['f']]), [
    'Down', 'Enter',
    'Down', 'Enter',
    'Down', 'Enter',
    'Enter', // review screen: confirm "Submit answers"
  ]);
});

test('buildAnswerProgram: two multi-select questions — Q1 Next advances, Q2 Submit submits', () => {
  const pending = {
    questions: [
      { multiSelect: true, options: [{ label: 'p' }, { label: 'q' }, { label: 'r' }] },
      { multiSelect: true, options: [{ label: 'x' }, { label: 'y' }, { label: 'z' }] },
    ],
  };
  // Q1 idx 0,2 → Space,Down,Down,Space then Down,Down to "Next" (row 4), Enter (advances).
  // Q2 idx 1   → Down,Space then Down*3 to "Submit" (row 4), Enter (submits).
  assert.deepEqual(buildAnswerProgram(pending, [['p', 'r'], ['y']]), [
    'Space', 'Down', 'Down', 'Space', 'Down', 'Down', 'Enter',
    'Down', 'Space', 'Down', 'Down', 'Down', 'Enter',
    'Enter', // review screen: confirm "Submit answers"
  ]);
});

test('buildAnswerProgram: no questions throws', () => {
  assert.throws(() => buildAnswerProgram({ questions: [] }, []), /no questions/i);
});
