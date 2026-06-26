/**
 * Pure suppression logic for the "answer settling" window: the period after a
 * user answers a scrape-prompt (TUI picker / plan / trust / numbered menu) and
 * before the pane's screen content confirms the picker has disappeared.
 *
 * PROBLEM: The fixed-1800ms timer in markAnswered() races the TUI ingest cycle.
 * The server re-scrapes every ~2000ms and re-broadcasts {type:'prompt'} while
 * the picker is still on screen (ingesting keystrokes). Once the 1800ms timer
 * elapses but the picker is still visible, activePrompt re-opens → question
 * flashes back to the user.
 *
 * FRAME-ORDERING RACE: {type:'picker', open:false} and {type:'prompt'} are
 * broadcast as SEPARATE WebSocket frames with no ordering guarantee. The picker
 * frame can clear (pickerOpen→false) one scrape cycle BEFORE the stale scrape
 * prompt frame clears. If suppression releases the moment pickerOpen is false,
 * the still-present cockpit.prompt re-opens the question → second flash.
 *
 * AUTHORITATIVE SIGNAL: server broadcasts {type:'picker', open:false} the
 * moment the TUI picker disappears (server.js:1831-1833), mapped to
 * cockpit.pickerOpen in useCockpit. This is the "picker is gone" ground truth,
 * but it must be combined with "prompt also gone" to fully close the window.
 *
 * INVARIANT: suppression holds while (answerSettling=true AND hasPrompt=true),
 * regardless of pickerOpen. answerSettling is cleared only when BOTH
 * pickerOpen=false AND the scrape prompt has cleared (hasPrompt=false), OR
 * when the safety cap elapses. This eliminates the frame-ordering flash window.
 *
 * DESIGN:
 * - When an answer is sent, set `answerSettling = true` and record a
 *   `settleDeadline` (safety cap so a never-clearing picker doesn't suppress
 *   forever). The cap must comfortably exceed one full scrape cycle (2000ms)
 *   plus keystroke ingest latency; 8000ms is conservative but safe.
 * - Suppress the scrape `kind:'prompt'` path while settling AND hasPrompt=true.
 *   pickerOpen alone does NOT release suppression for this path.
 * - Release via safety cap when settleDeadline passes (prevents permanent hide).
 * - Do NOT suppress a genuinely new structured `cockpit.pending` (that path
 *   comes from the tailer, not the scrape; it is already gated separately in
 *   activePrompt by being first in the priority chain).
 *
 * synthesized-ask path: fires only when !cockpit.prompt is already true
 * upstream, so there is no stale scrape prompt present. pickerOpen-based
 * release is safe for that path and is preserved in shouldShowSynthesizedAsk.
 */

export interface AnswerSettleState {
  /** True from the moment an answer is sent until the picker visually clears. */
  answerSettling: boolean;
  /**
   * Epoch-ms deadline after which settling is released unconditionally — the
   * safety cap. Set to Date.now() + SETTLE_CAP_MS on answer, 0 when idle.
   */
  settleDeadline: number;
}

/** Safety cap: 8s gives 3+ scrape cycles (3 × 2000ms) + ingest headroom. */
export const SETTLE_CAP_MS = 8_000;

export const IDLE_SETTLE: AnswerSettleState = {
  answerSettling: false,
  settleDeadline: 0,
};

/**
 * Pure predicate: should the scrape-prompt / synthesized-ask be shown to the
 * user right now?
 *
 * Returns `true` (show prompt) only when all suppression conditions are lifted.
 * Returns `false` (suppress / keep answered state) while settling.
 *
 * @param hasPrompt    - cockpit.prompt is non-null (a scrape prompt exists)
 * @param pickerOpen   - cockpit.pickerOpen for the selected session.
 *   Kept in the signature for API consistency and documentation, but NOT used
 *   as a release condition. Previously `!pickerOpen` released suppression, but
 *   that caused a frame-ordering flash: the picker frame can clear before the
 *   stale scrape prompt frame clears, so pickerOpen=false alone is insufficient.
 *   Release happens only via cap elapsed or hasPrompt=false (handled upstream).
 * @param answerSettling - settling flag set on answer submit
 * @param settleDeadline - epoch-ms safety cap (0 means no cap active)
 * @param now          - current timestamp (injectable for tests)
 */
export function shouldShowPrompt({
  hasPrompt,
  pickerOpen: _pickerOpen,  // intentionally unused — see JSDoc above
  answerSettling,
  settleDeadline,
  now,
}: {
  hasPrompt: boolean;
  pickerOpen: boolean;
  answerSettling: boolean;
  settleDeadline: number;
  now: number;
}): boolean {
  // Nothing to show.
  if (!hasPrompt) return false;

  // Not settling — no suppression in play.
  if (!answerSettling) return true;

  // Safety cap elapsed → release regardless of hasPrompt / pickerOpen.
  if (settleDeadline > 0 && now >= settleDeadline) return true;

  // Invariant: while settling AND hasPrompt=true, suppress regardless of
  // pickerOpen. The picker frame and the prompt-clear frame are sent as
  // separate WebSocket messages with no ordering guarantee; releasing on
  // pickerOpen=false alone lets a stale scrape prompt re-open the question
  // for one render cycle before the prompt frame catches up (the flash bug).
  // answerSettling is cleared by the App effect only when BOTH pickerOpen=false
  // AND hasPrompt=false, so this branch fires only while both signals are live.
  return false;
}

/**
 * Mirrors shouldShowPrompt for the synthesized-ask fallback path. This path
 * fires when `!cockpit.prompt && selectedSession.pending === true`. An answered
 * question on a tailer-less session must be suppressed with the same logic.
 */
export function shouldShowSynthesizedAsk({
  pickerOpen,
  answerSettling,
  settleDeadline,
  now,
}: {
  pickerOpen: boolean;
  answerSettling: boolean;
  settleDeadline: number;
  now: number;
}): boolean {
  if (!answerSettling) return true;
  if (settleDeadline > 0 && now >= settleDeadline) return true;
  if (!pickerOpen) return true;
  return false;
}
