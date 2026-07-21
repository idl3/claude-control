// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadRingRotation, saveRingRotation, applyRingRotation } from './ringRotationPref';

// Same stub as cosmosPrefs.vitest.ts / fontSizePrefs.vitest.ts: this repo's
// Node/vitest/jsdom combo shadows jsdom's real localStorage with a broken
// Node global.
class FakeLocalStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

describe('ringRotationPref', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new FakeLocalStorage());
    document.documentElement.removeAttribute('data-ring-rotation');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute('data-ring-rotation');
  });

  it('defaults to auto when nothing is stored', () => {
    expect(loadRingRotation()).toBe('auto');
  });

  it('defaults to auto when storage holds an invalid value', () => {
    localStorage.setItem('cc:ring-rotation', 'spin-forever');
    expect(loadRingRotation()).toBe('auto');
  });

  it.each(['auto', 'on', 'off'] as const)('saveRingRotation(%s) round-trips through loadRingRotation', (v) => {
    saveRingRotation(v);
    expect(loadRingRotation()).toBe(v);
  });

  it('degrades to non-throwing defaults when localStorage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('storage disabled');
      },
    });
    expect(() => saveRingRotation('on')).not.toThrow();
    expect(loadRingRotation()).toBe('auto');
  });

  it.each(['auto', 'on', 'off'] as const)('applyRingRotation(%s) sets the html attribute', (v) => {
    applyRingRotation(v);
    expect(document.documentElement.getAttribute('data-ring-rotation')).toBe(v);
  });
});
