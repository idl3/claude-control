import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnswerKeys, buildAnswerProgram } from '../lib/answer.js';

// Picker model (matches the live footer "Enter to select · ↑/↓ to navigate ·
// Tab to switch questions" and CONTRACT.md):
//   single-select = Down*index then Enter;
//   multi-select  = Down to each chosen option + Space to toggle, then Enter;
//   the final question's Enter submits the whole picker.

// ── single-select ───────────────────────────────────────────────────────────
test('single-select index 0 → ["Enter"] (cursor already on first option)', () => {
  const q = { multiSelect: false, options: [{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }] };
  assert.deepEqual(buildAnswerKeys(q, ['alpha']), ['Enter']);
});

test('single-select index 2 → ["Down","Down","Enter"]', () => {
  const q = { multiSelect: false, options: [{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }] };
  assert.deepEqual(buildAnswerKeys(q, ['gamma']), ['Down', 'Down', 'Enter']);
});

// ── multi-select ────────────────────────────────────────────────────────────
test('multi-select idx 0 and 2 → ["Space","Down","Down","Space","Enter"]', () => {
  const q = { multiSelect: true, options: [{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }] };
  // cursor at 0: toggle (Space); down to 2 (Down,Down); toggle (Space); confirm (Enter)
  assert.deepEqual(buildAnswerKeys(q, ['alpha', 'gamma']), ['Space', 'Down', 'Down', 'Space', 'Enter']);
});

test('multi-select idx 1 only → ["Down","Space","Enter"]', () => {
  const q = { multiSelect: true, options: [{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }] };
  assert.deepEqual(buildAnswerKeys(q, ['beta']), ['Down', 'Space', 'Enter']);
});

test('multi-select selections are visited top-to-bottom regardless of input order', () => {
  const q = { multiSelect: true, options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] };
  // ['c','a'] sorts to indices [0,2]: Space, Down, Down, Space, Enter
  assert.deepEqual(buildAnswerKeys(q, ['c', 'a']), ['Space', 'Down', 'Down', 'Space', 'Enter']);
});

test('multi-select adjacent idx 0 and 1 → ["Space","Down","Space","Enter"]', () => {
  const q = { multiSelect: true, options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] };
  assert.deepEqual(buildAnswerKeys(q, ['a', 'b']), ['Space', 'Down', 'Space', 'Enter']);
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
  // index 11 → 11 Downs then Enter (number-key range no longer applies)
  assert.deepEqual(buildAnswerKeys(q, ['o11']), [...Array(11).fill('Down'), 'Enter']);
});

// ── full program ────────────────────────────────────────────────────────────
test('buildAnswerProgram: single question single-select, Enter submits', () => {
  const pending = { questions: [{ multiSelect: false, options: [{ label: 'x' }, { label: 'y' }] }] };
  // index 1 → Down, Enter (the Enter submits)
  assert.deepEqual(buildAnswerProgram(pending, [['y']]), ['Down', 'Enter']);
});

test('buildAnswerProgram: multi-question single + multi, final Enter submits', () => {
  const pending = {
    questions: [
      { multiSelect: false, options: [{ label: 'yes' }, { label: 'no' }] },
      { multiSelect: true, options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] },
    ],
  };
  // Q1 single idx 1 -> ['Down','Enter'] (Enter advances to Q2)
  // Q2 multi idx 0,2 -> ['Space','Down','Down','Space','Enter'] (final Enter submits)
  assert.deepEqual(buildAnswerProgram(pending, [['no'], ['a', 'c']]), [
    'Down', 'Enter',
    'Space', 'Down', 'Down', 'Space', 'Enter',
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
  // each: pick 2nd option -> Down, Enter; Enters advance then submit
  assert.deepEqual(buildAnswerProgram(pending, [['b'], ['d'], ['f']]), [
    'Down', 'Enter',
    'Down', 'Enter',
    'Down', 'Enter',
  ]);
});

test('buildAnswerProgram: no questions throws', () => {
  assert.throws(() => buildAnswerProgram({ questions: [] }, []), /no questions/i);
});
