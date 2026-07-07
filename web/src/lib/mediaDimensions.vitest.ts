import { describe, it, expect } from 'vitest';
import { EMBED_WIDTH } from './embeds';
import {
  DEFAULT_ASPECT_RATIO,
  getCachedAspectRatio,
  setCachedAspectRatio,
  reservedAspectRatio,
  reservedBox,
} from './mediaDimensions';

// Each test uses a unique URL — the cache is module-level (in-memory, no
// persistence) and shared across the whole file, so reusing a URL between
// tests would leak state and make ordering matter.

describe('getCachedAspectRatio / setCachedAspectRatio', () => {
  it('is undefined for a url that was never recorded', () => {
    expect(getCachedAspectRatio('https://example.com/never-seen.png')).toBeUndefined();
  });

  it('records and returns the exact width/height ratio', () => {
    const url = 'https://example.com/exact.png';
    setCachedAspectRatio(url, 1600, 900);
    expect(getCachedAspectRatio(url)).toBeCloseTo(1600 / 900);
  });

  it('ignores zero or negative dimensions (cache stays unset)', () => {
    const url = 'https://example.com/bad-dims.png';
    setCachedAspectRatio(url, 0, 0);
    expect(getCachedAspectRatio(url)).toBeUndefined();
    setCachedAspectRatio(url, -100, 50);
    expect(getCachedAspectRatio(url)).toBeUndefined();
  });

  it('overwrites a previous value for the same url', () => {
    const url = 'https://example.com/overwrite.png';
    setCachedAspectRatio(url, 100, 100);
    expect(getCachedAspectRatio(url)).toBeCloseTo(1);
    setCachedAspectRatio(url, 200, 100);
    expect(getCachedAspectRatio(url)).toBeCloseTo(2);
  });
});

describe('reservedAspectRatio', () => {
  it('falls back to the default for an unseen url', () => {
    expect(reservedAspectRatio('https://example.com/unseen-ratio.png')).toBe(
      DEFAULT_ASPECT_RATIO,
    );
  });

  it('returns the cached exact ratio once recorded', () => {
    const url = 'https://example.com/cached-ratio.png';
    setCachedAspectRatio(url, 640, 480);
    expect(reservedAspectRatio(url)).toBeCloseTo(640 / 480);
  });
});

describe('reservedBox', () => {
  it('maps each embed size to its EMBED_WIDTH cap', () => {
    const url = 'https://example.com/box-sizes.png';
    expect(reservedBox('sm', url).width).toBe(EMBED_WIDTH.sm);
    expect(reservedBox('md', url).width).toBe(EMBED_WIDTH.md);
    expect(reservedBox('lg', url).width).toBe(EMBED_WIDTH.lg);
    expect(reservedBox('full', url).width).toBe(EMBED_WIDTH.full);
  });

  it('reserves the default aspect ratio before any load has been recorded', () => {
    expect(reservedBox('lg', 'https://example.com/box-default.png')).toEqual({
      width: EMBED_WIDTH.lg,
      aspectRatio: DEFAULT_ASPECT_RATIO,
    });
  });

  it('reserves the cached exact aspect ratio once the url has loaded before', () => {
    const url = 'https://example.com/box-cached.png';
    setCachedAspectRatio(url, 1920, 1080);
    expect(reservedBox('md', url)).toEqual({
      width: EMBED_WIDTH.md,
      aspectRatio: 1920 / 1080,
    });
  });

  it('falls back to md width for an unrecognized size value', () => {
    const url = 'https://example.com/box-unknown-size.png';
    expect(reservedBox('huge' as unknown as Parameters<typeof reservedBox>[0], url).width).toBe(
      EMBED_WIDTH.md,
    );
  });
});
