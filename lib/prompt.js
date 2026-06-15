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

const OPTION_RE = /^\s*[❯›>*]?\s*(\d)[.)]\s+(.+?)\s*$/;
const PROMPT_HINT_RE = /(do you want|want to proceed|proceed\?|trust|allow this|continue\?)/i;
const MAX_LABEL = 80;

/**
 * Parse a Claude Code numbered selection prompt out of a pane capture.
 *
 * @param {string} capture  raw `capture-pane -p -e` text
 * @returns {{ question: string, options: {key:string,label:string,selected:boolean}[] }|null}
 */
export function parsePanePrompt(capture) {
  const lines = stripAnsi(capture).split('\n').map((l) => l.replace(/\s+$/, ''));

  // Find the LAST contiguous run of numbered options (the active prompt is at the
  // bottom of the pane). Walk from the end.
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OPTION_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;

  // Expand upward over the contiguous numbered block.
  let start = end;
  while (start - 1 >= 0 && OPTION_RE.test(lines[start - 1])) start -= 1;

  const options = [];
  for (let i = start; i <= end; i++) {
    const m = OPTION_RE.exec(lines[i]);
    if (!m) continue;
    let label = m[2].trim();
    if (label.length > MAX_LABEL) label = label.slice(0, MAX_LABEL - 1) + '…';
    const selected = /^[\s]*[❯›>*]/.test(lines[i]);
    options.push({ key: m[1], label, selected });
  }
  // Need ≥2 options numbered consecutively from 1 to look like a real menu.
  if (options.length < 2) return null;
  if (options[0].key !== '1') return null;

  // Question = nearest non-empty line above the options block (e.g. "Do you want
  // to proceed?"). Require a prompt-like hint to avoid matching random lists.
  let question = '';
  for (let i = start - 1; i >= 0 && i >= start - 4; i--) {
    const t = lines[i].trim();
    if (t) {
      question = t;
      break;
    }
  }
  if (!PROMPT_HINT_RE.test(question) && !PROMPT_HINT_RE.test(lines.join(' '))) {
    return null;
  }

  return { question: question || 'Do you want to proceed?', options };
}
