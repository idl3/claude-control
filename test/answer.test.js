import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnswerKeys,
  buildAnswerProgram,
  nextSubmitAction,
  confirmSubmit,
  parsePicker,
  planTextStep,
  isTextDirective,
} from '../lib/answer.js';

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

// ── nextSubmitAction: post-answer submit-confirmation decision ───────────────
// Guards the reported bug: multi-question picker parked on "Submit"/review and
// never actually submitted. The driver loops on this until it returns 'done'.

test('nextSubmitAction: no picker (low confidence) → done (submitted)', () => {
  assert.equal(nextSubmitAction({ rows: [], actionLabel: null, isReview: false, confidence: 'low' }), 'done');
  assert.equal(nextSubmitAction(null), 'done');
});

test('nextSubmitAction: review screen up → enter (send final Submit)', () => {
  const parsed = {
    rows: [
      { kind: 'review-submit', label: 'Submit answers', cursor: true },
      { kind: 'review-cancel', label: 'Cancel', cursor: false },
    ],
    actionLabel: null,
    isReview: true,
    confidence: 'ok',
  };
  assert.equal(nextSubmitAction(parsed), 'enter');
});

test('nextSubmitAction: parked with cursor on the Submit action row (dropped Enter) → enter', () => {
  const parsed = {
    rows: [
      { kind: 'option', label: 'a', checked: true, cursor: false },
      { kind: 'type-something', label: 'Type something', cursor: false },
      { kind: 'action', label: 'Submit', cursor: true },
      { kind: 'chat', label: 'Chat about this', cursor: false },
    ],
    actionLabel: 'Submit',
    isReview: false,
    confidence: 'ok',
  };
  assert.equal(nextSubmitAction(parsed), 'enter');
});

test('nextSubmitAction: picker up but cursor on an option (mid-render) → wait (never blind-Enter an option)', () => {
  const parsed = {
    rows: [
      { kind: 'option', label: 'a', checked: false, cursor: true },
      { kind: 'action', label: 'Submit', cursor: false },
    ],
    actionLabel: 'Submit',
    isReview: false,
    confidence: 'ok',
  };
  assert.equal(nextSubmitAction(parsed), 'wait');
});

