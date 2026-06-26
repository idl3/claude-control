import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePicker, planStep } from '../lib/answer.js';

// ---------------------------------------------------------------------------
// Fixtures — taken verbatim from the real picker renders documented in the
// dispatch prompt. Whitespace is preserved exactly.
// ---------------------------------------------------------------------------

// FIXTURE_NON_FINAL — real TUI format with contiguous (no blank-line) descriptions.
//
// The real Claude Code TUI renders description lines IMMEDIATELY below their option,
// indented but NOT separated by a blank line:
//
//   ❯ 1. Apple
//        Crisp and classic.
//   2. Banana
//      Soft and sweet.
//
// reconstructOptionLines stitches those contiguous description lines into the option
// label by design (blank line = stop; no blank = append). The answer path (planStep)
// matches labels by exact equality — if question option labels are SHORT structured
// forms ('Apple') they will NOT match stitched labels ('Apple Pick this one.') and
// planStep returns null, which is the correct graceful-degradation signal that causes
// the caller to fall back to the proven static buildAnswerProgram model.
const FIXTURE_NON_FINAL = `\
←  ⊠ Fruits   □ Colors   ✔ Submit   →
DEBUG TEST 1 — select MULTIPLE fruits (pick 2 or more)
› 1. [✓] Apple
   Pick this one.
2. [✓] Banana
   And this one — choosing 2+ is the whole point.
3. [ ] Cherry
   Optionally this too.
4. [ ] Date
   Optionally this too.
5. [ ] Type something
   Next
6. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
`;

const FIXTURE_FINAL = `\
←  ⊠ Fruits   □ Colors   ✔ Submit   →
DEBUG TEST 2 — select MULTIPLE colors (pick 2 or more)
› 1. [ ] Red
2. [ ] Green
3. [ ] Blue
4. [ ] Type something
   Submit
5. Chat about this
`;

const FIXTURE_REVIEW = `\
←  ⊠ Fruits   ⊠ Colors   ✔ Submit   →
Review your answers
● fruits → Apple, Banana
● colors → Red, Green
Ready to submit your answers?
› 1. Submit answers
2. Cancel
`;

// ---------------------------------------------------------------------------
// parsePicker — non-final multi-select question
// ---------------------------------------------------------------------------

test('parsePicker: non-final fixture — confidence ok, isReview false', () => {
  const result = parsePicker(FIXTURE_NON_FINAL);
  assert.equal(result.confidence, 'ok');
  assert.equal(result.isReview, false);
});

test('parsePicker: non-final fixture — actionLabel is Next', () => {
  const result = parsePicker(FIXTURE_NON_FINAL);
  assert.equal(result.actionLabel, 'Next');
});

test('parsePicker: non-final fixture — 7 navigable rows', () => {
  const result = parsePicker(FIXTURE_NON_FINAL);
  // options 1-4, type-something, action(Next), chat
  assert.equal(result.rows.length, 7);
});

test('parsePicker: non-final fixture — option rows in order (stitched labels)', () => {
  // Description lines are contiguous (no blank separator) so reconstructOptionLines
  // stitches them into the label. The parsed labels reflect the real stitched values.
  const { rows } = parsePicker(FIXTURE_NON_FINAL);
  const options = rows.filter((r) => r.kind === 'option');
  assert.equal(options.length, 4);
  assert.equal(options[0].label, 'Apple Pick this one.');
  assert.equal(options[1].label, 'Banana And this one — choosing 2+ is the whole point.');
  assert.equal(options[2].label, 'Cherry Optionally this too.');
  assert.equal(options[3].label, 'Date Optionally this too.');
});

test('parsePicker: non-final fixture — checked state matches render', () => {
  const { rows } = parsePicker(FIXTURE_NON_FINAL);
  const options = rows.filter((r) => r.kind === 'option');
  assert.equal(options[0].checked, true,  'Apple should be checked');
  assert.equal(options[1].checked, true,  'Banana should be checked');
  assert.equal(options[2].checked, false, 'Cherry should be unchecked');
  assert.equal(options[3].checked, false, 'Date should be unchecked');
});

