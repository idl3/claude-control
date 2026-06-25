/**
 * picker-send-guard.js — pure predicate for the send-time synchronous picker guard.
 *
 * Extracted so it can be unit-tested without importing server.js (which starts
 * a server on load). The integration glue (capture + parsePanePrompt call) lives
 * in server.js; this file owns only the decision logic.
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

  // Codex and codex-rpc panes use parseCodexPrompt semantics, not parsePanePrompt.
  // The AskUserQuestion picker guard is a Claude TUI concern only.
  if (kind !== 'claude') return false;

  // claude-print transport is not a keystroke TUI — no tmux picker to guard.
  if (transport === 'print') return false;

  // ANY picker present (question, numbered menu, trust/plan/permission scrape) → refuse.
  return Boolean(parsedPicker);
}
