/**
 * Pure guard: returns true when a normal composer send must be blocked because
 * an AskUserQuestion picker is open in the terminal. Sending raw text while a
 * picker is visible would let Enter select an option instead of typing a reply.
 *
 * Two independent signals cover the same condition:
 *  - `structuredPending` — the full Pending object from the subscribed tailer
 *    (present when the active session has a live WS subscription)
 *  - `sessionPending` — the boolean flag carried on every Session object, derived
 *    from push notifications (present even for sessions without a live tailer)
 *
 * Either signal being truthy is sufficient to block the send.
 */
export function hasOpenQuestion(
  structuredPending: unknown | null,
  sessionPending: boolean | undefined,
): boolean {
  return !!structuredPending || !!sessionPending;
}
