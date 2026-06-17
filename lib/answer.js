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

// ---------------------------------------------------------------------------
// Picker capture parser — capture-driven answerer
// ---------------------------------------------------------------------------
//
// Empirical picker model (reverse-engineered from live renders):
//
//   Navigable rows in order:
//     1. Each real option:  "N. [ ]Label" or "N. [x]Label" or "N. [✓]Label"
//        Below each option there may be DIMMED DESCRIPTION lines — these are
//        NOT navigable and Up/Down skip them.
//     2. "Type something"  — always present free-text row.
//     3. Action row        — literal "Next" (non-final) or "Submit" (final).
//     4. "Chat about this" — always present last row.
//
//   Cursor:   row is marked at line start with "›" or "❯" (possibly with
//             leading whitespace / ANSI stripped text before it).
//
//   Review screen (multi-question only, appears after final Submit):
//     "Review your answers … Ready to submit your answers?"
//     "› 1. Submit answers"
//     "2. Cancel"
//
// The parser strips ANSI escape sequences before analysis so it works on both
// plain and escape-laden captures.

/**
 * @typedef {{
 *   kind: 'option'|'type-something'|'action'|'chat'|'review-submit'|'review-cancel',
 *   label: string,
 *   checked?: boolean,
 *   cursor: boolean
 * }} PickerRow
 *
 * @typedef {{
 *   rows: PickerRow[],
 *   actionLabel: 'Next'|'Submit'|null,
 *   isReview: boolean,
 *   confidence: 'ok'|'low'
 * }} ParsedPicker
 */

// Strip ANSI escape sequences from a string.
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

// Detect cursor marker at the start of a (stripped, trimmed) line.
function hasCursor(line) {
  return /^[›❯]/.test(line.trim());
}

// Remove the cursor marker from a line and trim.
function removeCursor(line) {
  return line.trim().replace(/^[›❯]\s*/, '');
}

// Detect an option line: "N. [ ] Label" / "N. [x] Label" / "N. [✓] Label"
// Also handles "N. [✓]Label" without space after bracket.
const OPTION_RE = /^\d+\.\s+\[([✓x✗ ])\]\s*(.*)/;

/**
 * Parse the visible content of a tmux pane into a structured picker model.
 *
 * Returns a low-confidence result (confidence:'low', rows:[]) rather than
 * throwing when the capture doesn't look like a picker at all.
 *
 * @param {string} capture  Raw text from tmux capture-pane.
 * @returns {ParsedPicker}
 */
export function parsePicker(capture) {
  const EMPTY = { rows: [], actionLabel: null, isReview: false, confidence: 'low' };

  if (!capture || typeof capture !== 'string') return EMPTY;

  const raw = stripAnsi(capture);
  const lines = raw.split('\n');

  // Detect review screen first — it's structurally different.
  const hasReviewHeader = lines.some((l) => /Review your answers/i.test(l));
  const hasReadyLine = lines.some((l) => /Ready to submit your answers/i.test(l));

  if (hasReviewHeader && hasReadyLine) {
    // Parse the two review options.
    const rows = [];
    for (const rawLine of lines) {
      const stripped = stripAnsi(rawLine);
      const cursor = hasCursor(stripped);
      const line = removeCursor(stripped);
      if (/1\.\s+Submit answers/i.test(line)) {
        rows.push({ kind: 'review-submit', label: 'Submit answers', cursor });
      } else if (/2\.\s+Cancel/i.test(line)) {
        rows.push({ kind: 'review-cancel', label: 'Cancel', cursor });
      }
    }
    if (rows.length === 0) return EMPTY;
    return { rows, actionLabel: null, isReview: true, confidence: 'ok' };
  }

  // Normal question screen.
  // Strategy: scan lines, classify each as option / description / special.
  // Description lines follow an option and do NOT match the option pattern,
  // are not cursor-marked, and don't match any other special marker.

  /** @type {PickerRow[]} */
  const rows = [];
  /** @type {'Next'|'Submit'|null} */
  let actionLabel = null;

  // Track whether we've seen at least one option (to know if we're past options).
  let seenOption = false;
  // Track whether the most-recently-seen navigable row was an option, so the
  // next plain text line can be classified as a description.
  let lastNavWasOption = false;

  for (const rawLine of lines) {
    const stripped = stripAnsi(rawLine);
    const cursor = hasCursor(stripped);
    const line = removeCursor(stripped);
    const trimmed = line.trim();

    if (!trimmed) continue;

    // Option line: "N. [x] Label" — match first, then check if it's a special
    // known row (Type something, Chat about this) that happens to be numbered.
    const optMatch = trimmed.match(OPTION_RE);
    if (optMatch) {
      const checkChar = optMatch[1]; // ' ', 'x', '✓', '✗'
      const label = optMatch[2].trim();

      // "Type something" can appear as a numbered checkbox row.
      if (/^Type something$/i.test(label)) {
        rows.push({ kind: 'type-something', label: 'Type something', cursor });
        lastNavWasOption = false;
        continue;
      }

      // "Chat about this" can appear as a numbered checkbox row.
      if (/^Chat about this$/i.test(label)) {
        rows.push({ kind: 'chat', label: 'Chat about this', cursor });
        lastNavWasOption = false;
        continue;
      }

      const checked = checkChar !== ' ';
      rows.push({ kind: 'option', label, checked, cursor });
      seenOption = true;
      lastNavWasOption = true;
      continue;
    }

    // "Type something" row — the free-text row when not in option format.
    if (/^Type something/i.test(trimmed)) {
      rows.push({ kind: 'type-something', label: 'Type something', cursor });
      lastNavWasOption = false;
      continue;
    }

    // Action row — "Next" or "Submit" (bare word on its own line, appears AFTER
    // "Type something"). Must appear at start of line content (after cursor strip).
    if (/^Next$/i.test(trimmed)) {
      rows.push({ kind: 'action', label: 'Next', cursor });
      actionLabel = 'Next';
      lastNavWasOption = false;
      continue;
    }
    if (/^Submit$/i.test(trimmed)) {
      rows.push({ kind: 'action', label: 'Submit', cursor });
      actionLabel = 'Submit';
      lastNavWasOption = false;
      continue;
    }

    // "Chat about this" row — may appear bare or as a numbered line "N. Chat about this".
    {
      const bareLabel = trimmed.replace(/^\d+\.\s+/, '');
      if (/^Chat about this/i.test(bareLabel) || /^Chat about this/i.test(trimmed)) {
        rows.push({ kind: 'chat', label: 'Chat about this', cursor });
        lastNavWasOption = false;
        continue;
      }
    }

    // Footer line — skip (keyboard hint at the bottom).
    if (/Enter to select|↑.↓ to navigate|Esc to cancel/i.test(trimmed)) continue;

    // Tab-bar line (e.g. "←  ⊠ Fruits   □ Colors   ✔ Submit   →") — skip.
    if (/←.*→/.test(trimmed)) continue;

    // Question text / header — skip if we haven't seen any option yet.
    if (!seenOption) continue;

    // Otherwise: if the previous navigable row was an option, this is a
    // description line below it — skip (not navigable).
    if (lastNavWasOption) continue;

    // Anything else after options: skip (question text bleed, etc.).
  }

  // Need at least one option or "Type something" to call it a picker.
  if (rows.filter((r) => r.kind === 'option' || r.kind === 'type-something').length === 0) {
    return EMPTY;
  }

  return { rows, actionLabel, isReview: false, confidence: 'ok' };
}

