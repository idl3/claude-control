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
  // Track each record's physical line in record order so we can group into runs.
  /** @type {{li:number, opt:object}[]} */
  const optRecLines = [];
  {
    let searchFrom = 0;
    for (const opt of optionRecords) {
      for (let li = searchFrom; li < strippedLines.length; li++) {
        // Mirror the OPTION_START_RE detection used by reconstructOptionLines.
        if (/^\s*[❯›]?\s*\d+(?:[.)]\s*|\s+)/.test(strippedLines[li])) {
          consumedLines.add(li);
          optLineMap.set(li, opt);
          optRecLines.push({ li, opt });
          searchFrom = li + 1;
          break;
        }
      }
    }
  }

  // Step 2b: keep ONLY the bottom-most run of consecutively-numbered options
  // (1,2,3… or 3,4,5… — leading options may scroll off). This mirrors the
  // run-selection guard in detectPanePicker/parsePanePrompt (lib/prompt.js): an
  // agent that writes a numbered list ("1. …\n2. …") in its REASONING above the
  // picker would otherwise have those prose lines mis-parsed as option rows,
  // poisoning the navigable-row order and the Down-count math so Enter never
  // lands on Submit. The real picker is always the bottom-most numbered run.
  // We require ≥2 in the run (every real picker has ≥3 numbered rows: options +
  // "Type something" + "Chat about this"), matching detectPanePicker's bar.
  {
    const num = (o) => Number(o.key);
    /** @type {{li:number, opt:object}[][]} */
    const runs = [];
    let cur = [];
    for (const rec of optRecLines) {
      const prevKey = cur.length ? num(cur[cur.length - 1].opt) : null;
      if (prevKey !== null && num(rec.opt) === prevKey + 1) {
        cur.push(rec);
      } else if (prevKey !== null && num(rec.opt) === prevKey) {
        // duplicate key (re-render artifact) — ignore
      } else {
        if (cur.length) runs.push(cur);
        cur = [rec];
      }
    }
    if (cur.length) runs.push(cur);
    const chosen = [...runs].reverse().find((r) => r.length >= 2);
    if (chosen) {
      const keepLines = new Set(chosen.map((r) => r.li));
      // Drop any option record (and its consumed line) NOT in the chosen run so
      // prose-list lines above the real picker are excluded entirely.
      for (const li of [...optLineMap.keys()]) {
        if (!keepLines.has(li)) {
          optLineMap.delete(li);
          consumedLines.delete(li);
        }
      }
    }
  }
  // First physical line of the surviving option block — special non-numbered
  // rows (Submit/Next/bare Type-something/Chat) are only trusted at/below it.
  const runStartLine = optLineMap.size ? Math.min(...optLineMap.keys()) : 0;

  // Collect {lineIdx, row} entries from both passes, then sort by lineIdx at the end.
  /** @type {{li:number, row:PickerRow}[]} */
  const collected = [];

  // Step 3a: emit option records with their physical line positions.
  //
  // The two always-appended free-text rows render NUMBERED in the live picker
  // (e.g. "3. Type something." / "4. Chat about this") and Claude Code sometimes
  // appends a trailing period ("Type something."). reconstructOptionLines strips
  // the "N." prefix, leaving a label like "Type something." — so the match must be
  // tolerant of a trailing period / whitespace, else the free-text row is
  // mis-classified as a generic option and no free-text answer can target it.
  // (Verified against a live claude AskUserQuestion render.)
  for (const [li, opt] of optLineMap) {
    if (/^type something[.\s]*$/i.test(opt.label)) {
      collected.push({ li, row: { kind: 'type-something', label: 'Type something', cursor: opt.cursor } });
    } else if (/^chat about this[.\s]*$/i.test(opt.label)) {
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

    // Only trust special non-numbered rows (Next/Submit/bare Type-something/Chat)
    // at or below the surviving option block — never in the agent's reasoning prose
    // above the real picker.
    if (li < runStartLine) continue;

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
 * True when a per-question selection is a free-text/chat directive rather than a
 * list of chosen option labels. The wire shape for `selections[i]` is either:
 *   - `string[]`                       → chosen option labels (the option path), or
 *   - `{ kind:'text'|'chat', text }`   → type the literal `text` into the picker's
 *                                        "Type something" / "Chat about this" row.
 * Kept pure + exported so the server driver and tests share ONE discriminator and
 * an option-array can NEVER be mistaken for a directive (or vice-versa).
 *
 * @param {unknown} sel
 * @returns {boolean}
 */
export function isTextDirective(sel) {
  return (
    Boolean(sel) &&
    !Array.isArray(sel) &&
    typeof sel === 'object' &&
    (sel.kind === 'text' || sel.kind === 'chat') &&
    typeof sel.text === 'string'
  );
}

/**
 * Given a parsed picker for ONE question and a free-text/chat directive, compute
 * the plan to deliver typed text: navigate the cursor to the "Type something"
 * (kind:'text') or "Chat about this" (kind:'chat') row and press Enter to ACTIVATE
 * it (which opens the inline text input). The literal text itself is NOT a
 * keystroke sequence — the driver types it via tmux.sendText (bracketed paste +
 * Enter) once the input is open, so `text` is returned separately.
 *
 * Returns null when confidence is insufficient (no matching row, empty text, review
 * screen, low confidence) — the caller MUST fail loud on null and NEVER fall back
 * to selecting an option. This is the load-bearing invariant: a free-text answer
 * that can't be typed with confidence must not silently become an option pick.
 *
 * Deliberately does NOT reuse the option Down/Space/Enter path: a directive targets
 * the non-'option' rows (type-something / chat), which labelMatches never resolves.
 *
 * @param {ParsedPicker} parsed
 * @param {{ kind:'text'|'chat', text:string }} directive
 * @returns {{ navKeys: string[], text: string, kind:'text'|'chat' }|null}
 */
export function planTextStep(parsed, directive) {
  if (!parsed || parsed.confidence !== 'ok' || parsed.isReview) return null;
  if (!isTextDirective(directive)) return null;
  const text = directive.text;
  if (!text) return null; // empty text → nothing to type; fail loud upstream

  const navRows = parsed.rows;
  if (navRows.length === 0) return null;

  // Target the free-text row that matches the directive kind. These are parsed as
  // kind:'type-something' (Type something) and kind:'chat' (Chat about this) — never
  // kind:'option', so this can only ever land on a real free-text row.
  const targetKind = directive.kind === 'chat' ? 'chat' : 'type-something';
  const targetIdx = navRows.findIndex((r) => r.kind === targetKind);
  if (targetIdx < 0) return null;

  const cursorIdx = navRows.findIndex((r) => r.cursor);
  const fromIdx = cursorIdx >= 0 ? cursorIdx : 0;

  const navKeys = [];
  const delta = targetIdx - fromIdx;
  if (delta > 0) {
    for (let i = 0; i < delta; i += 1) navKeys.push('Down');
  } else if (delta < 0) {
    for (let i = 0; i < -delta; i += 1) navKeys.push('Up');
  }
  // Enter ACTIVATES the highlighted free-text row → opens its inline input. The
  // driver then types `text` into that input and submits (via sendText's Enter).
  navKeys.push('Enter');

  return { navKeys, text, kind: directive.kind };
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

/**
 * Decide the single action needed to CONFIRM a picker actually submitted, given a
 * freshly parsed pane. Drives the answer driver's post-answer confirm loop, whose
 * job is to guarantee the picker is gone (not parked on "Submit") before reporting
 * success.
 *
 *   'done'  — no picker / review left → submission is confirmed.
 *   'enter' — a review screen ("Ready to submit your answers? › Submit answers")
 *             is up, OR the picker is parked with the cursor on its action row
 *             (Submit/Next) because the previous Enter was dropped → one Enter
 *             advances/submits.
 *   'wait'  — a picker is still up but not in an Enter-able state (mid-render, or
 *             transitioning to the review screen) → wait and re-capture; pressing
 *             Enter now could toggle an option instead of advancing.
 *
 * @param {ParsedPicker} parsed
 * @returns {'done'|'enter'|'wait'}
 */
export function nextSubmitAction(parsed) {
  if (!parsed || parsed.confidence !== 'ok') return 'done';
  if (parsed.isReview) return 'enter';
  const cursorRow = parsed.rows.find((r) => r.cursor);
  if (cursorRow && cursorRow.kind === 'action') return 'enter';
  return 'wait';
}

/**
 * Confirm a (multi-question / multi-select / free-text) picker actually SUBMITTED —
 * i.e. it is provably GONE from the pane — nudging the review screen's "Submit
 * answers" with Enter as needed, and failing (returns false) only after a genuinely
 * exhausted budget. Extracted from the server answer driver so the exact confirm
 * logic is unit-testable with fixtures AND reusable by the live E2E harness.
 *
 * ── Why the injected `capture` MUST read the VISIBLE pane only (no scrollback) ──
 * When a picker submits, Claude Code's TUI commits the closing
 * "Review your answers … Ready to submit your answers? › Submit answers" frame to
 * pane history. A capture that includes scrollback (tmux `-S -N`) re-parses that
 * GHOST as a live review screen — so the loop believes the picker is still up, keeps
 * firing Enter (now into the composer), never sees the picker gone, exhausts the
 * budget, and fails loud EVEN THOUGH the submit already landed. That is the exact
 * intermittent P1 (it depends on whether the streaming response has scrolled the
 * ghost past the capture window yet — worse under load). Capturing ONLY the visible
 * screen makes "picker gone" a TRUE signal. (lib/tmux.js capturePane documents this
 * same scrollback-ghost hazard for prompt detection; the confirm loop had missed it.)
 *
 * ── Transition-blank guard (never a false "submitted") ──
 * A single "no picker" visible capture can also be a mid-transition blank frame (the
 * question erased, the review screen not yet drawn). Treating that as done would
 * strand the review screen unsubmitted. So a 'done' reading is accepted only once we
 * have EITHER already pressed the review/parked Submit Enter (`enteredSubmit` — after
 * which a blank means the picker is closing, since a DROPPED Enter leaves the review
 * screen stably rendered, not blank), OR observed picker-gone on two CONSECUTIVE
 * captures.
 *
 * Never blind-Enters an option row ('wait'), and on the review screen ensures the
 * cursor is on "Submit answers" (steps Up off "Cancel") before Enter — so this can
 * never mis-submit as Cancel. Preserves the "never mis-answer / never fall back"
 * invariants of the answer driver.
 *
 * @param {{
 *   capture:   () => Promise<string>,        // MUST capture VISIBLE-ONLY (no scrollback)
 *   sendEnter: () => Promise<void>,          // send one Enter to the pane
 *   sendUp?:   () => Promise<void>,          // step cursor up (review Cancel→Submit safety)
 *   delay:     (ms: number) => Promise<void>,
 *   tries?: number,        // max iterations before failing loud (default 12)
 *   settleMs?: number,     // wait between re-captures (default 300)
 *   postEnterMs?: number,  // wait after an Enter for the submit to land (default 450)
 *   log?: (msg: string) => void,
 * }} io
 * @returns {Promise<boolean>} true when the picker is confirmed gone; false if the
 *   budget was exhausted with a picker still up (caller MUST fail loud).
 */
export async function confirmSubmit({
  capture,
  sendEnter,
  sendUp,
  delay,
  tries = 12,
  settleMs = 300,
  postEnterMs = 450,
  log = () => {},
}) {
  let enteredSubmit = false;
  let goneStreak = 0;

  for (let t = 0; t < tries; t += 1) {
    let cap;
    try {
      cap = await capture();
    } catch (err) {
      log(`confirm-submit capture failed at try ${t}: ${err?.message}`);
      return false; // can't confirm → fail loud upstream
    }

    const parsed = parsePicker(cap);
    const action = nextSubmitAction(parsed);

    if (action === 'done') {
      // No picker on the VISIBLE screen. Accept as submitted only when it's provably
      // gone, not a mid-transition blank (see the transition-blank guard above).
      if (enteredSubmit) {
        log(`confirm-submit: picker gone after Submit Enter (try ${t}) — confirmed`);
        return true;
      }
      goneStreak += 1;
      if (goneStreak >= 2) {
        log(`confirm-submit: picker gone on 2 consecutive captures (try ${t}) — confirmed`);
        return true;
      }
      await delay(settleMs);
      continue;
    }

    goneStreak = 0;

    if (action === 'enter') {
      // A review screen or a parked action row is LIVE on the visible pane. On the
      // review screen, guarantee the cursor is on "Submit answers" before Enter so we
      // can never activate "Cancel" (default is Submit; this is defensive).
      if (parsed.isReview && sendUp) {
        const cancelHasCursor = parsed.rows.some((r) => r.kind === 'review-cancel' && r.cursor);
        if (cancelHasCursor) {
          log(`confirm-submit: review cursor on Cancel — stepping Up to Submit`);
          await sendUp();
          await delay(settleMs);
        }
      }
      log(`confirm-submit (try ${t}): ${parsed.isReview ? 'review screen' : 'parked action row'} — sending Enter`);
      await sendEnter();
      enteredSubmit = true;
      await delay(postEnterMs); // let the submit land + the picker close before re-capture
      continue;
    }

    // action === 'wait' — a live picker is mid-render / transitioning to the review
    // screen. Do NOT Enter (it could toggle an option). Settle and re-capture.
    await delay(settleMs);
  }

  return false;
}
