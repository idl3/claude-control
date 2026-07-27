import { useLayoutEffect, useRef } from 'react';

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Animate a container's height across a content swap (options ↔ free-text). The
 * container is auto-height and follows its content. A ResizeObserver can't do
 * this — by the time it fires the DOM already snapped — so the caller captures
 * the height in the click handler BEFORE setState, then we FLIP from it after
 * the re-render. Returns `capture()` to call synchronously before the state
 * change. Uses WAAPI (no animation library); no-ops under reduced motion or
 * when Element.animate is unavailable (jsdom, ancient engines).
 */
export function useHeightFlip(
  ref: React.RefObject<HTMLElement | null>,
  dep: unknown,
): () => void {
  const beforeRef = useRef<number | null>(null);
  const capture = () => {
    beforeRef.current = ref.current?.offsetHeight ?? null;
  };
  useLayoutEffect(() => {
    const from = beforeRef.current;
    beforeRef.current = null;
    const el = ref.current;
    if (from == null || !el || prefersReducedMotion()) return;
    if (typeof el.animate !== 'function') return;
    const to = el.offsetHeight;
    if (Math.abs(to - from) < 2) return;
    // No fill: when the tween ends the element is already at its natural
    // (new) height, so there is no inline style to clean up.
    el.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: 200,
      // ≈ gsap power3.out, the ease this animation shipped with originally.
      easing: 'cubic-bezier(0.215, 0.61, 0.355, 1)',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep]);
  return capture;
}
