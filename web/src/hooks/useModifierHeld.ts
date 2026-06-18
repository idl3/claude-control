import { useEffect, useState } from 'react';

/**
 * Returns true while the Meta (Cmd on macOS) or Control key is physically held
 * for at least `delayMs` — a hold, not a tap, so transient ⌘-combos (⌘K, ⌘C…)
 * don't flash the hint overlay. Resets immediately on release, blur, or tab
 * hide, so the state can never get "stuck" after a Cmd+Tab or similar intercept.
 */
export function useModifierHeld(delayMs = 0): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let on = false;

    const reset = () => {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      if (on) {
        on = false;
        setHeld(false);
      }
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.key !== 'Meta' && e.key !== 'Control') return;
      if (on || timer != null) return; // ignore key-repeat
      timer = setTimeout(() => {
        timer = null;
        on = true;
        setHeld(true);
      }, delayMs);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === 'Meta' || e.key === 'Control') reset();
    };
    const onHide = () => {
      if (document.hidden) reset();
    };

    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      reset();
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [delayMs]);

  return held;
}