/**
 * Given a parsed picker for ONE question and the desired selections, compute
 * the keystroke sequence to toggle the right options and press the action row.
 *
 * Returns null when confidence is insufficient (unknown option label, no action
 * row found, etc.) — caller must fall back to the static model.
 *
 * @param {ParsedPicker} parsed
 * @param {{ multiSelect?: boolean, options: {label:string}[] }} question
 * @param {string[]} selectedLabels
 * @returns {string[]|null}
 */
export function planStep(parsed, question, selectedLabels) {
  if (!parsed || parsed.confidence !== 'ok' || parsed.isReview) return null;

  const { rows, actionLabel } = parsed;

  // Navigable rows are everything EXCEPT descriptions (which we already excluded
  // in parsePicker). All rows in the list are navigable.
  const navRows = rows;

  if (navRows.length === 0) return null;

  if (!question.multiSelect) {
    // Single-select: find the target option by label, Down to it, Enter.
    if (!selectedLabels || selectedLabels.length === 0) return null;
    const targetLabel = selectedLabels[0];
    const targetIdx = navRows.findIndex(
      (r) => r.kind === 'option' && r.label === targetLabel,
    );
    if (targetIdx < 0) return null;

    // Cursor position from the parsed state.
    const cursorIdx = navRows.findIndex((r) => r.cursor);
    const fromIdx = cursorIdx >= 0 ? cursorIdx : 0;

    const keys = [];
    const delta = targetIdx - fromIdx;
    if (delta > 0) {
      for (let i = 0; i < delta; i += 1) keys.push('Down');
    } else if (delta < 0) {
      for (let i = 0; i < -delta; i += 1) keys.push('Up');
    }
    keys.push('Enter');
    return keys;
  }

  // Multi-select: for each label, verify it exists, then compute toggle plan.
  if (!selectedLabels || selectedLabels.length === 0) return null;

  // Resolve label → navigable index for all targets.
  const targetIndices = selectedLabels.map((label) =>
    navRows.findIndex((r) => r.kind === 'option' && r.label === label),
  );
  if (targetIndices.some((i) => i < 0)) return null; // unknown label — bail

  // Sort ascending for top-to-bottom navigation.
  targetIndices.sort((a, b) => a - b);

  // Find action row index.
  const actionIdx = navRows.findIndex((r) => r.kind === 'action');
  if (actionIdx < 0) return null; // no action row visible — bail

  const cursorIdx = navRows.findIndex((r) => r.cursor);
  let cursor = cursorIdx >= 0 ? cursorIdx : 0;

  const keys = [];

  for (const target of targetIndices) {
    // Navigate to the target option.
    const delta = target - cursor;
    if (delta > 0) {
      for (let i = 0; i < delta; i += 1) keys.push('Down');
    } else if (delta < 0) {
      for (let i = 0; i < -delta; i += 1) keys.push('Up');
    }
    // Toggle: only Space if the current checked state ≠ desired (checked).
    // The picker starts with all unchecked; we always want to check the targets.
    // If it's already checked (pre-ticked), Space would UN-check — skip it.
    const row = navRows[target];
    if (!row.checked) keys.push('Space');
    cursor = target;
  }

  // Navigate to the action row and Enter.
  const actionDelta = actionIdx - cursor;
  if (actionDelta > 0) {
    for (let i = 0; i < actionDelta; i += 1) keys.push('Down');
  } else if (actionDelta < 0) {
    for (let i = 0; i < -actionDelta; i += 1) keys.push('Up');
  }
  keys.push('Enter');

  return keys;
}

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
