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
const OPTION_RE = /^\s*([❯›]?)\s*(\d)[.)]\s+(.+?)\s*$/;
// The footer real Claude Code prompts render under the options.
const ESC_HINT_RE = /\besc\b[^\n]*(cancel|interrupt|exit|reject|keep|quit)|ctrl\+[a-z]\b/i;
// How many lines from the bottom to consider — the active prompt always renders
// at the bottom of the pane, so a numbered list higher up (assistant prose) is
// out of scope.
const BOTTOM_REGION = 18;
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

  // Last contiguous run of numbered options within the bottom region.
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OPTION_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;

  let start = end;
  while (start - 1 >= 0 && OPTION_RE.test(lines[start - 1])) start -= 1;

  const options = [];
  let hasCursor = false;
  for (let i = start; i <= end; i++) {
    const m = OPTION_RE.exec(lines[i]);
    if (!m) continue;
    const cursor = m[1] === '❯' || m[1] === '›';
    if (cursor) hasCursor = true;
    let label = m[3].trim();
    if (label.length > MAX_LABEL) label = label.slice(0, MAX_LABEL - 1) + '…';
    options.push({ key: m[2], label, selected: cursor });
  }
  // Need ≥2 options numbered consecutively from 1 to look like a menu.
  if (options.length < 2 || options[0].key !== '1') return null;

  // "Esc to cancel / ctrl+e" footer within a few lines below the block.
  let hasEsc = false;
  for (let i = end + 1; i <= Math.min(lines.length - 1, end + 3); i++) {
    if (ESC_HINT_RE.test(lines[i])) {
      hasEsc = true;
      break;
    }
  }

  // Require a genuine interactive-prompt signal — not just numbered prose.
  if (!hasCursor && !hasEsc) return null;

  // Question = nearest non-empty line above the options block.
  let question = '';
  for (let i = start - 1; i >= 0 && i >= start - 4; i--) {
    const t = lines[i].trim();
    if (t) {
      question = t;
      break;
    }
  }

  return { question: question || 'Make a selection', options };
}
