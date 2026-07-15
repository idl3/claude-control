// @vitest-environment jsdom
//
// Task 1: per-embed resize memory (see appSize.ts's module doc comment for
// how this feeds AppFrameLayer.tsx's beginResize + EmbeddedApp.tsx's
// placeholder-follows-hoist). Same FakeLocalStorage stubbing idiom as
// ArtifactPanel.vitest.ts's D4 suite (loadAppTabVersion/saveAppTabVersion) —
// this Node/vitest/jsdom combo shadows jsdom's localStorage with Node's own
// experimental global, which implements neither getItem nor setItem, so a
// real in-memory Storage stand-in is required to actually exercise the
// module rather than silently hitting every try/catch's swallow path.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  APP_SIZE_PREFIX,
  APP_SIZE_MIN_WIDTH,
  APP_SIZE_MIN_HEIGHT,
  APP_SIZE_MAX_WIDTH,
  APP_SIZE_MAX_HEIGHT,
  clampAppSize,
  loadAppSize,
  saveAppSize,
  clearAppSize,
} from './appSize';

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
  key(i: number): string | null {
    return Array.from(this.store.keys())[i] ?? null;
  }
  get length(): number {
    return this.store.size;
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new FakeLocalStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('clampAppSize (pure)', () => {
  it('passes through an in-range size unchanged (rounded)', () => {
    expect(clampAppSize(500.4, 400.6)).toEqual({ width: 500, height: 401 });
  });

  it('clamps below the minimum', () => {
    expect(clampAppSize(10, 10)).toEqual({ width: APP_SIZE_MIN_WIDTH, height: APP_SIZE_MIN_HEIGHT });
  });

  it('clamps above the maximum', () => {
    expect(clampAppSize(999999, 999999)).toEqual({ width: APP_SIZE_MAX_WIDTH, height: APP_SIZE_MAX_HEIGHT });
  });
});

describe('loadAppSize / saveAppSize / clearAppSize (localStorage-backed)', () => {
  it('returns null for a url that was never saved', () => {
    expect(loadAppSize('apps/never-saved.html')).toBeNull();
  });

  it('round-trips a saved size, clamped', () => {
    saveAppSize('apps/counter.html', { width: 900, height: 700 });
    expect(loadAppSize('apps/counter.html')).toEqual({ width: 900, height: 700 });
  });

  it('is keyed per-url — saving one url never affects another', () => {
    saveAppSize('apps/a.html', { width: 900, height: 700 });
    expect(loadAppSize('apps/b.html')).toBeNull();
  });

  it('clamps an out-of-range size on save, not just on load', () => {
    saveAppSize('apps/huge.html', { width: 50, height: 50000 });
    expect(loadAppSize('apps/huge.html')).toEqual({ width: APP_SIZE_MIN_WIDTH, height: APP_SIZE_MAX_HEIGHT });
  });

  it('ignores malformed JSON in the stored value (falls back to null, not a throw)', () => {
    localStorage.setItem(APP_SIZE_PREFIX + 'apps/bad.html', 'not json');
    expect(loadAppSize('apps/bad.html')).toBeNull();
  });

  it('ignores a stored value missing width/height (falls back to null)', () => {
    localStorage.setItem(APP_SIZE_PREFIX + 'apps/partial.html', JSON.stringify({ width: 500 }));
    expect(loadAppSize('apps/partial.html')).toBeNull();
  });

  it('clearAppSize removes a saved size', () => {
    saveAppSize('apps/counter.html', { width: 900, height: 700 });
    clearAppSize('apps/counter.html');
    expect(loadAppSize('apps/counter.html')).toBeNull();
  });

  it('saveAppSize never throws when localStorage.setItem throws (quota/unavailable)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => {},
    });
    expect(() => saveAppSize('apps/counter.html', { width: 900, height: 700 })).not.toThrow();
  });

  it('loadAppSize never throws when localStorage.getItem throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {},
      removeItem: () => {},
    });
    expect(loadAppSize('apps/counter.html')).toBeNull();
  });
});
