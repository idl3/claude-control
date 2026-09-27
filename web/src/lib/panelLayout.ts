// Persisted sizes for the motion-panels shell (desktop only). One localStorage
// key per seam (`cc:panel:<key>`), pixels. `cc:panels=0` is the kill switch
// that restores the plain flex layout without a rebuild.
import { useCallback, useState } from 'react';

export const PANEL_LS_PREFIX = 'cc:panel:';
export const PANELS_KILL_KEY = 'cc:panels';

export function panelsEnabled(): boolean {
  try {
    return localStorage.getItem(PANELS_KILL_KEY) !== '0';
  } catch {
    return true;
  }
}

/** Stored px size for `key`, else `fallback`. Rejects NaN / non-positive / absurd values. */
export function readPanelSize(key: string, fallback: number, max = 10_000): number {
  try {
    const raw = localStorage.getItem(PANEL_LS_PREFIX + key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 && n <= max ? Math.round(n) : fallback;
  } catch {
    return fallback;
  }
}

export function writePanelSize(key: string, size: number): void {
  if (!Number.isFinite(size) || size <= 0) return;
  try {
    localStorage.setItem(PANEL_LS_PREFIX + key, String(Math.round(size)));
  } catch {
    /* localStorage unavailable/full — the size just doesn't survive reload. */
  }
}

/** Controlled `size`/`onSizeChange` pair for a motion-panels <Panel>, persisted. */
export function usePanelSize(key: string, fallback: number): [number, (n: number) => void] {
  const [size, setSize] = useState(() => readPanelSize(key, fallback));
  const set = useCallback(
    (n: number) => {
      setSize(n);
      writePanelSize(key, n);
    },
    [key],
  );
  return [size, set];
}
