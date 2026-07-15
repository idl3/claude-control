// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadFontSize, saveFontSize } from './fontSizePrefs';

// Same stub as ArtifactContext.vitest.ts / ArtifactPanel.vitest.ts: this
// repo's Node/vitest/jsdom combo shadows jsdom's real localStorage with a
// broken Node global (no getItem/setItem), so round-trips need a real
// in-memory Storage stub.
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

describe('fontSizePrefs', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new FakeLocalStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loadFontSize returns null when nothing is stored (caller falls back to server value)', () => {
    expect(loadFontSize('transcript')).toBeNull();
    expect(loadFontSize('external')).toBeNull();
  });

  it('saveFontSize then loadFontSize round-trips the value, independently per kind', () => {
    saveFontSize('transcript', 16);
    saveFontSize('external', 20);
    expect(loadFontSize('transcript')).toBe(16);
    expect(loadFontSize('external')).toBe(20);
  });

  it('saveFontSize(0) clears a previously stored override', () => {
    saveFontSize('transcript', 16);
    expect(loadFontSize('transcript')).toBe(16);
    saveFontSize('transcript', 0);
    expect(loadFontSize('transcript')).toBeNull();
  });

  it('loadFontSize ignores corrupt/non-numeric stored values', () => {
    localStorage.setItem('cc:font-size-transcript', 'not-a-number');
    expect(loadFontSize('transcript')).toBeNull();
  });

  it('loadFontSize/saveFontSize degrade to a non-throwing no-op when localStorage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('storage disabled');
      },
      removeItem: () => {
        throw new Error('storage disabled');
      },
    });
    expect(() => saveFontSize('transcript', 16)).not.toThrow();
    expect(loadFontSize('transcript')).toBeNull();
  });
});
