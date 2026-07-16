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

// The actual scroll containers. NOTE: the sidebar scroller is `.rail-scroll`
// (the inner list) — `.rail` itself is overflow:hidden, so using it here made
// PTR think the rail was always at scrollTop 0 and preventDefault every touch,
// freezing sidebar scrolling.
const SCROLLER_SEL = '.thread-viewport, .rail-scroll, .live-pane-body';

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
  // Deferred hard-reload timer — captured so an unmount within the 150ms paint
  // window clears it (no post-unmount onRefresh for a custom callback).
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep the LATEST onRefresh in a ref and bind the effect to `rootRef` only.
  // The default `onRefresh` (and any inline caller arg) is a NEW closure every
  // render; if it were an effect dep, the very re-render triggered by
  // setRefreshing(true) would re-run the effect and its cleanup would clear the
  // just-scheduled 150ms reload timer — spinner shows, page never reloads (the
  // reported bug). Reading through a ref keeps the effect mounted-once.
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const setPull = (v: number) => {
    pullRef.current = v;
    setPullState(v);
  };

  useEffect(() => {
    // Listen at the WINDOW in capture phase (not the app root in bubble phase).
    // In the installed PWA the app fills more than the layout viewport, so the
    // document can rubber-band; a bubble-phase listener on .app fired too late to
    // suppress it and the pull just scrolled the page instead of refreshing.
    // Capturing at the window intercepts the gesture first, so preventDefault
    // reliably suppresses the native overscroll and the custom pull runs.
    void rootRef;

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
        // Let the spinner paint, then hard-reload (latest callback via ref).
        refreshTimerRef.current = setTimeout(() => onRefreshRef.current(), 150);
      } else {
        setPull(0);
      }
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: false, capture: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    window.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove, { capture: true });
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
    // Bind ONCE (rootRef is a stable ref). onRefresh is read via onRefreshRef so
    // it never re-binds the effect — otherwise the setRefreshing(true) re-render
    // would re-run this cleanup and cancel the pending reload timer.
  }, [rootRef]);

  return { pull, refreshing };
}

export const PTR_THRESHOLD = THRESHOLD;
