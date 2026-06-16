// Translate an AskUserQuestion selection into Claude Code TUI picker keystrokes.
//
// Key model — matches the live picker footer and the CONTRACT.md spec:
//   footer: "Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch
//            questions · Esc to cancel"
//   spec:   single-select = ['Down'*index, 'Enter'];
//           multi-select  = navigate Down to each chosen index, press Space, then Enter.
//
//   - Each question lists its options vertically; a cursor starts on the FIRST
//     option (index 0) and moves with Up/Down. There are NO number shortcuts —
//     digits do not select, so the previous number-key model was a no-op against
//     this UI (the cause of "answer sent but nothing happened").
//   - SINGLE-select: navigate Down to the chosen option, then press Enter. Enter
//     commits the answer and advances to the next question (or submits on the last).
//   - MULTI-select: navigate Down to each chosen option (top-to-bottom, so a
//     monotonic run of Downs) pressing Space to toggle it, then press Enter to
//     confirm the question and advance/submit.
//   - There is no separate "Submit" step: the final question's Enter submits the
//     whole picker. (The old `Right`-to-Submit-tab + `'1'` model was stale.)
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

  // Multi-select: walk down through the chosen options in order, toggling each
  // with Space; the cursor starts at option 0, so move only the delta between
  // successive targets. A trailing Enter confirms the question.
  let cursor = 0;
  for (const target of indices) {
    for (let i = cursor; i < target; i += 1) keys.push('Down');
    keys.push('Space');
    cursor = target;
  }
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
  return program;
}
