// A3: capture-phase hotkey suppression seam.
//
// Module-level store (no React Context) so StudioModal (A4) can read/write
// the suppression flag without needing to be inside any particular
// provider tree, and so the interceptor hook below can subscribe without a
// re-render cascade through App's component tree.
//
// The interceptor is mounted exactly once, as early as possible in App's
// commit — see `useHotkeySuppressionInterceptor`'s doc comment for the
// ordering guarantee this relies on. NONE of the app's 20 existing keydown
// listeners are touched; this seam sits in front of all of them and, while
// suppression is ON, stops matching combos from ever reaching them.
import { useLayoutEffect } from 'react';

let suppressed = false;
const listeners = new Set<(enabled: boolean) => void>();

export function getHotkeySuppressed(): boolean {
  return suppressed;
}

export function setHotkeySuppressed(enabled: boolean): void {
  if (suppressed === enabled) return;
  suppressed = enabled;
  for (const fn of listeners) fn(suppressed);
}

export function subscribeHotkeySuppressed(fn: (enabled: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Keys that must always reach the browser/app even while suppression is
// ON — clipboard combos, so the studio's device-frame content stays
// copy/paste-able, and plain typing (no modifier) is never touched at all.
const NEVER_SUPPRESSED_KEYS = new Set(['c', 'v', 'x']);

/**
 * True when `e` is a modifier-combo this seam suppresses. Escape is NEVER
 * suppressed (it's the studio's own close key — see A4). Cmd/Ctrl+C/V/X
 * pass through so copy/paste/cut keep working inside the studio. Plain
 * typing (no meta/ctrl/alt) is never a match — suppression only targets
 * browser/app-default combos, not the content itself.
 */
export function isSuppressedCombo(e: KeyboardEvent): boolean {
  if (e.key === 'Escape') return false;
  const hasModifier = e.metaKey || e.ctrlKey || e.altKey;
  if (!hasModifier) return false;
  const key = e.key.toLowerCase();
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && NEVER_SUPPRESSED_KEYS.has(key)) {
    return false;
  }
  return true;
}

/**
 * Registers the single capture-phase `window` keydown interceptor. Must be
 * called from exactly one component, mounted as early as possible in App's
 * tree (see App.tsx's `AppChrome`, rendered as a sibling of `TokenGate` in
 * the root `App` component's OWN initial commit).
 *
 * Ordering guarantee: this uses `useLayoutEffect`, which fires synchronously
 * (bottom-up, before paint) — every layout effect in a commit completes
 * before any passive `useEffect` in that same commit runs. Because
 * `AppChrome` mounts in App's own commit, its layout effect registers this
 * capture-phase listener before `AppInner` (and all 20 of its descendants'
 * bubble/capture keydown listeners, all registered via plain `useEffect`)
 * even exists. Within the capture phase, the browser always invokes
 * capture-phase `window` listeners before bubble-phase ones regardless of
 * registration order, and this is the ONLY capture-phase listener that
 * exists before AppInner mounts — so it is guaranteed to see every keydown
 * first, whether the app's later listeners are capture or bubble.
 *
 * When suppression is ON and the event matches `isSuppressedCombo`, this
 * calls `stopImmediatePropagation()` (no other listener on `window`, capture
 * or bubble, ever sees the event) and `preventDefault()` (browser default
 * action — e.g. Cmd+K browser search — is blocked too). Plain typing is
 * never touched (isSuppressedCombo returns false, so this is a no-op).
 */
export function useHotkeySuppressionInterceptor(): void {
  useLayoutEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!getHotkeySuppressed()) return;
      if (!isSuppressedCombo(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
