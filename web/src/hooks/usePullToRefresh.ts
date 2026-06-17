import { useEffect, useRef, useState } from 'react';

// Pull-to-refresh for the app. iOS standalone PWAs (and our `overscroll-behavior:
// none` body) disable the browser's native pull-to-refresh, so this provides a
// custom one to hard-reload and pick up a freshly-deployed bundle.
//
// Attaches touch listeners to `rootRef` (events bubble up from the inner
// scrollers). A pull only starts when the scroll container under the finger
// (.thread-viewport or .rail) is already at the top — so it never hijacks a
// normal upward scroll. Returns the live pull distance (px) + a refreshing flag
// for the caller to render an indicator.

const THRESHOLD = 70; // px (resisted) past which a release triggers refresh
const MAX = 110; // px clamp on the indicator travel
const RESIST = 0.5; // drag resistance

const SCROLLER_SEL = '.thread-viewport, .rail, .live-pane-body';

export function usePullToRefresh(
  rootRef: React.RefObject<HTMLElement | null>,
  onRefresh: () => void = () => window.location.reload(),
): { pull: number; refreshing: boolean } {
  const [pull, setPullState] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // Refs so the touchend handler reads live values without re-binding listeners.
  const pullRef = useRef(0);
  const pullingRef = useRef(false);
  const startYRef = useRef(0);
  const scrollerRef = useRef<HTMLElement | null>(null);

  const setPull = (v: number) => {
    pullRef.current = v;
    setPullState(v);
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        pullingRef.current = false;
        return;
      }
      const target = e.target as HTMLElement | null;
      const scroller = target?.closest<HTMLElement>(SCROLLER_SEL) ?? null;
      if (scroller && scroller.scrollTop <= 0) {
        scrollerRef.current = scroller;
        startYRef.current = e.touches[0].clientY;
        pullingRef.current = true;
      } else {
        pullingRef.current = false;
      }
    };

    const onMove = (e: TouchEvent) => {
      if (!pullingRef.current) return;
      const dy = e.touches[0].clientY - startYRef.current;
      const scroller = scrollerRef.current;
      // Cancel if the user scrolled the container or is pulling up.
      if (dy <= 0 || (scroller && scroller.scrollTop > 0)) {
        if (pullRef.current !== 0) setPull(0);
        if (scroller && scroller.scrollTop > 0) pullingRef.current = false;
        return;
      }
      const d = Math.min(MAX, dy * RESIST);
      setPull(d);
      // Non-passive listener → we can suppress the rubber-band while pulling.
      if (e.cancelable) e.preventDefault();
    };

    const onEnd = () => {
      if (!pullingRef.current) return;
      pullingRef.current = false;
      if (pullRef.current >= THRESHOLD) {
        setPull(THRESHOLD);
        setRefreshing(true);
        // Let the spinner paint, then hard-reload.
        setTimeout(onRefresh, 150);
      } else {
        setPull(0);
      }
    };

    root.addEventListener('touchstart', onStart, { passive: true });
    root.addEventListener('touchmove', onMove, { passive: false });
    root.addEventListener('touchend', onEnd, { passive: true });
    root.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      root.removeEventListener('touchstart', onStart);
      root.removeEventListener('touchmove', onMove);
      root.removeEventListener('touchend', onEnd);
      root.removeEventListener('touchcancel', onEnd);
    };
  }, [rootRef, onRefresh]);

  return { pull, refreshing };
}

export const PTR_THRESHOLD = THRESHOLD;
