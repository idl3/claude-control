import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PANEL_LS_PREFIX, PANELS_KILL_KEY, panelsEnabled, readPanelSize, writePanelSize } from './panelLayout';

// Dev-Node shadows localStorage with a no-op stub (see pendingSend.vitest.ts),
// so stub an in-memory Storage or every assertion here would pass vacuously.
class FakeLocalStorage {
  private store = new Map<string, string>();
  getItem(k: string) { return this.store.has(k) ? this.store.get(k)! : null; }
  setItem(k: string, v: string) { this.store.set(k, String(v)); }
  removeItem(k: string) { this.store.delete(k); }
  clear() { this.store.clear(); }
}

describe('panelLayout', () => {
  beforeEach(() => vi.stubGlobal('localStorage', new FakeLocalStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('falls back when nothing is stored', () => {
    expect(readPanelSize('rail', 375)).toBe(375);
  });

  it('round-trips a written size, rounded to whole px', () => {
    writePanelSize('rail', 412.6);
    expect(localStorage.getItem(PANEL_LS_PREFIX + 'rail')).toBe('413');
    expect(readPanelSize('rail', 375)).toBe(413);
  });

  it('rejects garbage, non-positive and absurd stored values', () => {
    for (const bad of ['abc', '0', '-20', 'NaN', '99999']) {
      localStorage.setItem(PANEL_LS_PREFIX + 'x', bad);
      expect(readPanelSize('x', 300)).toBe(300);
    }
  });

  it('ignores non-finite writes', () => {
    writePanelSize('y', Number.NaN);
    writePanelSize('y', -5);
    expect(localStorage.getItem(PANEL_LS_PREFIX + 'y')).toBeNull();
  });

  it('kill switch: only the literal "0" disables panels', () => {
    expect(panelsEnabled()).toBe(true);
    localStorage.setItem(PANELS_KILL_KEY, '0');
    expect(panelsEnabled()).toBe(false);
    localStorage.setItem(PANELS_KILL_KEY, 'false');
    expect(panelsEnabled()).toBe(true);
  });
});