test('parsePicker: non-final fixture — cursor is on row 0 (Apple)', () => {
  const { rows } = parsePicker(FIXTURE_NON_FINAL);
  assert.equal(rows[0].cursor, true,  'Apple row should have cursor');
  assert.equal(rows[1].cursor, false, 'Banana row should not have cursor');
});

test('parsePicker: non-final fixture — type-something, action, chat rows present', () => {
  const { rows } = parsePicker(FIXTURE_NON_FINAL);
  const kinds = rows.map((r) => r.kind);
  assert.ok(kinds.includes('type-something'));
  assert.ok(kinds.includes('action'));
  assert.ok(kinds.includes('chat'));
});

test('parsePicker: non-final fixture — action row label is Next', () => {
  const { rows } = parsePicker(FIXTURE_NON_FINAL);
  const action = rows.find((r) => r.kind === 'action');
  assert.equal(action.label, 'Next');
});

// ---------------------------------------------------------------------------
// parsePicker — final multi-select question
// ---------------------------------------------------------------------------

test('parsePicker: final fixture — confidence ok, isReview false', () => {
  const result = parsePicker(FIXTURE_FINAL);
  assert.equal(result.confidence, 'ok');
  assert.equal(result.isReview, false);
});

test('parsePicker: final fixture — actionLabel is Submit', () => {
  const result = parsePicker(FIXTURE_FINAL);
  assert.equal(result.actionLabel, 'Submit');
});

test('parsePicker: final fixture — 3 options all unchecked, 6 total rows', () => {
  const { rows } = parsePicker(FIXTURE_FINAL);
  // Red, Green, Blue, type-something, action/Submit, chat
  assert.equal(rows.length, 6);
  const options = rows.filter((r) => r.kind === 'option');
  assert.equal(options.length, 3);
  assert.equal(options[0].label, 'Red');
  assert.equal(options[1].label, 'Green');
  assert.equal(options[2].label, 'Blue');
  assert.ok(options.every((o) => !o.checked), 'all should be unchecked');
});

test('parsePicker: final fixture — cursor on Red (first option)', () => {
  const { rows } = parsePicker(FIXTURE_FINAL);
  assert.equal(rows[0].cursor, true);
  assert.equal(rows[0].label, 'Red');
});

test('parsePicker: final fixture — action row label is Submit', () => {
  const { rows } = parsePicker(FIXTURE_FINAL);
  const action = rows.find((r) => r.kind === 'action');
  assert.ok(action, 'action row must exist');
  assert.equal(action.label, 'Submit');
});

// ---------------------------------------------------------------------------
// parsePicker — review screen
// ---------------------------------------------------------------------------

test('parsePicker: review fixture — isReview true', () => {
  const result = parsePicker(FIXTURE_REVIEW);
  assert.equal(result.isReview, true);
});

test('parsePicker: review fixture — confidence ok', () => {
  const result = parsePicker(FIXTURE_REVIEW);
  assert.equal(result.confidence, 'ok');
});

test('parsePicker: review fixture — rows: review-submit + review-cancel', () => {
  const { rows } = parsePicker(FIXTURE_REVIEW);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'review-submit');
  assert.equal(rows[1].kind, 'review-cancel');
});

test('parsePicker: review fixture — cursor on Submit answers', () => {
  const { rows } = parsePicker(FIXTURE_REVIEW);
  assert.equal(rows[0].cursor, true,  'Submit answers has cursor');
  assert.equal(rows[1].cursor, false, 'Cancel does not have cursor');
});

test('parsePicker: review fixture — actionLabel is null', () => {
  const { rows: _, actionLabel } = parsePicker(FIXTURE_REVIEW);
  assert.equal(actionLabel, null);
});

// ---------------------------------------------------------------------------
// parsePicker — edge cases
// ---------------------------------------------------------------------------

