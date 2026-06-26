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
 *   description?: string,
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

import { reconstructOptionLines } from './prompt.js';

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
  // Strategy:
  //   1. Use reconstructOptionLines (shared with detectPanePicker) to find and assemble
  //      option records from the stripped lines — handles hard-wrapped narrow-pane labels,
  //      no-space-after-dot formats ("3.Deep-verify"), checkbox parsing.
  //   2. Map each option record back to its physical line index (so we can sort everything
  //      by source line position at the end and emit rows in top-to-bottom order).
  //   3. Line-scan the same lines for special non-numbered rows (Type-something bare,
  //      Next, Submit, Chat bare) and for numbered special rows that reconstructOptionLines
  //      classified as options (type-something / chat in numbered format).
  //   4. Merge both sets of collected rows sorted by line position — final rows[] is ordered
  //      as they appear on screen regardless of which pass detected them.

  const strippedLines = lines.map((l) => stripAnsi(l).replace(/\s+$/, ''));

  // Step 1: collect option records.
  const optionRecords = reconstructOptionLines(strippedLines);

  /** @type {'Next'|'Submit'|null} */
  let actionLabel = null;

  // Step 2: map each option record to its physical line index (first-match scan).
  // Also build consumedLines so the second pass can skip lines already handled.
  /** @type {Map<number, object>} lineIdx → optionRecord */
  const optLineMap = new Map(); // physical line → option record
  const consumedLines = new Set(); // option-start line indices
  {
    let searchFrom = 0;
    for (const opt of optionRecords) {
      for (let li = searchFrom; li < strippedLines.length; li++) {
        // Mirror the OPTION_START_RE detection used by reconstructOptionLines.
        if (/^\s*[❯›]?\s*\d+(?:[.)]\s*|\s+)/.test(strippedLines[li])) {
          consumedLines.add(li);
          optLineMap.set(li, opt);
          searchFrom = li + 1;
          break;
        }
      }
    }
  }

  // Collect {lineIdx, row} entries from both passes, then sort by lineIdx at the end.
  /** @type {{li:number, row:PickerRow}[]} */
  const collected = [];

  // Step 3a: emit option records with their physical line positions.
  for (const [li, opt] of optLineMap) {
    if (/^Type something$/i.test(opt.label)) {
      collected.push({ li, row: { kind: 'type-something', label: 'Type something', cursor: opt.cursor } });
    } else if (/^Chat about this$/i.test(opt.label)) {
      collected.push({ li, row: { kind: 'chat', label: 'Chat about this', cursor: opt.cursor } });
    } else {
      collected.push({ li, row: { kind: 'option', label: opt.label, description: opt.description, checked: opt.checked, cursor: opt.cursor } });
    }
  }

  // Step 3b: scan lines for special non-numbered rows (Next, Submit, Type-something bare, Chat bare).
  // Skip lines already consumed by reconstructOptionLines (option starts).
  let seenOptionStart = optionRecords.length > 0;
  for (let li = 0; li < strippedLines.length; li++) {
    const rawLine = strippedLines[li];
    const cursor = hasCursor(rawLine);
    const line = removeCursor(rawLine);
    const trimmed = line.trim();

    if (!trimmed) continue;

    // Skip footer lines (keyboard hint).
    if (/Enter to select|↑.↓ to navigate|Esc to cancel/i.test(trimmed)) continue;

    // Skip tab-bar lines (e.g. "←  ⊠ Fruits   □ Colors   ✔ Submit   →").
    if (/←.*→/.test(trimmed)) continue;

    // Skip question text / header before any option.
    if (!seenOptionStart) continue;

    // Skip lines already handled as option-starts.
    if (consumedLines.has(li)) continue;

    const bareLabel = trimmed.replace(/^\d+\.\s+/, '');

    // "Type something" bare row (non-numbered).
    if (/^Type something/i.test(trimmed)) {
      collected.push({ li, row: { kind: 'type-something', label: 'Type something', cursor } });
      continue;
    }

    // Action rows — "Next" or "Submit".
    if (/^Next$/i.test(trimmed)) {
      collected.push({ li, row: { kind: 'action', label: 'Next', cursor } });
      actionLabel = 'Next';
      continue;
    }
    if (/^Submit$/i.test(trimmed)) {
      collected.push({ li, row: { kind: 'action', label: 'Submit', cursor } });
      actionLabel = 'Submit';
      continue;
    }

    // "Chat about this" bare or numbered (non-checkbox format).
    if (/^Chat about this/i.test(bareLabel) || /^Chat about this/i.test(trimmed)) {
      collected.push({ li, row: { kind: 'chat', label: 'Chat about this', cursor } });
      continue;
    }

    // Anything else (description lines, question text bleed) — skip.
  }

  // Step 4: sort collected entries by physical line index → final rows[] in screen order.
  collected.sort((a, b) => a.li - b.li);
  const rows = collected.map((c) => c.row);

  // Need at least one option or "Type something" to call it a picker.
  if (rows.filter((r) => r.kind === 'option' || r.kind === 'type-something').length === 0) {
    return EMPTY;
  }

  return { rows, actionLabel, isReview: false, confidence: 'ok' };
}

/**
 * Match a PickerRow's label against a target label string.
 *
 * Under the marker-based reconstruction rule, a title that word-wraps on an
 * ultra-narrow pane has its wrapped tail in `description` rather than `label`.
 * This helper reconstructs the full original title by joining label + description
 * so that an AskUserQuestion structured label (e.g. "Fresh Strawberry") still
 * matches the parsed row whose label is "Fresh" and description is "Strawberry".
 *
 * @param {PickerRow} row
 * @param {string} target
 * @returns {boolean}
 */
function labelMatches(row, target) {
  if (row.label === target) return true;
  const combined = (row.label + ' ' + (row.description || '')).replace(/\s+/g, ' ').trim();
  return combined === target;
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
      (r) => r.kind === 'option' && labelMatches(r, targetLabel),
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
    navRows.findIndex((r) => r.kind === 'option' && labelMatches(r, label)),
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
