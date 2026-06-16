/**
 * Pure focus/keyboard helpers for {@link TerminalPanel}, extracted so they can
 * be unit-tested without a DOM. The regression these guard: the close button
 * must never be the initial focus target, and only Escape — not Enter/Space —
 * may close the panel. Both are what kept stray terminal keystrokes from
 * activating the [✕] button.
 */

/** Where initial focus goes when the terminal overlay opens. */
export type FocusTarget = 'frame' | 'close';

/**
 * The element that receives focus on open. Always the iframe so keystrokes go
 * to ttyd; never the close button (whose activation would close the panel).
 */
export const initialFocusTarget: FocusTarget = 'frame';

/**
 * Whether a keydown on the overlay should close the panel. Only Escape closes;
 * Enter/Space (and everything else) are left for the terminal, so typing can
 * never trigger the close action.
 */
export function shouldCloseOnKey(key: string): boolean {
  return key === 'Escape';
}