test('parsePicker: empty string → low confidence', () => {
  assert.equal(parsePicker('').confidence, 'low');
});

test('parsePicker: null → low confidence', () => {
  assert.equal(parsePicker(null).confidence, 'low');
});

test('parsePicker: non-picker text → low confidence', () => {
  assert.equal(parsePicker('Hello world\nsome random output\n').confidence, 'low');
});

test('parsePicker: strips ANSI escapes before parsing', () => {
  // Wrap the fixture lines with color codes; parser should still work.
  const ansiWrapped = FIXTURE_FINAL.replace(
    '1. [ ] Red',
    '\x1b[32m1. [ ] Red\x1b[0m',
  );
  const result = parsePicker(ansiWrapped);
  assert.equal(result.confidence, 'ok');
  const options = result.rows.filter((r) => r.kind === 'option');
  assert.equal(options[0].label, 'Red');
});

// ---------------------------------------------------------------------------
// planStep — non-final multi-select question
// ---------------------------------------------------------------------------

test('planStep: select Cherry+Date on non-final (both unchecked, cursor on Apple)', () => {
  // From FIXTURE_NON_FINAL: parsed labels are stitched (description folded in).
  // Navigable row order:
  //   Apple Pick this one.(0,checked), Banana And this...(1,checked),
  //   Cherry Optionally this too.(2,unchecked), Date Optionally this too.(3,unchecked),
  //   type-something(4), action/Next(5), chat(6).
  // Cursor at Apple (idx 0).
  // Selections: Cherry Optionally this too.(idx2), Date Optionally this too.(idx3).
  // Keys expected:
  //   Down,Down → Cherry (unchecked → Space), cursor=2
  //   Down → Date (unchecked → Space), cursor=3
  //   Down,Down → action(Next) at idx5, Enter
  const parsed = parsePicker(FIXTURE_NON_FINAL);
  const question = {
    multiSelect: true,
    options: [
      { label: 'Apple Pick this one.' },
      { label: 'Banana And this one — choosing 2+ is the whole point.' },
      { label: 'Cherry Optionally this too.' },
      { label: 'Date Optionally this too.' },
    ],
  };
  const keys = planStep(parsed, question, ['Cherry Optionally this too.', 'Date Optionally this too.']);
  assert.ok(Array.isArray(keys), 'should return key array');
  assert.deepEqual(keys, ['Down', 'Down', 'Space', 'Down', 'Space', 'Down', 'Down', 'Enter']);
});

test('planStep: pre-checked options (Apple/Banana) skipped — no Space sent', () => {
  // Selecting Apple+Banana but they are already checked → no Space for either.
  // Labels must be stitched to match what parsePicker produces from FIXTURE_NON_FINAL.
  // Cursor at Apple (idx0), navigate to action(Next) at idx5, Enter.
  const parsed = parsePicker(FIXTURE_NON_FINAL);
  const question = {
    multiSelect: true,
    options: [
      { label: 'Apple Pick this one.' },
      { label: 'Banana And this one — choosing 2+ is the whole point.' },
      { label: 'Cherry Optionally this too.' },
      { label: 'Date Optionally this too.' },
    ],
  };
  const keys = planStep(parsed, question, ['Apple Pick this one.', 'Banana And this one — choosing 2+ is the whole point.']);
  // Apple: idx0, cursor=0 → no Down, already checked so no Space, cursor stays 0
  // Banana: idx1, cursor=0 → Down, already checked so no Space, cursor=1
  // action at idx5: cursor=1 → Down,Down,Down,Down (4 Downs) to idx5, Enter
  assert.deepEqual(keys, ['Down', 'Down', 'Down', 'Down', 'Down', 'Enter']);
});

