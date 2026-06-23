// lib/prompt.js — detect a Claude Code TUI selection prompt from a pane capture.
//
// Permission prompts ("Do you want to proceed?  1. Yes / 2. Yes, don't ask /
// 3. No"), trust prompts, and similar numbered menus live ONLY in the live TUI —
// they are never written to the transcript JSONL. The cockpit is transcript-
// driven, so without this it shows a pending tool-call and looks stuck. We poll
// the pane, parse the prompt here, and surface it as an actionable modal.

// Strip ANSI/OSC escape sequences (capture-pane is taken with -e).
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][AB0]/g;

function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

// A numbered option line, optionally preceded by the TUI cursor (❯/›).
// `\d+` (not `\d`) so pickers with ≥10 rows parse their two-digit numbers.
const OPTION_RE = /^\s*([❯›]?)\s*(\d+)[.)]\s+(.+?)\s*$/;
// A checkbox marker at the START of an option label, e.g. "[ ] Label" or "[x] Label".
// Matches the bracket content: space = unchecked; x/✓/✗ = checked.
const CHECKBOX_RE = /^\[([✓x✗ ])\]\s*(.*)/;
// The footer real Claude Code prompts render under the options.
const ESC_HINT_RE = /\besc\b[^\n]*(cancel|interrupt|exit|reject|keep|quit)|ctrl\+[a-z]\b/i;
// How many lines from the bottom to consider. The active prompt always renders
// at the bottom of the pane; the cursor/Esc-footer guard (not this window) is
// what rejects assistant prose, so this can be generous. It must be large
// enough to contain a tall AskUserQuestion (long question + 5 options each with
// a multi-line description + footer) — otherwise the question + first options
// scroll out and the header heuristic grabs an option-description fragment.
const BOTTOM_REGION = 80;
const MAX_LABEL = 80;

/**
 * Parse a Claude Code numbered selection prompt out of a pane capture.
 *
 * Strict by design: an interactive prompt is accepted ONLY when the numbered
 * block carries a real TUI signal — the ❯ cursor on an option, or an "Esc to
 * cancel / ctrl+… " footer right below it. This rejects the common false
 * positive where the assistant writes a numbered plan/list in its prose (no
 * cursor, no Esc footer), which must NOT pop an approval modal.
 *
 * @param {string} capture  raw `capture-pane -p -e` text
 * @returns {{ question: string, options: {key:string,label:string,selected:boolean}[] }|null}
 */
export function parsePanePrompt(capture) {
  const all = stripAnsi(capture).split('\n').map((l) => l.replace(/\s+$/, ''));
  const offset = Math.max(0, all.length - BOTTOM_REGION);
  const lines = all.slice(offset);

  // Collect every numbered-option line in the bottom region. The AskUserQuestion
  // picker renders each option as a header line PLUS a wrapped description line,
  // so options are NOT contiguous — we must look past the description lines and
  // stitch together a 1,2,3… sequence by key, not by adjacency.
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    const m = OPTION_RE.exec(lines[i]);
    if (!m) continue;
    let label = m[3].trim();
    // Detect and strip a checkbox marker from the label.
    let checked = undefined;
    const cbMatch = CHECKBOX_RE.exec(label);
    if (cbMatch) {
      checked = cbMatch[1] !== ' '; // space = unchecked; x/✓/✗ = checked
      label = cbMatch[2].trim();
    }
    if (label.length > MAX_LABEL) label = label.slice(0, MAX_LABEL - 1) + '…';
    matches.push({ line: i, key: m[2], label, cursor: m[1] === '❯' || m[1] === '›', checked });
  }
  if (matches.length < 2) return null;

  // Group into runs of consecutive ascending keys (1,2,3… OR 3,4,5… — the menu's
  // first options can scroll off the top of the capture, so we must NOT require
  // it to start at 1). Description lines between options don't break a run since
  // we key off the NUMBERS, not line adjacency. Pick the bottom-most run — the
  // active picker always renders at the bottom of the pane.
  const runs = [];
  let cur = [];
  for (const m of matches) {
    const prevKey = cur.length ? Number(cur[cur.length - 1].key) : null;
    if (prevKey !== null && Number(m.key) === prevKey + 1) {
      cur.push(m);
    } else if (prevKey !== null && Number(m.key) === prevKey) {
      // duplicate key (re-render artifact) — ignore
    } else {
      if (cur.length) runs.push(cur);
      cur = [m];
    }
  }
  if (cur.length) runs.push(cur);
  const options = [...runs].reverse().find((r) => r.length >= 2);
  // Need ≥2 consecutively-numbered options to look like a menu.
  if (!options) return null;

  const firstLine = options[0].line;
  const lastLine = options[options.length - 1].line;
  const hasCursor = options.some((o) => o.cursor);

  // "Esc to cancel / ctrl+e" footer within a few lines below the last option.
  let hasEsc = false;
  for (let i = lastLine + 1; i <= Math.min(lines.length - 1, lastLine + 3); i++) {
    if (ESC_HINT_RE.test(lines[i])) {
      hasEsc = true;
      break;
    }
  }

  // Require a genuine interactive-prompt signal — not just numbered prose.
  if (!hasCursor && !hasEsc) return null;

  // Question = the contiguous block above the option run. Only trust it when the
  // run starts at key 1 — i.e. the WHOLE picker is in view. If it starts higher
  // (1/2 scrolled off despite the large window), the lines above the first
  // visible option are a prior option's wrapped DESCRIPTION, not the question, so
  // we emit no header rather than a misleading fragment.
  let question = null;
  if (Number(options[0].key) === 1) {
    let i = firstLine - 1;
    while (i >= 0 && !lines[i].trim()) i--; // skip the blank separator(s)
    const qLines = [];
    for (; i >= 0; i--) {
      const t = lines[i].trim();
      if (!t) break; // stop at the blank above the question block
      if (OPTION_RE.test(lines[i])) break; // don't bleed into a prior option
      qLines.unshift(t);
    }
    question = qLines.join(' ').slice(0, 400) || null;
  }

  const hasCheckboxes = options.some((o) => o.checked !== undefined);
  return {
    question: question || 'Make a selection',
    ...(hasCheckboxes ? { multiSelect: true } : {}),
    options: options.map((o) => ({
      key: o.key,
      label: o.label,
      selected: o.cursor,
      ...(o.checked !== undefined ? { checked: o.checked } : {}),
    })),
  };
}
