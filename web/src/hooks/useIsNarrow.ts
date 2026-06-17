import { useEffect, useState } from 'react';

const BREAKPOINT = '(max-width:760px)';

/**
 * Returns true when the viewport is ≤760px (mobile/narrow).
 * SSR-safe: falls back to false if window is unavailable.
 */
export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(BREAKPOINT).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(BREAKPOINT);
    const handler = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return narrow;
}
