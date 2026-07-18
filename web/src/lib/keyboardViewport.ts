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
