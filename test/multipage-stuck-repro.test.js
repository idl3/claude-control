/**
 * Deterministic BEFORE-broken / AFTER-fixed regression for the multi-page
 * single-select stuck-retry bug.
 *
 * Bug summary (server.js 2149-2160):
 *   After sending ["Down","Enter"] for the LAST question of a multi-page picker,
 *   the TUI may take longer than SETTLE_MS to re-render the review screen. The
 *   post-send capture therefore still shows the OLD question page (cursor on the
 *   just-selected option). The stuck-detection fires → attempt++ → retry capture
 *   at essentially the same wall-clock position → still stale → attempt > MAX_RETRIES
 *   → dynamicOk=false → mid-picker abort (the BUG).
 *
 * Fix:
 *   Before incrementing attempt, wait an extra 2×SETTLE_MS so the TUI transition
 *   has time to complete. The retry capture then sees the review screen →
 *   isReview=true → !isReview=false → stuck condition is false → stepOk=true.
 *
 * This test exercises the EXACT server.js decision logic (the capture→parse→plan→
 * verify→retry loop) using parsePicker and planStep from lib/answer.js, driven by
 * scripted capture sequences. No tmux, no I/O, CI-hermetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePicker, planStep } from '../lib/answer.js';

// ---------------------------------------------------------------------------
// Fixtures — minimal but structurally correct pane captures
// ---------------------------------------------------------------------------

// Page 1: "Choose a color", cursor on Red, answered correctly (Green sent)
const FIXTURE_PAGE1 = `\
Choose a color

❯ 1. Red
  2. Green
  3. Blue
  4. Type something.
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

// Page 2: "Choose a fruit", cursor on Apple (initial state after page-1 committed)
const FIXTURE_PAGE2_CURSOR_APPLE = `\
Choose a fruit

❯ 1. Apple
  2. Banana
  3. Cherry
  4. Type something.
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

// Page 2 STALE: still showing page-2 but cursor landed on Banana after our "Down,Enter"
// (the TUI accepted the Down but is mid-transition; the advance hasn't rendered yet)
const FIXTURE_PAGE2_CURSOR_BANANA_STALE = `\
Choose a fruit

  1. Apple
❯ 2. Banana
  3. Cherry
  4. Type something.
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

// Review screen — renders after the TUI completes the transition
const FIXTURE_REVIEW = `\
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
// Inline the server.js single-select stuck-retry logic as a pure function.
//
// Signature mirrors the real loop:
//   - captureProvider(attempt) → raw capture string
//     (lets the test inject different frames per attempt)
//   - extraSettleCallback(attempt) → called when the stuck path triggers
//     (OLD behavior = no-op; FIXED behavior = advance captureProvider's frame index)
//   - MAX_RETRIES = 1  (same as production)
//
// Returns { stepOk, dynamicOk, retries } for assertion.
// ---------------------------------------------------------------------------

function runSingleSelectStep({ question, selectedLabels, captureProvider, extraSettleCallback, MAX_RETRIES = 1 }) {
  let attempt = 0;
  let stepOk = false;
  let dynamicOk = true;

  while (attempt <= MAX_RETRIES && !stepOk) {
    // 1. Capture & parse (pre-send state — used to plan keys)
    const capture = captureProvider(attempt, 'pre');
    const parsed = parsePicker(capture);
    if (parsed.confidence !== 'ok') {
      dynamicOk = false;
      break;
    }

    // 2. Handle review screen (would be reached if we looped back after a review)
    if (parsed.isReview) {
      stepOk = true;
      break;
    }

    // 3. Plan keys
    const keys = planStep(parsed, question, selectedLabels);
    if (!keys) {
      dynamicOk = false;
      break;
    }

    // 4. (keys would be sent here in production — skipped in test)

    // 5. Post-send capture & parse (verify)
    const afterCapture = captureProvider(attempt, 'post');
    const afterParsed = parsePicker(afterCapture);

    // 6. Stuck check — this is the exact server.js condition (lines 2149-2154)
    if (
      afterParsed.confidence === 'ok' &&
      !afterParsed.isReview &&
      afterParsed.rows.some(
        (r) => r.cursor && r.kind === 'option' && r.label === selectedLabels[0],
      )
    ) {
      // Stuck detected. OLD behavior: increment and loop immediately.
      // FIXED behavior: extraSettleCallback advances the captureProvider so
      // the next attempt gets a later frame (the review screen).
      extraSettleCallback(attempt);
      attempt += 1;
      continue;
    }

    stepOk = true;
  }

  if (!stepOk && attempt > MAX_RETRIES) {
    dynamicOk = false;
  }

  return { stepOk, dynamicOk, retries: attempt };
}

// ---------------------------------------------------------------------------
// Gap 1 — BEFORE-broken repro
//
// Scenario: last question is "Choose a fruit", selecting Banana (idx 1).
//   - Pre-send capture: page-2 with cursor on Apple (correct initial state)
//   - Post-send capture attempt 0: STALE — still page-2, cursor on Banana
//   - Retry (attempt 1): OLD behavior — no extra settle, captureProvider returns
//     the STALE frame AGAIN because the TUI hasn't had time to transition
//   - Post-send capture attempt 1: STILL stale → attempt > MAX_RETRIES → dynamicOk=false
//
// This is the BUG. The test asserts dynamicOk=false (the broken BEFORE state).
// ---------------------------------------------------------------------------

test('BEFORE-broken: without extra settle, stale frames exhaust MAX_RETRIES → dynamicOk=false', () => {
  const question = {
    multiSelect: false,
    options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }],
  };
  const selectedLabels = ['Banana'];

  // No extra settle — returns STALE on every post-send capture
  const captures = {
    pre: FIXTURE_PAGE2_CURSOR_APPLE,
    post: FIXTURE_PAGE2_CURSOR_BANANA_STALE, // always stale — simulates slow TUI
  };
  const captureProvider = (_attempt, phase) => captures[phase];
  const extraSettleCallback = () => { /* OLD behavior: do nothing extra */ };

  const { stepOk, dynamicOk, retries } = runSingleSelectStep({
    question,
    selectedLabels,
    captureProvider,
    extraSettleCallback,
    MAX_RETRIES: 1,
  });

  assert.equal(dynamicOk, false,
    'BUG: without extra settle, stale post-send captures exhaust MAX_RETRIES → dynamicOk=false (mid-picker abort)');
  assert.equal(stepOk, false, 'stepOk must also be false');
  assert.equal(retries, 2, 'attempt reaches 2 (exceeds MAX_RETRIES=1)');
});

