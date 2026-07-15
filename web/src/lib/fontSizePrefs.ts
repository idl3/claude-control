// Per-device font-size overrides. lib/api.ts's ControlConfig.transcriptFontSize/
// externalFontSize are server-side and SHARED across every device pointed at
// this server; localStorage lets each device (phone vs desktop vs iPad) keep
// its own size without one device's choice clobbering another's — the server
// value is consulted only as the fallback when this device has no override.
// Same try/catch-and-default idiom as sessionArtifacts.ts's gallery-open
// persistence: private mode / storage-disabled just degrades to "no override".
const KEYS = {
  transcript: 'cc:font-size-transcript',
  external: 'cc:font-size-external',
} as const;

export type FontSizeKind = keyof typeof KEYS;

/** This device's stored override, or null if none set (caller falls back to the server value). */
export function loadFontSize(kind: FontSizeKind): number | null {
  try {
    const raw = localStorage.getItem(KEYS[kind]);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Persist this device's chosen size (0/falsy clears the override, reverting to the server default). */
export function saveFontSize(kind: FontSizeKind, px: number): void {
  try {
    if (px > 0) localStorage.setItem(KEYS[kind], String(px));
    else localStorage.removeItem(KEYS[kind]);
  } catch {
    /* localStorage unavailable/full — the choice just doesn't survive reload */
  }
}
