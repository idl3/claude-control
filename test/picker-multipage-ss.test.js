/**
 * Regression tests for multi-page SINGLE-SELECT AskUserQuestion.
 *
 * Bug: a 2-question (each single-select) picker would not be submitted because
 * the single-select advance verify in server.js could exhaust MAX_RETRIES=1 when
 * the TUI took longer than SETTLE_MS (300ms) to transition from the last question
 * page to the review screen, leaving the picker open.
 *
 * Invariants asserted here (all parsePicker/planStep — hermetic, no tmux):
 *  1. parsePicker correctly parses page-1 of a multi-page single-select
 *  2. parsePicker correctly parses page-2 of a multi-page single-select
 *  3. parsePicker detects the review screen (isReview:true, confidence:'ok')
 *  4. planStep produces correct Down+Enter key plan for page-1
 *  5. planStep produces correct Down+Enter key plan for page-2
 *  6. planStep returns null on the review screen (the server handles it via the
 *     isReview branch, not planStep)
 *
 * Fixture text is verbatim from a live run captured via
 * `tmux -L qtest capture-pane -t main -p -J` (join=true, as server uses).
 * Whitespace is preserved exactly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePicker, planStep } from '../lib/answer.js';

// ---------------------------------------------------------------------------
// Live-captured fixtures (verbatim from real claude TUI, 2026-06-27).
// Captured with: tmux -L qtest capture-pane -t main -p -J
// The picker was spawned by:
//   "Call the AskUserQuestion tool with exactly two questions, each
//    single-select with 3 options."
// ---------------------------------------------------------------------------

// PAGE 1 — "Choose a color" (single-select, 3 options, cursor on Red)
const FIXTURE_SS_PAGE1 = `\
←  ☐ Color  ☐ Fruit  ✔ Submit  →

Choose a color

❯ 1. Red
     The color red.
  2. Green
     The color green.
  3. Blue
     The color blue.
  4. Type something.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;

// PAGE 2 — "Choose a fruit" (single-select, 3 options, cursor on Apple)
// Appears after the color question is answered.
const FIXTURE_SS_PAGE2 = `\
←  ☒ Color  ☐ Fruit  ✔ Submit  →

Choose a fruit

❯ 1. Apple
     The fruit apple.
  2. Banana
     The fruit banana.
  3. Cherry
     The fruit cherry.
  4. Type something.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;

// REVIEW SCREEN — appears after both questions are answered.
// Exact text captured live (join=true collapses trailing spaces but preserves
// the "Ready to submit your answers?" line which is required for isReview detection).
const FIXTURE_SS_REVIEW = `\
←  ☒ Color  ☒ Fruit  ✔ Submit  →

Review your answers

 ● Choose a color
   → Green
 ● Choose a fruit
   → Banana

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel
`;

// ---------------------------------------------------------------------------
// parsePicker — page-1 (single-select, color question)
// ---------------------------------------------------------------------------

test('parsePicker: multi-page ss page-1 — confidence ok, not review', () => {
  const result = parsePicker(FIXTURE_SS_PAGE1);
  assert.equal(result.confidence, 'ok');
  assert.equal(result.isReview, false);
});

test('parsePicker: multi-page ss page-1 — 5 navigable rows (3 real opts + Type something. + chat)', () => {
  const { rows } = parsePicker(FIXTURE_SS_PAGE1);
  // The live TUI renders "4. Type something." (with trailing period), which does NOT match
  // /^Type something$/i — so it parses as a regular option row, not a type-something row.
  // Total: Red, Green, Blue, Type something. (as option), Chat about this = 5 rows.
  assert.equal(rows.length, 5);
});

test('parsePicker: multi-page ss page-1 — real answer option labels present', () => {
  const { rows } = parsePicker(FIXTURE_SS_PAGE1);
  const opts = rows.filter((r) => r.kind === 'option');
  // Red, Green, Blue are real options; "Type something." is also parsed as an option
  // due to the trailing period (live TUI rendering). planStep resolves by label match.
  assert.ok(opts.some((o) => o.label === 'Red'),   'Red must be an option row');
  assert.ok(opts.some((o) => o.label === 'Green'), 'Green must be an option row');
  assert.ok(opts.some((o) => o.label === 'Blue'),  'Blue must be an option row');
});

test('parsePicker: multi-page ss page-1 — cursor on Red (first option)', () => {
  const { rows } = parsePicker(FIXTURE_SS_PAGE1);
  assert.equal(rows[0].cursor, true,  'Red has cursor');
  assert.equal(rows[1].cursor, false, 'Green has no cursor');
  assert.equal(rows[2].cursor, false, 'Blue has no cursor');
});

// ---------------------------------------------------------------------------
// parsePicker — page-2 (single-select, fruit question)
// ---------------------------------------------------------------------------

test('parsePicker: multi-page ss page-2 — confidence ok, not review', () => {
  const result = parsePicker(FIXTURE_SS_PAGE2);
  assert.equal(result.confidence, 'ok');
  assert.equal(result.isReview, false);
});

test('parsePicker: multi-page ss page-2 — real answer option labels present', () => {
  const { rows } = parsePicker(FIXTURE_SS_PAGE2);
  const opts = rows.filter((r) => r.kind === 'option');
  // Apple, Banana, Cherry are real options; "Type something." also parses as option.
  assert.ok(opts.some((o) => o.label === 'Apple'),  'Apple must be an option row');
  assert.ok(opts.some((o) => o.label === 'Banana'), 'Banana must be an option row');
  assert.ok(opts.some((o) => o.label === 'Cherry'), 'Cherry must be an option row');
});

test('parsePicker: multi-page ss page-2 — cursor on Apple (first option)', () => {
  const { rows } = parsePicker(FIXTURE_SS_PAGE2);
  assert.equal(rows[0].cursor, true,  'Apple has cursor');
  assert.equal(rows[1].cursor, false, 'Banana has no cursor');
  assert.equal(rows[2].cursor, false, 'Cherry has no cursor');
});

// ---------------------------------------------------------------------------
// parsePicker — review screen
// ---------------------------------------------------------------------------

test('parsePicker: multi-page ss review — isReview true', () => {
  const result = parsePicker(FIXTURE_SS_REVIEW);
  assert.equal(result.isReview, true);
});

test('parsePicker: multi-page ss review — confidence ok', () => {
  const result = parsePicker(FIXTURE_SS_REVIEW);
  assert.equal(result.confidence, 'ok');
});

test('parsePicker: multi-page ss review — rows: review-submit (cursor) + review-cancel', () => {
  const { rows } = parsePicker(FIXTURE_SS_REVIEW);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'review-submit');
  assert.equal(rows[0].label, 'Submit answers');
  assert.equal(rows[0].cursor, true,  'Submit answers has cursor (❯)');
  assert.equal(rows[1].kind, 'review-cancel');
  assert.equal(rows[1].label, 'Cancel');
  assert.equal(rows[1].cursor, false, 'Cancel has no cursor');
});

test('parsePicker: multi-page ss review — actionLabel is null', () => {
  const { actionLabel } = parsePicker(FIXTURE_SS_REVIEW);
  assert.equal(actionLabel, null);
});

// ---------------------------------------------------------------------------
// planStep — page-1 (single-select, selecting Green)
// Cursor starts on Red (idx 0), target Green (idx 1) → Down, Enter.
// ---------------------------------------------------------------------------

test('planStep: multi-page ss page-1 — select Green from cursor-at-Red → [Down, Enter]', () => {
  const parsed = parsePicker(FIXTURE_SS_PAGE1);
  const question = {
    multiSelect: false,
    options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
  };
  const keys = planStep(parsed, question, ['Green']);
  assert.ok(Array.isArray(keys), 'planStep must return key array');
  assert.deepEqual(keys, ['Down', 'Enter']);
});

test('planStep: multi-page ss page-1 — select Red (already at cursor) → [Enter]', () => {
  const parsed = parsePicker(FIXTURE_SS_PAGE1);
  const question = {
    multiSelect: false,
    options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
  };
  const keys = planStep(parsed, question, ['Red']);
  assert.ok(Array.isArray(keys), 'planStep must return key array');
  assert.deepEqual(keys, ['Enter']);
});

// ---------------------------------------------------------------------------
// planStep — page-2 (single-select, selecting Banana)
// Cursor starts on Apple (idx 0), target Banana (idx 1) → Down, Enter.
// ---------------------------------------------------------------------------

test('planStep: multi-page ss page-2 — select Banana from cursor-at-Apple → [Down, Enter]', () => {
  const parsed = parsePicker(FIXTURE_SS_PAGE2);
  const question = {
    multiSelect: false,
    options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }],
  };
  const keys = planStep(parsed, question, ['Banana']);
  assert.ok(Array.isArray(keys), 'planStep must return key array');
  assert.deepEqual(keys, ['Down', 'Enter']);
});

test('planStep: multi-page ss page-2 — select Cherry from cursor-at-Apple → [Down, Down, Enter]', () => {
  const parsed = parsePicker(FIXTURE_SS_PAGE2);
  const question = {
    multiSelect: false,
    options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }],
  };
  const keys = planStep(parsed, question, ['Cherry']);
  assert.ok(Array.isArray(keys), 'planStep must return key array');
  assert.deepEqual(keys, ['Down', 'Down', 'Enter']);
});

// ---------------------------------------------------------------------------
// planStep — review screen returns null (server handles isReview separately)
// ---------------------------------------------------------------------------

test('planStep: multi-page ss review — returns null (server handles via isReview branch)', () => {
  const parsed = parsePicker(FIXTURE_SS_REVIEW);
  const question = {
    multiSelect: false,
    options: [{ label: 'Green' }],
  };
  // planStep must return null for review screens; the server's isReview branch
  // is the correct handler (sends Enter directly without consulting planStep).
  const keys = planStep(parsed, question, ['Green']);
  assert.equal(keys, null, 'planStep must return null on review screen');
});

// ---------------------------------------------------------------------------
// Regression guard: verify the advance-check logic invariant that the fix
// depends on. The "single-select stuck" detection fires when:
//   afterParsed.confidence === 'ok' && !afterParsed.isReview &&
//   afterParsed.rows.some(r => r.cursor && r.kind === 'option' && r.label === selectedLabel)
//
// When the REVIEW SCREEN is the after-send capture, isReview=true so !isReview=false
// → stuck condition is false → stepOk=true. This must remain true so the
// post-loop review handler fires and submits the picker.
// ---------------------------------------------------------------------------

test('regression: review screen isReview=true causes !isReview=false → not-stuck', () => {
  const afterParsed = parsePicker(FIXTURE_SS_REVIEW);
  // Simulate the stuck-check condition from server.js:
  const selectedLabel = 'Banana'; // last question's answer label
  const stuckCondition =
    afterParsed.confidence === 'ok' &&
    !afterParsed.isReview &&
    afterParsed.rows.some(
      (r) => r.cursor && r.kind === 'option' && r.label === selectedLabel,
    );
  assert.equal(stuckCondition, false,
    'review screen must NOT trigger stuck condition: !isReview is false');
});

test('regression: page-2 capture with cursor on Banana triggers stuck condition', () => {
  // This simulates the buggy scenario: after sending ["Down","Enter"] for Banana,
  // the capture (at 300ms) still shows page-2 with cursor on Banana (transition
  // not yet complete). This SHOULD trigger stuck, which now waits extra 2×SETTLE_MS
  // before retry — fixing the exhausted-retries mid-picker-abort.
  //
  // Build a synthetic page-2 capture where Banana has the cursor.
  const page2WithBananaCursor = `\
←  ☒ Color  ☐ Fruit  ✔ Submit  →

Choose a fruit

  1. Apple
     The fruit apple.
❯ 2. Banana
     The fruit banana.
  3. Cherry
     The fruit cherry.
  4. Type something.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;
  const afterParsed = parsePicker(page2WithBananaCursor);
  assert.equal(afterParsed.confidence, 'ok');
  assert.equal(afterParsed.isReview, false);

  const selectedLabel = 'Banana';
  const stuckCondition =
    afterParsed.confidence === 'ok' &&
    !afterParsed.isReview &&
    afterParsed.rows.some(
      (r) => r.cursor && r.kind === 'option' && r.label === selectedLabel,
    );
  assert.equal(stuckCondition, true,
    'page-2 with cursor on Banana MUST trigger stuck condition (verifies that the extra-settle fix path is reachable)');
});

// ---------------------------------------------------------------------------
// Gap-2 regression: label-coincidence false-bail.
//
// Bug: if page N+1's cursor-0 option label equals page N's answer label, the
// OLD stuck check (label-only) fires even though the screen advanced — and more
// settle never helps because the NEXT page legitimately shows that label.
//
// Fix (server.js): also require the option-label SET to be byte-identical to
// the pre-send state. A changed set proves structural advancement regardless of
// what label the cursor is on.
// ---------------------------------------------------------------------------

test('Gap-2: label-coincidence — page-2 starts on same label as page-1 answer (Apple→Apple)', () => {
  // Scenario:
  //   Page 1: "Choose a fruit", answer = "Apple"
  //   Page 2: "Choose a vegetable", first option = "Apple" (cursor on it at idx 0)
  //
  // The OLD stuck check (label-only): cursor && label==='Apple' → stuck=true → false bail.
  // The NEW stuck check must NOT fire because the option-label set changed
  // (page-1 options: Apple/Banana/Cherry/Type something. vs page-2 options: Apple/Carrot/Daikon/Type something.).
  //
  // Fingerprints are derived via parsePicker to match the server.js production path.

  // Pre-send: parse page-1 to get the option-label fingerprint
  const page1Fixture = `\
Choose a fruit

❯ 1. Apple
  2. Banana
  3. Cherry
  4. Type something.
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
  const preParsed = parsePicker(page1Fixture);
  const preSendOptionLabels = preParsed.rows
    .filter((r) => r.kind === 'option')
    .map((r) => r.label)
    .join('\x00');

  // Post-send: page-2 with cursor on Apple (coincidence label)
  const page2AppleCursor = `\
Choose a vegetable

❯ 1. Apple
  2. Carrot
  3. Daikon
  4. Type something.
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

  const afterParsed = parsePicker(page2AppleCursor);
  assert.equal(afterParsed.confidence, 'ok', 'page-2 parses ok');
  assert.equal(afterParsed.isReview, false, 'page-2 is not review');

  // Cursor IS on Apple (the coincidence label)
  const cursorOnCoincidenceLabel = afterParsed.rows.some(
    (r) => r.cursor && r.kind === 'option' && r.label === 'Apple',
  );
  assert.equal(cursorOnCoincidenceLabel, true, 'cursor is on Apple (the coincidence)');

  // Option-label fingerprint AFTER send
  const afterOptionLabels = afterParsed.rows
    .filter((r) => r.kind === 'option')
    .map((r) => r.label)
    .join('\x00');

  // Option sets differ → screen advanced
  const optionSetUnchanged = afterOptionLabels === preSendOptionLabels;
  assert.equal(optionSetUnchanged, false,
    'page-1 and page-2 option sets differ → optionSetUnchanged=false');

  // NEW stuck condition (server.js Gap-2 fix): requires BOTH label-match AND unchanged option set
  const newStuckCondition =
    afterParsed.confidence === 'ok' &&
    !afterParsed.isReview &&
    optionSetUnchanged &&
    cursorOnCoincidenceLabel;

  assert.equal(newStuckCondition, false,
    'Gap-2 fix: changed option set prevents false-bail even when cursor label matches page-N answer');
});

test('Gap-2: genuine stuck still detected — same page, same options, cursor on answered label', () => {
  // This is the REAL stuck case: page DIDN'T advance (option set is identical to
  // pre-send) and cursor is on the answered label. Must still fire.
  //
  // NOTE: "Type something." (with trailing period) parses as an option row in the
  // live TUI. The fingerprint is derived from parsePicker output on the PRE-send
  // capture so it naturally includes it — both sides are computed the same way.

  // Pre-send: cursor on Apple (initial state)
  const page2AppleCursor = `\
Choose a fruit

❯ 1. Apple
  2. Banana
  3. Cherry
  4. Type something.
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
  const preParsed = parsePicker(page2AppleCursor);
  const preSendOptionLabels = preParsed.rows
    .filter((r) => r.kind === 'option')
    .map((r) => r.label)
    .join('\x00');

  // Post-send: same page, cursor landed on Banana (the answered label)
  const page2BananaCursor = `\
Choose a fruit

  1. Apple
❯ 2. Banana
  3. Cherry
  4. Type something.
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

  const afterParsed = parsePicker(page2BananaCursor);
  const afterOptionLabels = afterParsed.rows
    .filter((r) => r.kind === 'option')
    .map((r) => r.label)
    .join('\x00');
  const optionSetUnchanged = afterOptionLabels === preSendOptionLabels;

  assert.equal(optionSetUnchanged, true, 'same-page: option set is identical');

  const cursorOnAnsweredLabel = afterParsed.rows.some(
    (r) => r.cursor && r.kind === 'option' && r.label === 'Banana',
  );
  assert.equal(cursorOnAnsweredLabel, true, 'cursor is on Banana');

  const newStuckCondition =
    afterParsed.confidence === 'ok' &&
    !afterParsed.isReview &&
    optionSetUnchanged &&
    cursorOnAnsweredLabel;

  assert.equal(newStuckCondition, true,
    'genuine stuck (same option set + cursor on answered label) must still fire');
});
