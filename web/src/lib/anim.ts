import { useCallback, useEffect, useRef } from 'react';
import gsap from 'gsap';

/**
 * Shared GSAP helpers. Hybrid policy: GSAP drives orchestrated motion (modal
 * enter/exit, panels, transitions); lightweight CSS keyframes still handle
 * micro-states (spinners, the optimiser ring, hover). EVERY animation here is
 * gated by prefers-reduced-motion — when set, we jump straight to the end state.
 */

export const ANIM = {
  fast: 0.18,
  base: 0.28,
  enterEase: 'power3.out',
  exitEase: 'power2.in',
} as const;

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Run `fn` only when motion is allowed; otherwise no-op. */
export function ifMotion(fn: () => void): void {
  if (!prefersReducedMotion()) fn();
}

/** CSS selector for elements that are naturally focusable. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Returns visible focusable descendants of `container`, in DOM order.
 * Visibility is determined via computed style so that display:none and
 * visibility:hidden elements are correctly excluded — this also works in
 * non-layout environments like jsdom (unlike offsetParent / getClientRects).
 */
function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    // Walk up the ancestor chain: if any ancestor (including the element itself)
    // is display:none or visibility:hidden, the element is not reachable.
    let node: HTMLElement | null = el;
    while (node && node !== container.parentElement) {
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      node = node.parentElement;
    }
    return true;
  });
}

/**
 * Modal enter/exit transition. Put `rootRef` on the `.modal-backdrop` element
 * (its single child is the panel). On mount it fades the backdrop and lifts the
 * panel in. Call `requestClose()` from every close path (backdrop click, Esc,
 * buttons) instead of `onClose` directly — it plays the exit, THEN unmounts via
 * `onClose`. This is the mounted-while-leaving mechanism the app otherwise lacks.
 *
 * Focus management (a11y):
 *   - On open: saves the previously-focused element, then moves focus into the
 *     panel (first focusable descendant, or the panel itself).
 *   - While open: Tab/Shift+Tab are trapped within the panel's focusable set.
 *   - On close: restores focus to the previously-focused element if it is still
 *     in the document and is focusable.
 */
export function useModalTransition(onClose: () => void) {
  const rootRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  /** The element that was focused before this modal opened. */
  const restoreTargetRef = useRef<Element | null>(null);

  /** Restores focus to the pre-open element if it is still connected + focusable. */
  const restoreFocus = useCallback(() => {
    const target = restoreTargetRef.current;
    if (
      target instanceof HTMLElement &&
      target.isConnected &&
      (target.tabIndex >= 0 || target.matches(FOCUSABLE_SELECTOR))
    ) {
      target.focus();
    }
    restoreTargetRef.current = null;
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const panel = root.querySelector<HTMLElement>(':scope > *');

    // --- Focus management: save previous focus, move into panel ---------------
    restoreTargetRef.current = document.activeElement;

    if (panel) {
      const first = getFocusable(panel)[0];
      if (first) {
        first.focus();
      } else {
        // No naturally-focusable child; make the panel itself focusable.
        if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
        panel.focus();
      }
    }

    // --- Focus trap: intercept Tab / Shift+Tab inside the panel ---------------
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Tab' || !panel) return;
      const focusable = getFocusable(panel);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        // Shift+Tab: if focus is on (or before) the first, wrap to last.
        if (document.activeElement === first || !panel.contains(document.activeElement)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Tab: if focus is on (or after) the last, wrap to first.
        if (document.activeElement === last || !panel.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown);

    // --- Animation -------------------------------------------------------------
    if (prefersReducedMotion()) {
      gsap.set(root, { opacity: 1 });
      if (panel) gsap.set(panel, { clearProps: 'transform,opacity' });
      return () => {
        document.removeEventListener('keydown', handleKeyDown);
      };
    }
    const tl = gsap.timeline();
    tl.fromTo(root, { opacity: 0 }, { opacity: 1, duration: ANIM.fast, ease: 'none' });
    if (panel) {
      tl.fromTo(
        panel,
        { y: 14, scale: 0.97, opacity: 0 },
        { y: 0, scale: 1, opacity: 1, duration: ANIM.base, ease: ANIM.enterEase },
        '<',
      );
    }
    return () => {
      tl.kill();
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    const root = rootRef.current;
    if (!root || prefersReducedMotion()) {
      restoreFocus();
      onCloseRef.current();
      return;
    }
    const panel = root.querySelector<HTMLElement>(':scope > *');
    const tl = gsap.timeline({
      onComplete: () => {
        restoreFocus();
        onCloseRef.current();
      },
    });
    if (panel) {
      tl.to(panel, { y: 10, scale: 0.97, opacity: 0, duration: ANIM.fast, ease: ANIM.exitEase });
    }
    tl.to(root, { opacity: 0, duration: ANIM.fast, ease: 'none' }, '<');
  }, [restoreFocus]);

  return { rootRef, requestClose };
}

export default gsap;