test('planStep: non-final — short structured labels (not stitched) → null (graceful fallback)', () => {
  // When question.options carry the SHORT structured label ('Cherry') and the parsed
  // picker has STITCHED labels ('Cherry Optionally this too.'), exact-match fails and
  // planStep returns null. This is the intended graceful-degradation contract: the
  // caller falls back to the proven static buildAnswerProgram model.
  const parsed = parsePicker(FIXTURE_NON_FINAL);
  const question = {
    multiSelect: true,
    options: [
      { label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }, { label: 'Date' },
    ],
  };
  const keys = planStep(parsed, question, ['Cherry']);
  assert.equal(keys, null, 'short label that does not match stitched parsed label must return null');
});

test('planStep: final fixture — select Red+Green', () => {
  // FIXTURE_FINAL: Red(idx0), Green(idx1), Blue(idx2), type-something(idx3),
  //   action/Submit(idx4), chat(idx5). Cursor at Red (idx0).
  // Selections: Red(0), Green(1) — both unchecked.
  // Keys: Space(Red,idx0), Down, Space(Green,idx1), Down,Down,Down, Enter
  const parsed = parsePicker(FIXTURE_FINAL);
  const question = {
    multiSelect: true,
    options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
  };
  const keys = planStep(parsed, question, ['Red', 'Green']);
  assert.deepEqual(keys, ['Space', 'Down', 'Space', 'Down', 'Down', 'Down', 'Enter']);
});

test('planStep: unknown label → null (fall back)', () => {
  const parsed = parsePicker(FIXTURE_FINAL);
  const question = {
    multiSelect: true,
    options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
  };
  const keys = planStep(parsed, question, ['Purple']);
  assert.equal(keys, null);
});

test('planStep: review screen → null', () => {
  const parsed = parsePicker(FIXTURE_REVIEW);
  const question = { multiSelect: false, options: [{ label: 'x' }] };
  const keys = planStep(parsed, question, ['x']);
  assert.equal(keys, null);
});

test('planStep: low confidence → null', () => {
  const parsed = parsePicker('');
  const question = { multiSelect: false, options: [{ label: 'x' }] };
  const keys = planStep(parsed, question, ['x']);
  assert.equal(keys, null);
});

test('planStep: single-select — navigate down to Green', () => {
  // FIXTURE_FINAL, single-select, cursor at Red (idx0), target Green (idx1).
  const parsed = parsePicker(FIXTURE_FINAL);
  const question = {
    multiSelect: false,
    options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
  };
  const keys = planStep(parsed, question, ['Green']);
  assert.deepEqual(keys, ['Down', 'Enter']);
});

test('planStep: single-select — target already at cursor', () => {
  // Cursor is on Red (idx0), selecting Red → no Down needed.
  const parsed = parsePicker(FIXTURE_FINAL);
  const question = {
    multiSelect: false,
    options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
  };
  const keys = planStep(parsed, question, ['Red']);
  assert.deepEqual(keys, ['Enter']);
});

// ---------------------------------------------------------------------------
// Narrow-pane (~22-col) multi-select: wrapped option labels
// ---------------------------------------------------------------------------
//
// On a ~22-col tmux pane, option labels that exceed the remaining column budget
// hard-wrap onto the next physical line. The old parsePicker OPTION_RE:
//   /^\d+\.\s+\[([✓x✗ ])\]\s*(.*)/
// requires the FULL "N. [x] Label" sequence on a single physical line and has NO
// continuation-line stitching, so it captures only the label fragment that fits
// on the first line ("Ripe Mango") and loses the tail ("Smoothie").
//
// The new implementation uses reconstructOptionLines (shared with detectPanePicker)
// which stitches continuation lines, so the full reconstructed label is correct.
// This fixture is intentionally designed so that:
//   (a) option 1 label wraps: "1. [✓] Ripe Mango" / "Smoothie" → "Ripe Mango Smoothie"
//   (b) option 2 label wraps: "2. [ ] Fresh" / "Strawberry" → "Fresh Strawberry"
// The old OPTION_RE would produce "Ripe Mango" and "Fresh" (wrong labels), causing
// planStep to return null for the "Fresh Strawberry" selection → the fix is verified.
//
// Footer is hard-wrapped across 3 lines (as on a real 22-col narrow pane) to
// confirm detectPanePicker's AQU-footer detection still fires (hasCursorGlyph also fires).

