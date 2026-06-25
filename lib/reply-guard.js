/**
 * lib/reply-guard.js — Pure predicate for the server-side reply safety guard.
 *
 * Extracted so it can be unit-tested without importing server.js (which starts
 * an HTTP server on import and carries heavyweight side effects).
 */

/**
 * Returns true when sending a raw reply (bracketed-paste + Enter via tmux) must
 * be blocked because an AskUserQuestion picker is currently open in the pane.
 *
 * Callers should pass BOTH available pending signals so neither source can be
 * individually defeated by a race or stale state:
 *  - tailerPending  — real-time pending object from TranscriptTailer.getPending()
 *                     (non-null when an open tool_use has no matching tool_result)
 *  - flagPending    — registry session.pending flag (set via setPending / _pollThinking)
 *
 * @param {object|null|undefined} tailerPending  TranscriptTailer.getPending() result
 * @param {boolean|null|undefined} flagPending   registry session.pending flag
 * @returns {boolean}
 */
export function replyShouldBlock(tailerPending, flagPending) {
  return Boolean(tailerPending) || Boolean(flagPending);
}
