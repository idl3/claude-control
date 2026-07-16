// Per-device cosmos-backdrop toggles (background / parallax / shooting stars).
// Same try/catch-and-default idiom as fontSizePrefs.ts; unlike font size these
// are booleans with no server-side counterpart, so the pattern mirrors
// App.tsx's `cc:actionsOpen` idiom instead: absent key = default ON, and only
// the literal string 'false' turns a toggle off.
const KEYS = {
  background: 'cc:cosmos-background',
  parallax: 'cc:cosmos-parallax',
  shootingStars: 'cc:cosmos-shooting-stars',
} as const;

export type CosmosPrefKind = keyof typeof KEYS;

/** Default-true: absent/corrupt storage reads as enabled. */
export function loadCosmosPref(kind: CosmosPrefKind): boolean {
  try {
    return localStorage.getItem(KEYS[kind]) !== 'false';
  } catch {
    return true;
  }
}

export function saveCosmosPref(kind: CosmosPrefKind, enabled: boolean): void {
  try {
    localStorage.setItem(KEYS[kind], String(enabled));
  } catch {
    /* localStorage unavailable/full — the choice just doesn't survive reload */
  }
}