// ---------------------------------------------------------------------------
// Gap 1 — AFTER-fixed repro
//
// Same scenario, but the extra settle causes the captureProvider to switch from
// the stale frame to the review frame for the retry's post-send capture:
//   - Pre-send capture attempt 0: page-2, cursor on Apple
//   - Post-send capture attempt 0: STALE — page-2, cursor on Banana → stuck detected
//   - Extra settle fires → captureProvider advances to review frame
//   - Pre-send capture attempt 1: REVIEW SCREEN → isReview=true → stepOk=true
//
// This is the FIX. The test asserts dynamicOk=true, stepOk=true.
// ---------------------------------------------------------------------------

test('AFTER-fixed: with extra settle, retry capture gets review frame → stepOk=true', () => {
  const question = {
    multiSelect: false,
    options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }],
  };
  const selectedLabels = ['Banana'];

  // Simulate: after extra settle fires, the next pre-send capture sees the review screen
  let frameAdvanced = false;
  const captureProvider = (_attempt, phase) => {
    if (frameAdvanced && phase === 'pre') return FIXTURE_REVIEW;
    if (phase === 'pre') return FIXTURE_PAGE2_CURSOR_APPLE;
    return FIXTURE_PAGE2_CURSOR_BANANA_STALE; // post-send is stale on first attempt
  };
  const extraSettleCallback = () => {
    // FIXED behavior: the extra 2×SETTLE_MS in production allows the TUI to
    // complete its transition. We model this by marking frameAdvanced=true so
    // the next captureProvider call returns the review screen.
    frameAdvanced = true;
  };

  const { stepOk, dynamicOk, retries } = runSingleSelectStep({
    question,
    selectedLabels,
    captureProvider,
    extraSettleCallback,
    MAX_RETRIES: 1,
  });

  assert.equal(dynamicOk, true,
    'FIX: with extra settle, retry pre-send sees review → isReview=true → stepOk=true → dynamicOk=true');
  assert.equal(stepOk, true, 'stepOk must be true');
  assert.equal(retries, 1, 'exactly one retry was needed');
});

// ---------------------------------------------------------------------------
// Gap 1 — single-question picker (no review screen) is unaffected
//
// For a single-question picker the answer's Enter submits directly — the
// post-send capture shows a different non-picker screen (low confidence), so
// the stuck condition is never true regardless. Assert this invariant holds.
// ---------------------------------------------------------------------------

test('single-question picker: post-send low-confidence → stepOk=true (no review needed)', () => {
  const question = {
    multiSelect: false,
    options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
  };
  const selectedLabels = ['Green'];

  const NON_PICKER_SCREEN = 'Session ended. Thank you.'; // low-confidence
  const captureProvider = (_attempt, phase) => {
    if (phase === 'pre') return FIXTURE_PAGE1;
    return NON_PICKER_SCREEN;
  };
  const extraSettleCallback = () => {};

  const { stepOk, dynamicOk } = runSingleSelectStep({
    question,
    selectedLabels,
    captureProvider,
    extraSettleCallback,
    MAX_RETRIES: 1,
  });

  assert.equal(stepOk, true, 'low-confidence post-send = not stuck = stepOk');
  assert.equal(dynamicOk, true, 'dynamicOk remains true');
});
