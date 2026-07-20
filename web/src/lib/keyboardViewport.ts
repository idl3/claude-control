/**
 * Soft-keyboard detection helpers for the mobile visualViewport pin
 * (see App.tsx's visualViewport effect + styles.css `body.kbd-up .app`).
 *
 * The keyboard is "up" when the visible viewport height has DROPPED
 * meaningfully below the STABLE layout-viewport height.
 *
 * Two things are load-bearing here, both learned from real iOS WebKit
 * behaviour:
 *
 *  - Use the LAYOUT-viewport height (`documentElement.clientHeight`) as the
 *    reference, NOT `window.innerHeight`. When iOS raises the keyboard and
 *    scrolls the focused input into view, `window.innerHeight` collapses to
 *    `visualViewport.height` (observed: 358 while the true layout height was
 *    695), which would make any innerHeight-based delta read ~0. clientHeight
 *    stays at the real layout height through that.
 *
 *  - Do NOT subtract `visualViewport.offsetTop`. iOS drives offsetTop large
 *    during the same scroll-into-view; the previous
 *    `innerHeight - visualViewport.height - offsetTop > 120` then went
 *    NEGATIVE and silently failed to flip `kbd-up`, so the composer pin never
 *    engaged and the composer floated above the keyboard with a gap.
 */
export const KEYBOARD_UP_THRESHOLD_PX = 120;

export function keyboardIsUp(
  layoutHeight: number,
  visualViewportHeight: number,
  threshold: number = KEYBOARD_UP_THRESHOLD_PX,
): boolean {
  return layoutHeight - visualViewportHeight > threshold;
}

/**
 * Minimum fraction of the (stable) layout-viewport height the visible viewport
 * must drop by before we treat it as a soft keyboard — on top of the absolute
 * px floor. Belt-and-suspenders with the focused-editable gate: on a tall
 * layout (iPad portrait ~1194px) a Safari toolbar collapse or a transcript-load
 * reflow can exceed the flat 120px floor with NO keyboard; only a real
 * on-screen keyboard covers ~25%+ of the viewport.
 */
export const KEYBOARD_UP_MIN_RATIO = 0.25;

const NON_KEYBOARD_INPUT_TYPES = new Set([
  'button', 'submit', 'reset', 'checkbox', 'radio',
  'range', 'color', 'file', 'image', 'hidden',
]);

/**
 * True only when a text-editable element is focused. The soft keyboard cannot
 * be up without one. Gating kbd-up on this stops iPad from mistaking a toolbar
 * collapse / transcript-load reflow (which shrink visualViewport with NO
 * keyboard and NO focused field) for a keyboard — which would erroneously pin
 * `.app` (position:fixed at a stale height) and push the composer + rail footer
 * off-screen with no keyboard to dismiss. Non-text input types never raise a
 * keyboard.
 */
export function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    return !NON_KEYBOARD_INPUT_TYPES.has(type);
  }
  return (el as HTMLElement).isContentEditable === true;
}

/**
 * Soft keyboard is up IFF a text-editable element is focused AND the visible
 * viewport has dropped BOTH past the absolute px floor AND past the ratio of
 * the (stable) layout-viewport height. See keyboardIsUp for why layoutHeight
 * must be documentElement.clientHeight (not window.innerHeight) and why
 * offsetTop is never subtracted.
 */
export function softKeyboardIsUp(params: {
  layoutHeight: number;
  visualViewportHeight: number;
  hasEditableFocus: boolean;
  minDropPx?: number;
  minDropRatio?: number;
}): boolean {
  const {
    layoutHeight,
    visualViewportHeight,
    hasEditableFocus,
    minDropPx = KEYBOARD_UP_THRESHOLD_PX,
    minDropRatio = KEYBOARD_UP_MIN_RATIO,
  } = params;
  if (!hasEditableFocus) return false;
  const drop = layoutHeight - visualViewportHeight;
  return (
    keyboardIsUp(layoutHeight, visualViewportHeight, minDropPx) &&
    drop > layoutHeight * minDropRatio
  );
}
