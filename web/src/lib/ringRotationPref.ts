// Per-device active-ring rotation preference. Same try/catch-and-default
// idiom as cosmosPrefs.ts / fontSizePrefs.ts. Unlike the cosmos toggles this
// drives a plain `data-ring-rotation` attribute on <html> that styles.css
// keys on directly — no React-state/CSS-class plumbing needed, so applying
// it is just setAttribute (see applyRingRotation below).
const KEY = 'cc:ring-rotation';

export type RingRotation = 'auto' | 'on' | 'off';

const VALID: readonly RingRotation[] = ['auto', 'on', 'off'];

/** Default 'auto' (current desktop-only behavior) when absent/corrupt. */
export function loadRingRotation(): RingRotation {
  try {
    const v = localStorage.getItem(KEY);
    return (VALID as readonly string[]).includes(v ?? '') ? (v as RingRotation) : 'auto';
  } catch {
    return 'auto';
  }
}

export function saveRingRotation(v: RingRotation): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* localStorage unavailable/full — the choice just doesn't survive reload */
  }
}

/** Sets the attribute styles.css keys on. See the gating rules there for
 * how 'auto' / 'on' / 'off' (and prefers-reduced-motion) resolve. */
export function applyRingRotation(v: RingRotation): void {
  try {
    document.documentElement.setAttribute('data-ring-rotation', v);
  } catch {
    /* no document (non-browser environment) */
  }
}
