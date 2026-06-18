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

/**
 * Modal enter/exit transition. Put `rootRef` on the `.modal-backdrop` element
 * (its single child is the panel). On mount it fades the backdrop and lifts the
 * panel in. Call `requestClose()` from every close path (backdrop click, Esc,
 * buttons) instead of `onClose` directly — it plays the exit, THEN unmounts via
 * `onClose`. This is the mounted-while-leaving mechanism the app otherwise lacks.
 */
export function useModalTransition(onClose: () => void) {
  const rootRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const panel = root.querySelector<HTMLElement>(':scope > *');
    if (prefersReducedMotion()) {
      gsap.set(root, { opacity: 1 });
      if (panel) gsap.set(panel, { clearProps: 'transform,opacity' });
      return;
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
    };
  }, []);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    const root = rootRef.current;
    if (!root || prefersReducedMotion()) {
      onCloseRef.current();
      return;
    }
    const panel = root.querySelector<HTMLElement>(':scope > *');
    const tl = gsap.timeline({ onComplete: () => onCloseRef.current() });
    if (panel) {
      tl.to(panel, { y: 10, scale: 0.97, opacity: 0, duration: ANIM.fast, ease: ANIM.exitEase });
    }
    tl.to(root, { opacity: 0, duration: ANIM.fast, ease: 'none' }, '<');
  }, []);

  return { rootRef, requestClose };
}

export default gsap;
