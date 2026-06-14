// Translate an AskUserQuestion selection into Claude Code TUI picker keystrokes.
//
// Verified against the live Claude Code picker (a multi-question tabbed UI):
//   - Options are NUMBERED (1..N) in question.options order, with extra meta
//     options ("Type something", "Chat about this") appended after.
//   - SINGLE-select: pressing the option's number selects it AND auto-advances
//     to the next question tab.
//   - MULTI-select: pressing a number TOGGLES that option (cursor stays); press
//     Right (→) to advance to the next tab.
//   - After the last question the picker lands on the "Submit" tab showing
//     "1. Submit answers / 2. Cancel"; pressing "1" commits all answers.
// Keys are sent one at a time with a small delay (see tmux.sendRawKeysSequenced)
// so the single-select auto-advance re-render completes before the next key.

const MAX_NUMBERED = 9; // number-key selection only works for options 1..9

function numberKey(optionIndex) {
  const n = optionIndex + 1;
  if (n > MAX_NUMBERED) {
    throw new Error(`option #${n} beyond number-key range (1..${MAX_NUMBERED})`);
  }
  return String(n);
}

/**
 * Keys to answer ONE question (not including the final Submit).
 * @param {{multiSelect?: boolean, options: {label:string}[]}} question
 * @param {string[]} selectedLabels
 * @returns {string[]}
 */
export function buildAnswerKeys(question, selectedLabels) {
  const options = Array.isArray(question?.options) ? question.options : [];
  const indices = (selectedLabels || [])
    .map((label) => options.findIndex((o) => o.label === label))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);

  if (indices.length === 0) throw new Error('no valid option selected for question');

  if (!question.multiSelect) {
    // Selecting a numbered option auto-advances to the next tab.
    return [numberKey(indices[0])];
  }
  // Toggle each chosen option, then advance to the next tab with Right.
  return [...indices.map(numberKey), 'Right'];
}

/**
 * Full key program for a (possibly multi-question) AskUserQuestion, ending with
 * the Submit-tab confirmation.
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
  program.push('1'); // "Submit answers" on the Submit tab
  return program;
}