const FIXTURE_NARROW_WRAPPED = `\
› 1. [✓] Ripe Mango
       Smoothie
2. [ ] Fresh
      Strawberry
3. [ ] Type something
Next
4. Chat about this
Enter to select · ↑/↓
to navigate · Esc to
cancel
`;

test('parsePicker: narrow-pane wrapped — reconstructs wrapped labels, full rows[], confidence ok', () => {
  // Verifies that continuation-line stitching correctly assembles multi-physical-line
  // labels. Old OPTION_RE (single-line) would produce "Ripe Mango" not "Ripe Mango Smoothie".
  const result = parsePicker(FIXTURE_NARROW_WRAPPED);
  assert.equal(result.confidence, 'ok');
  assert.equal(result.isReview, false);

  const { rows } = result;
  // 2 options + type-something + action(Next) + chat = 5 navigable rows.
  assert.equal(rows.length, 5, 'expected 5 navigable rows');

  const options = rows.filter((r) => r.kind === 'option');
  assert.equal(options.length, 2, 'expected 2 option rows');

  // Labels must be fully reconstructed (fail against old OPTION_RE which yields "Ripe Mango" / "Fresh").
  assert.equal(options[0].label, 'Ripe Mango Smoothie', 'option 1 label must join continuation line');
  assert.equal(options[1].label, 'Fresh Strawberry',    'option 2 label must join continuation line');

  // Checked states.
  assert.equal(options[0].checked, true,  'option 1 should be checked (✓)');
  assert.equal(options[1].checked, false, 'option 2 should be unchecked');

  // Cursor is on option 1.
  assert.equal(rows[0].cursor, true,  'option 1 has cursor (›)');
  assert.equal(rows[1].cursor, false, 'option 2 has no cursor');

  // Special rows present and in correct screen order.
  const kinds = rows.map((r) => r.kind);
  assert.ok(kinds.includes('type-something'), 'type-something row must be present');
  assert.ok(kinds.includes('action'),         'action row must be present');
  assert.ok(kinds.includes('chat'),           'chat row must be present');

  // Screen order: option, option, type-something, action, chat.
  assert.deepEqual(kinds, ['option', 'option', 'type-something', 'action', 'chat']);

  // actionLabel.
  assert.equal(result.actionLabel, 'Next');
});

test('planStep: narrow-pane wrapped — select Fresh Strawberry produces correct keystroke plan', () => {
  // Navigable row layout (reconstructed):
  //   idx0: option "Ripe Mango Smoothie" (checked, cursor here)
  //   idx1: option "Fresh Strawberry"    (unchecked)
  //   idx2: type-something
  //   idx3: action/Next
  //   idx4: chat
  //
  // Selecting "Fresh Strawberry" (idx1, unchecked):
  //   cursor=0 → Down → idx1 → Space (toggle unchecked→checked) → cursor=1
  //   idx1→idx3 (action): Down×2
  //   Enter
  //
  // The OLD parsePicker with single-line OPTION_RE would parse option 2 as label
  // "Fresh" (missing "Strawberry"), so planStep would receive label "Fresh Strawberry"
  // from the question, fail to find a matching row, and return null. This test
  // confirms the fix works end-to-end.
  const parsed = parsePicker(FIXTURE_NARROW_WRAPPED);
  const question = {
    multiSelect: true,
    options: [
      { label: 'Ripe Mango Smoothie' },
      { label: 'Fresh Strawberry' },
    ],
  };
  const keys = planStep(parsed, question, ['Fresh Strawberry']);
  assert.ok(Array.isArray(keys), 'planStep should return key array (not null)');
  assert.deepEqual(keys, ['Down', 'Space', 'Down', 'Down', 'Enter']);
});
