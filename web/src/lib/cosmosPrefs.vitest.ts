// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadCosmosPref, saveCosmosPref } from './cosmosPrefs';

// Same stub as fontSizePrefs.vitest.ts: this repo's Node/vitest/jsdom combo
// shadows jsdom's real localStorage with a broken Node global.
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

describe('cosmosPrefs', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new FakeLocalStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults every pref to enabled when nothing is stored', () => {
    expect(loadCosmosPref('background')).toBe(true);
    expect(loadCosmosPref('parallax')).toBe(true);
    expect(loadCosmosPref('shootingStars')).toBe(true);
  });

  it('saveCosmosPref then loadCosmosPref round-trips independently per kind', () => {
    saveCosmosPref('background', false);
    expect(loadCosmosPref('background')).toBe(false);
    expect(loadCosmosPref('parallax')).toBe(true);
    expect(loadCosmosPref('shootingStars')).toBe(true);
  });

  it('re-enabling after disabling restores true', () => {
    saveCosmosPref('shootingStars', false);
    expect(loadCosmosPref('shootingStars')).toBe(false);
    saveCosmosPref('shootingStars', true);
    expect(loadCosmosPref('shootingStars')).toBe(true);
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
    expect(() => saveCosmosPref('parallax', false)).not.toThrow();
    expect(loadCosmosPref('parallax')).toBe(true);
  });
});
