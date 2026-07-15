// Per-embed resize memory for transcript app embeds — mirrors
// ArtifactPanel.tsx's APP_TAB_VERSION_PREFIX / loadAppTabVersion /
// saveAppTabVersion (D4) localStorage pattern exactly. Keyed by the embed's
// url (one size per distinct app — a transcript embed has no per-tab concept
// the way a pinned panel artifact does).
//
// AppFrameLayer.tsx's resize-drag handler writes here on pointerup;
// EmbeddedApp.tsx's placeholder reads it on mount so the reserved box starts
// at the last-resized size instead of flashing at the tag's default `height`
// and then jumping once AppFrameLayer catches up (placeholder-follows-hoist).

export const APP_SIZE_PREFIX = 'cc_app_size:';

export type AppSize = { width: number; height: number };

export const APP_SIZE_MIN_WIDTH = 240;
export const APP_SIZE_MIN_HEIGHT = 160;
export const APP_SIZE_MAX_WIDTH = 2000;
export const APP_SIZE_MAX_HEIGHT = 1600;

export function clampAppSize(width: number, height: number): AppSize {
  return {
    width: Math.min(APP_SIZE_MAX_WIDTH, Math.max(APP_SIZE_MIN_WIDTH, Math.round(width))),
    height: Math.min(APP_SIZE_MAX_HEIGHT, Math.max(APP_SIZE_MIN_HEIGHT, Math.round(height))),
  };
}

export function loadAppSize(url: string): AppSize | null {
  try {
    const raw = localStorage.getItem(APP_SIZE_PREFIX + url);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.width === 'number' && typeof parsed.height === 'number') {
      return clampAppSize(parsed.width, parsed.height);
    }
    return null;
  } catch {
    return null;
  }
}

export function saveAppSize(url: string, size: AppSize): void {
  try {
    localStorage.setItem(APP_SIZE_PREFIX + url, JSON.stringify(clampAppSize(size.width, size.height)));
  } catch {
    /* localStorage unavailable/full — the resize just doesn't survive reload. */
  }
}

export function clearAppSize(url: string): void {
  try {
    localStorage.removeItem(APP_SIZE_PREFIX + url);
  } catch {
    /* no-op */
  }
}
