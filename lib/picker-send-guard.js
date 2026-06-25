/**
 * picker-send-guard.js — pure predicate for the send-time synchronous picker guard.
 *
 * Extracted so it can be unit-tested without importing server.js (which starts
 * a server on load). The integration glue (capture + the kind-appropriate parser:
 * parsePanePrompt for claude, parseCodexPrompt for codex) lives in server.js; this
 * file owns only the parser-agnostic decision logic on the parsed result.
 */

/**
 * Returns true when a free-text `reply` should be REFUSED because a picker is
 * open in the pane.
 *
 * @param {{ viaAnswer: boolean|undefined, kind: string, transport: string, parsedPicker: object|null }} opts
 * @returns {boolean}
 */
export function shouldRefuseSendForPicker({ viaAnswer, kind, transport, parsedPicker }) {
  // viaAnswer replies are the trailing keystroke AFTER the answer component has
  // already navigated the picker — they ARE the answer, so they must pass through.
  if (viaAnswer) return false;

  // Only keystroke-TUI panes have a tmux picker to guard. Claude (AskUserQuestion
  // + pane-scrape menus, via parsePanePrompt) and Codex (exec/patch/trust approvals
  // + numbered questions, via parseCodexPrompt) both qualify. The caller picks the
  // parser by kind and passes its result as parsedPicker; this predicate only reads
  // the boolean presence, so one decision path covers both kinds.
  if (kind !== 'claude' && kind !== 'codex') return false;

  // claude-print transport is not a keystroke TUI — no tmux picker to guard.
  // (Codex panes never use the 'print' transport, so this is a Claude-only carve-out.)
  if (transport === 'print') return false;

  // ANY picker present (question, numbered menu, trust/plan/permission scrape) → refuse.
  return Boolean(parsedPicker);
}
