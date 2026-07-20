// Locks computeScreenH's orientation-aware selection regardless of how (or
// whether) a given test/browser environment emulates iOS's orientation-blind
// window.screen.height. See screenHeight.ts's doc comment for the bug this
// guards against: iPad landscape's .app column pinned to the taller portrait
// height, pushing the composer + sidebar rail-footer off-screen.
import { describe, it, expect } from 'vitest';
import { computeScreenH } from './screenHeight';

describe('computeScreenH (pure)', () => {
  it('landscape: picks the SHORT edge, given screen.width/height in portrait order (width < height)', () => {
    // e.g. an iPad reporting its native portrait screen.width=834, screen.height=1194
    // (orientation-blind — does not swap on rotation) while the device is actually
    // in landscape. The correct landscape height is the short edge, 834.
    expect(computeScreenH(834, 1194, true)).toBe(834);
  });

  it('landscape: picks the SHORT edge, given screen.width/height already swapped (width > height)', () => {
    // A platform that DOES swap screen.width/height on rotation would report
    // width=1194, height=834 in landscape — computeScreenH must still land on
    // the short edge (834), not just always return the second argument.
    expect(computeScreenH(1194, 834, true)).toBe(834);
  });

  it('portrait: picks the LONG edge, given screen.width/height in native portrait order', () => {
    expect(computeScreenH(834, 1194, false)).toBe(1194);
  });

  it('portrait: picks the LONG edge, given screen.width/height already swapped', () => {
    expect(computeScreenH(1194, 834, false)).toBe(1194);
  });

  it('iPhone 15 Pro dimensions: portrait height is the long edge', () => {
    expect(computeScreenH(393, 852, false)).toBe(852);
  });

  it('iPhone 15 Pro dimensions: landscape height is the short edge', () => {
    expect(computeScreenH(393, 852, true)).toBe(393);
  });

  it('square screen: both branches return the same (only) value', () => {
    expect(computeScreenH(1000, 1000, true)).toBe(1000);
    expect(computeScreenH(1000, 1000, false)).toBe(1000);
  });
});
