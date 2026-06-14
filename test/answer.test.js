import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnswerKeys, buildAnswerProgram } from '../lib/answer.js';

// Picker model (verified live): single-select = press option number (auto-advances);
// multi-select = press each option number (toggles) then Right; finally "1" submits.

// ── single-select ───────────────────────────────────────────────────────────
test('single-select index 0 → ["1"] (number selects + auto-advances)', () => {
  const q = { multiSelect: false, options: [{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }] };
  assert.deepEqual(buildAnswerKeys(q, ['alpha']), ['1']);
});

test('single-select index 2 → ["3"]', () => {
  const q = { multiSelect: false, options: [{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }] };
  assert.deepEqual(buildAnswerKeys(q, ['gamma']), ['3']);
});

// ── multi-select ────────────────────────────────────────────────────────────
test('multi-select idx 0 and 2 → ["1","3","Right"]', () => {
  const q = { multiSelect: true, options: [{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }] };
  assert.deepEqual(buildAnswerKeys(q, ['alpha', 'gamma']), ['1', '3', 'Right']);
});

test('multi-select idx 1 only → ["2","Right"]', () => {
  const q = { multiSelect: true, options: [{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }] };
  assert.deepEqual(buildAnswerKeys(q, ['beta']), ['2', 'Right']);
});

test('multi-select selections are sorted by option order', () => {
  const q = { multiSelect: true, options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] };
  assert.deepEqual(buildAnswerKeys(q, ['c', 'a']), ['1', '3', 'Right']);
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

test('option beyond number-key range throws', () => {
  const opts = Array.from({ length: 10 }, (_, i) => ({ label: `o${i}` }));
  const q = { multiSelect: false, options: opts };
  assert.throws(() => buildAnswerKeys(q, ['o9']), /number-key range/i);
});

// ── full program ────────────────────────────────────────────────────────────
test('buildAnswerProgram: single + multi, ends with "1" submit', () => {
  const pending = {
    questions: [
      { multiSelect: false, options: [{ label: 'yes' }, { label: 'no' }] },
      { multiSelect: true, options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] },
    ],
  };
  // Q1 single idx 1 -> ["2"]; Q2 multi idx 0,2 -> ["1","3","Right"]; submit -> ["1"]
  assert.deepEqual(buildAnswerProgram(pending, [['no'], ['a', 'c']]), ['2', '1', '3', 'Right', '1']);
});

test('buildAnswerProgram: single question single-select ends with submit', () => {
  const pending = { questions: [{ multiSelect: false, options: [{ label: 'x' }, { label: 'y' }] }] };
  assert.deepEqual(buildAnswerProgram(pending, [['y']]), ['2', '1']);
});
