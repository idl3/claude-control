import { describe, expect, it } from 'vitest';
import { buildFishSwim, nextFishDelayMs, pickFishDepth } from './ambientFish';

describe('underwater ambient fish', () => {
  it('selects all depth planes deterministically', () => {
    expect(pickFishDepth(() => 0)).toBe('near');
    expect(pickFishDepth(() => 0.5)).toBe('mid');
    expect(pickFishDepth(() => 0.99)).toBe('far');
  });

  it('builds a slow, bounded crossing within the visible water column', () => {
    const swim = buildFishSwim('mid', () => 0.5);
    expect(swim.travelXvw).toBeGreaterThan(100);
    expect(swim.durationMs).toBeGreaterThan(8_000);
    expect(swim.topPercent).toBeGreaterThanOrEqual(14);
    expect(swim.topPercent).toBeLessThanOrEqual(82);
  });

  it('waits at least 45 seconds between ambient crossings', () => {
    expect(nextFishDelayMs(() => 0)).toBeGreaterThanOrEqual(45_000);
    expect(nextFishDelayMs(() => 1)).toBeLessThanOrEqual(125_000);
  });
});
