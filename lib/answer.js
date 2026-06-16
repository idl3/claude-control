// Translate an AskUserQuestion selection into Claude Code TUI picker keystrokes.
//
// Key model — matches the live picker footer and the CONTRACT.md spec:
//   footer: "Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch
//            questions · Esc to cancel"
//   spec:   single-select = ['Down'*index, 'Enter'];
//           multi-select  = Space-toggle each chosen index, then Down to the
//                           per-question action row ("Next"/"Submit") + Enter.
//
//   - Each question lists its options vertically; a cursor starts on the FIRST
//     option (index 0) and moves with Up/Down. There are NO number shortcuts —
//     digits do not select, so the previous number-key model was a no-op against
//     this UI (the cause of "answer sent but nothing happened").
//   - SINGLE-select: navigate Down to the chosen option, then press Enter. Enter
//     commits the answer and advances to the next question (or submits on the last).
//   - MULTI-select: Space toggles a checkbox; Enter on a checkbox ONLY toggles it
//     (footer reads "Enter to select") and does NOT advance. So: Space-toggle each
//     chosen option, then navigate Down to the action row — "Next" (non-final) or
//     "Submit" (final) — at navigable index options.length + 1 (after the real
//     options and the always-present "Type something" free-text row), then Enter.
//     Enter on "Next" advances to the next question (cursor resets to 0); Enter on
//     "Submit" submits the whole picker. (Pressing Enter on the last toggled
//     option — the old model — left the second question unanswered + never
//     submitted: the exact reported bug.)
//
// We deliberately avoid the `n` (add notes) key: it opens a free-text input that
// would swallow every subsequent keystroke. Navigation is arrows + Space/Enter only.
//
// Keys are sent one at a time with a delay (see tmux.sendRawKeysSequenced) so the
// picker's re-render settles between keys and none are dropped.

/**
 * Resolve the selected labels to option indices, in top-to-bottom order.
 * @param {{options: {label:string}[]}} question
 * @param {string[]} selectedLabels
 * @returns {number[]} ascending option indices
 */
function selectedIndices(question, selectedLabels) {
  const options = Array.isArray(question?.options) ? question.options : [];
  const indices = (selectedLabels || [])
    .map((label) => options.findIndex((o) => o.label === label))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  if (indices.length === 0) throw new Error('no valid option selected for question');
  return indices;
}

/**
 * Keys to answer ONE question, including the trailing Enter that confirms it and
 * advances the picker (or submits, on the final question).
 *
 * Single-select: Down×index, Enter.
 * Multi-select:  for each chosen index (ascending) Down to it (relative to the
 *                current cursor) then Space to toggle; finally Enter to confirm.
 *
 * @param {{multiSelect?: boolean, options: {label:string}[]}} question
 * @param {string[]} selectedLabels
 * @returns {string[]}
 */
export function buildAnswerKeys(question, selectedLabels) {
  const indices = selectedIndices(question, selectedLabels);
  const keys = [];

  if (!question.multiSelect) {
    for (let i = 0; i < indices[0]; i += 1) keys.push('Down');
    keys.push('Enter');
    return keys;
  }

  // Multi-select: toggle each chosen option with Space (cursor starts at option
  // 0; move only the delta between successive targets). Then navigate DOWN to the
  // per-question action row — "Next" on a non-final question, "Submit" on the
  // final one — and press Enter to activate it.
  //
  // CRITICAL (verified empirically against the live picker): the footer is
  // "Enter to select", so Enter on a CHECKBOX only toggles it — it does NOT
  // advance/submit. The action row sits at navigable index options.length + 1:
  // the real options [0..N-1], then the always-present "Type something" free-text
  // row [N], then "Next"/"Submit" [N+1] (then "Chat about this" [N+2]). The OLD
  // model pressed Enter while still on the last option, so it never advanced —
  // the second question went unanswered and the picker never submitted.
  let cursor = 0;
  for (const target of indices) {
    for (let i = cursor; i < target; i += 1) keys.push('Down');
    keys.push('Space');
    cursor = target;
  }
  const actionRow = (question.options?.length ?? 0) + 1;
  for (let i = cursor; i < actionRow; i += 1) keys.push('Down');
  keys.push('Enter');
  return keys;
}

/**
 * Full key program for a (possibly multi-question) AskUserQuestion. Each question
 * ends with the Enter that confirms it and advances; the last question's Enter
 * submits the whole picker.
 *
 * @param {{questions: object[]}} pending
 * @param {string[][]} selections  selections[i] = chosen labels for questions[i]
 * @returns {string[]}
 */
export function buildAnswerProgram(pending, selections) {
  const questions = pending?.questions || [];
  if (questions.length === 0) throw new Error('pending has no questions');
  const program = [];
  for (let i = 0; i < questions.length; i += 1) {
    program.push(...buildAnswerKeys(questions[i], selections?.[i] || []));
  }
  // Multi-question pickers carry a final "Submit" tab: after the last question's
  // action-row Enter, the picker lands on a "Review your answers · Submit answers /
  // Cancel" screen with "Submit answers" highlighted. One more Enter confirms +
  // closes it. (Verified live: without this, every question was answered correctly
  // but the picker sat on the review screen, unsubmitted.) Single-question pickers
  // have no review step — the question's own Enter submits.
  if (questions.length > 1) program.push('Enter');
  return program;
}