// ── parsePicker: the multi-question review screen ────────────────────────────
// Live-style capture of the "Review your answers … Ready to submit your answers?"
// screen that appears after the final question's Submit. This is the frame the
// confirm loop must Enter — and the frame whose ghost in scrollback caused the P1.
const REVIEW_SCREEN = [
  'Review your answers',
  '',
  'Ready to submit your answers?',
  '',
  '❯ 1. Submit answers',
  '  2. Cancel',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

// Same screen but the cursor has (somehow) landed on Cancel — the confirm loop
// must step Up to Submit before Enter, never activating Cancel.
const REVIEW_SCREEN_ON_CANCEL = [
  'Review your answers',
  '',
  'Ready to submit your answers?',
  '',
  '  1. Submit answers',
  '❯ 2. Cancel',
].join('\n');

// The visible pane AFTER the picker submitted: Claude is streaming its reply, no
// picker rows and no review headers → parsePicker returns low confidence.
const PICKER_GONE = [
  '● Got it — proceeding with your selections now.',
  '',
  '  Working through the changes…',
].join('\n');

test('parsePicker: review-screen fixture → isReview, review-submit cursor, review-cancel', () => {
  const parsed = parsePicker(REVIEW_SCREEN);
  assert.equal(parsed.isReview, true);
  assert.equal(parsed.confidence, 'ok');
  const submit = parsed.rows.find((r) => r.kind === 'review-submit');
  const cancel = parsed.rows.find((r) => r.kind === 'review-cancel');
  assert.ok(submit, 'review-submit row parsed');
  assert.ok(cancel, 'review-cancel row parsed');
  assert.equal(submit.cursor, true, 'cursor defaults to Submit answers');
  assert.equal(cancel.cursor, false);
  assert.equal(nextSubmitAction(parsed), 'enter');
});

test('parsePicker: PICKER_GONE (streaming reply) → low confidence, nextSubmitAction done', () => {
  const parsed = parsePicker(PICKER_GONE);
  assert.equal(parsed.confidence, 'low');
  assert.equal(nextSubmitAction(parsed), 'done');
});

// ── confirmSubmit: the post-answer submit-confirmation loop ───────────────────
// A test IO harness: `capture()` yields the next queued frame (repeating the last
// once exhausted — models a state that persists); sendEnter/sendUp record calls;
// delay is instant so tests run fast.
function makeIo(frames) {
  const calls = { enters: 0, ups: 0, captures: 0 };
  let i = 0;
  const io = {
    capture: async () => {
      calls.captures += 1;
      const f = frames[Math.min(i, frames.length - 1)];
      i += 1;
      return f;
    },
    sendEnter: async () => { calls.enters += 1; },
    sendUp: async () => { calls.ups += 1; },
    delay: async () => {},
  };
  return { io, calls };
}

test('confirmSubmit: review screen up → one Enter → picker gone → true', async () => {
  const { io, calls } = makeIo([REVIEW_SCREEN, PICKER_GONE]);
  const ok = await confirmSubmit({ ...io, tries: 6 });
  assert.equal(ok, true);
  assert.equal(calls.enters, 1, 'exactly one Enter to submit the review screen');
  assert.equal(calls.ups, 0, 'no Up needed — cursor already on Submit');
});

// REGRESSION (the P1 root cause): if the capture is polluted by the just-submitted
// review screen frozen in scrollback (the "ghost"), it never clears, so confirmSubmit
// keeps Entering and correctly FAILS LOUD instead of hanging — which is exactly why
// the driver MUST feed it a VISIBLE-ONLY capture (server wires visibleOnly:true), so
// that after the real submit the frame is gone and this returns true (prior test).
test('confirmSubmit: capture never clears (scrollback ghost) → exhausts budget → false', async () => {
  const { io, calls } = makeIo([REVIEW_SCREEN]); // repeats forever
  const ok = await confirmSubmit({ ...io, tries: 5 });
  assert.equal(ok, false, 'never confirmed gone → fail loud');
  assert.ok(calls.enters >= 1, 'did try to submit');
});

// Transition-blank guard: the FIRST visible capture can be a blank mid-transition
// frame (question erased, review not yet drawn). That must NOT be mistaken for a
// submitted picker — confirmSubmit must wait, see the review, Enter it, then confirm.
test('confirmSubmit: transition-blank first frame is not a false "done"', async () => {
  const { io, calls } = makeIo(['', REVIEW_SCREEN, PICKER_GONE]);
  const ok = await confirmSubmit({ ...io, tries: 6 });
  assert.equal(ok, true);
  assert.equal(calls.enters, 1, 'entered the review only after it actually appeared');
});

// A single multi-select question (its own Submit action row) whose action Enter
// already submitted: no review screen, picker already gone → two consecutive gone
// captures confirm without sending any stray Enter.
test('confirmSubmit: already gone (no review) → two gone reads → true, no Enter', async () => {
  const { io, calls } = makeIo([PICKER_GONE, PICKER_GONE]);
  const ok = await confirmSubmit({ ...io, tries: 6 });
  assert.equal(ok, true);
  assert.equal(calls.enters, 0, 'nothing to submit — never Enter into the composer');
});

// Dropped last-action Enter: the picker is parked with the cursor on its Submit
// action row. confirmSubmit re-fires Enter → review screen → Enter → gone.
test('confirmSubmit: parked action row (dropped Enter) → Enter → review → Enter → gone → true', async () => {
  // The picker is parked with the cursor on its BARE "Submit" action row (the real
  // multi-select picker renders the action row un-numbered; a numbered "N. Submit"
  // would parse as an option, not an action).
  const PARKED_ON_ACTION = [
    '? Pick fruit',
    '  1. Apple',
    '  2. Banana',
    '  Type something',
    '❯ Submit',
    '  Chat about this',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');
  const parsedParked = parsePicker(PARKED_ON_ACTION);
  assert.equal(nextSubmitAction(parsedParked), 'enter', 'cursor on action row → enter');
  const { io, calls } = makeIo([PARKED_ON_ACTION, REVIEW_SCREEN, PICKER_GONE]);
  const ok = await confirmSubmit({ ...io, tries: 6 });
  assert.equal(ok, true);
  assert.equal(calls.enters, 2, 'one Enter to leave the parked row, one on the review screen');
});

// Cursor-on-Cancel safety: never activate "Cancel". confirmSubmit steps Up first.
test('confirmSubmit: review cursor on Cancel → steps Up before Enter', async () => {
  const { io, calls } = makeIo([REVIEW_SCREEN_ON_CANCEL, PICKER_GONE]);
  const ok = await confirmSubmit({ ...io, tries: 6 });
  assert.equal(ok, true);
  assert.equal(calls.ups, 1, 'stepped Up off Cancel');
  assert.equal(calls.enters, 1, 'then Entered Submit');
});

test('confirmSubmit: capture throws → false (cannot confirm, fail loud)', async () => {
  const ok = await confirmSubmit({
    capture: async () => { throw new Error('tmux gone'); },
    sendEnter: async () => {},
    sendUp: async () => {},
    delay: async () => {},
    tries: 6,
  });
  assert.equal(ok, false);
});

// ── free-text / chat directive discriminator ─────────────────────────────────
// The load-bearing guard: a per-question selection is EITHER chosen option labels
// (string[]) OR a {kind:'text'|'chat', text} directive. It must never be possible
// for one to be mistaken for the other (that ambiguity is the whole P0 bug).

test('isTextDirective: {kind:text} and {kind:chat} with string text → true', () => {
  assert.equal(isTextDirective({ kind: 'text', text: 'hello' }), true);
  assert.equal(isTextDirective({ kind: 'chat', text: 'hi there' }), true);
  assert.equal(isTextDirective({ kind: 'text', text: '' }), true); // shape is a directive; planTextStep rejects empty
});

test('isTextDirective: option-label arrays and junk → false (never a directive)', () => {
  assert.equal(isTextDirective(['Apple']), false);
  assert.equal(isTextDirective([]), false);
  assert.equal(isTextDirective(['Type something']), false); // a bare label array is NOT a directive
  assert.equal(isTextDirective({ kind: 'option', text: 'x' }), false);
  assert.equal(isTextDirective({ kind: 'text' }), false); // no text field
  assert.equal(isTextDirective(null), false);
  assert.equal(isTextDirective(undefined), false);
  assert.equal(isTextDirective('Type something'), false);
});

// ── planTextStep: navigate to + activate the free-text row, then type ────────

const FREETEXT_PICKER = {
  rows: [
    { kind: 'option', label: 'Apple', checked: false, cursor: true },
    { kind: 'option', label: 'Banana', checked: false, cursor: false },
    { kind: 'type-something', label: 'Type something', cursor: false },
    { kind: 'action', label: 'Submit', cursor: false },
    { kind: 'chat', label: 'Chat about this', cursor: false },
  ],
  actionLabel: 'Submit',
  isReview: false,
  confidence: 'ok',
};

test('planTextStep: text directive → Down to the "Type something" row then Enter (activate), text carried separately', () => {
  const plan = planTextStep(FREETEXT_PICKER, { kind: 'text', text: 'my sentinel answer' });
  assert.deepEqual(plan, {
    navKeys: ['Down', 'Down', 'Enter'], // cursor@0 → type-something@2, Enter opens the input
    text: 'my sentinel answer',
    kind: 'text',
  });
});

test('planTextStep: chat directive → Down to the "Chat about this" row then Enter', () => {
  const plan = planTextStep(FREETEXT_PICKER, { kind: 'chat', text: 'lets discuss' });
  assert.deepEqual(plan, {
    navKeys: ['Down', 'Down', 'Down', 'Down', 'Enter'], // cursor@0 → chat@4
    text: 'lets discuss',
    kind: 'chat',
  });
});

test('planTextStep: cursor already on the type-something row → just Enter (no nav)', () => {
  const parsed = {
    rows: [
      { kind: 'option', label: 'Apple', checked: false, cursor: false },
      { kind: 'type-something', label: 'Type something', cursor: true },
      { kind: 'chat', label: 'Chat about this', cursor: false },
    ],
    actionLabel: null,
    isReview: false,
    confidence: 'ok',
  };
  assert.deepEqual(planTextStep(parsed, { kind: 'text', text: 'x' }).navKeys, ['Enter']);
});

test('planTextStep: cursor BELOW the target row → Up navigation', () => {
  const parsed = {
    rows: [
      { kind: 'type-something', label: 'Type something', cursor: false },
      { kind: 'option', label: 'Apple', checked: false, cursor: false },
      { kind: 'chat', label: 'Chat about this', cursor: true },
    ],
    actionLabel: null,
    isReview: false,
    confidence: 'ok',
  };
  // cursor@2 (chat) → type-something@0 → Up, Up, Enter.
  assert.deepEqual(planTextStep(parsed, { kind: 'text', text: 'x' }).navKeys, ['Up', 'Up', 'Enter']);
});

// REGRESSION (the P0): a free-text directive must NEVER resolve to an option row.
// planTextStep targets ONLY kind:'type-something'/'chat' rows; if none exists it
// returns null (→ server fails loud) rather than falling onto an option.
test('planTextStep: returns null when no matching free-text row exists (never targets an option)', () => {
  const optionsOnly = {
    rows: [
      { kind: 'option', label: 'Apple', checked: false, cursor: true },
      { kind: 'option', label: 'Banana', checked: false, cursor: false },
      { kind: 'action', label: 'Submit', cursor: false },
    ],
    actionLabel: 'Submit',
    isReview: false,
    confidence: 'ok',
  };
  assert.equal(planTextStep(optionsOnly, { kind: 'text', text: 'x' }), null);
  // Sanity: the chat row DOES exist in FREETEXT_PICKER, so a chat directive plans.
  assert.ok(planTextStep(FREETEXT_PICKER, { kind: 'chat', text: 'x' }));
  // chat directive with no chat row present → null too.
  const noChat = { ...FREETEXT_PICKER, rows: FREETEXT_PICKER.rows.filter((r) => r.kind !== 'chat') };
  assert.equal(planTextStep(noChat, { kind: 'chat', text: 'x' }), null);
});

test('planTextStep: null on empty text / review screen / low confidence / bad directive', () => {
  assert.equal(planTextStep(FREETEXT_PICKER, { kind: 'text', text: '' }), null);
  assert.ok(planTextStep(FREETEXT_PICKER, { kind: 'text', text: '   ' })); // whitespace is non-empty text; caller trims client-side
  assert.equal(planTextStep({ ...FREETEXT_PICKER, isReview: true }, { kind: 'text', text: 'x' }), null);
  assert.equal(planTextStep({ ...FREETEXT_PICKER, confidence: 'low' }, { kind: 'text', text: 'x' }), null);
  assert.equal(planTextStep(FREETEXT_PICKER, ['Apple']), null); // an option array is not a directive
  assert.equal(planTextStep(FREETEXT_PICKER, { kind: 'option', text: 'x' }), null);
  assert.equal(planTextStep(null, { kind: 'text', text: 'x' }), null);
});

// ── parsePicker recognizes the free-text rows, and planTextStep drives to them ──
test('parsePicker + planTextStep: a live-style capture routes text to the "Type something" row', () => {
  const capture = [
    '? Pick a fruit',
    '❯ 1. Apple',
    '  2. Banana',
    '  Type something',
    '  Submit',
    '  Chat about this',
    '  Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');
  const parsed = parsePicker(capture);
  assert.equal(parsed.confidence, 'ok');
  assert.ok(parsed.rows.some((r) => r.kind === 'type-something'), 'type-something row parsed');
  assert.ok(parsed.rows.some((r) => r.kind === 'chat'), 'chat row parsed');

  const plan = planTextStep(parsed, { kind: 'text', text: 'SENTINEL-42' });
  assert.ok(plan, 'plan produced');
  // Derive expected nav from the actual parsed layout so the test is robust to
  // row-ordering details but still proves we land on the NON-option free-text row.
  const tsIdx = parsed.rows.findIndex((r) => r.kind === 'type-something');
  const curIdx = parsed.rows.findIndex((r) => r.cursor);
  assert.deepEqual(plan.navKeys, [...Array(Math.max(0, tsIdx - curIdx)).fill('Down'), 'Enter']);
  assert.equal(plan.text, 'SENTINEL-42');
  // The row we navigate to must NOT be an option row (the P0 was landing on option 0).
  assert.notEqual(parsed.rows[tsIdx].kind, 'option');
});

// REGRESSION (found by live E2E): the real claude AskUserQuestion picker renders the
// free-text rows NUMBERED and with a trailing period — "3. Type something." — plus a
// dimmed duplicate description under each option and a tab-bar line. Before the fix,
// parsePicker's exact `/^Type something$/i` match failed on the trailing period, so
// "Type something." was mis-classified as a generic option → planTextStep found no
// free-text row → the typed text could never be delivered. This fixture is captured
// verbatim from a live render and locks the tolerant match.
test('parsePicker: live-render numbered "3. Type something." (trailing period) classifies as type-something', () => {
  const capture = [
    '←  ☐ Fruit  ☐ Color  ✔ Submit  →',
    '',
    'Pick a fruit?',
    '',
    '❯ 1. Apple',
    '     Apple',
    '  2. Banana',
    '     Banana',
    '  3. Type something.',
    '  4. Chat about this',
    '',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ].join('\n');
  const parsed = parsePicker(capture);
  assert.equal(parsed.confidence, 'ok');
  const kinds = parsed.rows.map((r) => r.kind);
  assert.deepEqual(kinds, ['option', 'option', 'type-something', 'chat']);
  // Labels are normalized to canonical (trailing period dropped).
  const ts = parsed.rows.find((r) => r.kind === 'type-something');
  assert.equal(ts.label, 'Type something');
  // And the planner drives text/chat to the correct non-option rows.
  assert.deepEqual(planTextStep(parsed, { kind: 'text', text: 'hi' }).navKeys, ['Down', 'Down', 'Enter']);
  assert.deepEqual(planTextStep(parsed, { kind: 'chat', text: 'hi' }).navKeys, ['Down', 'Down', 'Down', 'Enter']);
});
