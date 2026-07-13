import { describe, expect, it } from 'vitest';
import {
  LIGHTBOX_MAX_SCALE,
  LIGHTBOX_MIN_SCALE,
  clampPan,
  clampScale,
  fitScale,
  nextZoomStep,
  touchDistance,
  touchMidpoint,
} from './lightboxZoom';

describe('clampScale', () => {
  it('passes values already inside the range through unchanged', () => {
    expect(clampScale(2, 1, 4)).toBe(2);
  });

  it('clamps below the minimum', () => {
    expect(clampScale(0.4, 1, 4)).toBe(1);
  });

  it('clamps above the maximum', () => {
    expect(clampScale(9, 1, 4)).toBe(4);
  });
});

describe('fitScale', () => {
  it('computes the ratio of displayed (fitted) box to natural size', () => {
    // Displayed box is half the natural width — "Fit" is 50% of actual pixels.
    expect(fitScale({ width: 2000, height: 1000 }, { width: 1000, height: 500 })).toBe(0.5);
  });

  it('clamps to 1 when the displayed box is not smaller than natural size (Fit never exceeds 100%)', () => {
    expect(fitScale({ width: 400, height: 300 }, { width: 800, height: 600 })).toBe(1);
  });

  it('returns 1 when sizes are not yet known (zero box, before image load)', () => {
    expect(fitScale({ width: 2000, height: 1000 }, { width: 0, height: 0 })).toBe(1);
    expect(fitScale({ width: 0, height: 0 }, { width: 0, height: 0 })).toBe(1);
  });
});

describe('nextZoomStep', () => {
  it('steps up by exactly one 25% grid unit from an on-grid value', () => {
    expect(nextZoomStep(0.5, 1)).toBe(0.75);
  });

  it('steps down by exactly one 25% grid unit from an on-grid value', () => {
    expect(nextZoomStep(0.5, -1)).toBe(0.25);
  });

  it('always advances at least one full step from an exact grid value (never a no-op)', () => {
    expect(nextZoomStep(1, 1)).toBe(1.25);
    expect(nextZoomStep(1, -1)).toBe(0.75);
  });

  it('snaps an off-grid value (left by continuous pinch/wheel zoom) to the nearest stop past it', () => {
    // 42% up -> the next stop strictly above it, 50%.
    expect(nextZoomStep(0.42, 1)).toBeCloseTo(0.5, 10);
    // 42% down -> the next stop strictly below it, 25%.
    expect(nextZoomStep(0.42, -1)).toBeCloseTo(0.25, 10);
  });

  it('holds at the floor once stepping down would go below it', () => {
    expect(nextZoomStep(LIGHTBOX_MIN_SCALE, -1)).toBe(LIGHTBOX_MIN_SCALE);
  });

  it('holds at the ceiling once stepping up would exceed it', () => {
    expect(nextZoomStep(LIGHTBOX_MAX_SCALE, 1)).toBe(LIGHTBOX_MAX_SCALE);
  });

  it('clamps a below-floor or above-ceiling input into range before stepping', () => {
    expect(nextZoomStep(0.1, -1)).toBe(LIGHTBOX_MIN_SCALE);
    expect(nextZoomStep(5, 1)).toBe(LIGHTBOX_MAX_SCALE);
  });
});

describe('clampPan', () => {
  const displayed = { width: 400, height: 200 };

  it('forces pan to origin at or below cssScale 1 (no room to pan when not zoomed past Fit)', () => {
    expect(clampPan({ x: 999, y: 999 }, 1, displayed)).toEqual({ x: 0, y: 0 });
    expect(clampPan({ x: 999, y: 999 }, 0.8, displayed)).toEqual({ x: 0, y: 0 });
  });

  it('passes pan through when within bounds', () => {
    // At cssScale 2, max offset is (400*1)/2=200 x, (200*1)/2=100 y.
    expect(clampPan({ x: 50, y: -30 }, 2, displayed)).toEqual({ x: 50, y: -30 });
  });

  it('clamps pan to the edge in both directions independently per axis', () => {
    expect(clampPan({ x: 500, y: -500 }, 2, displayed)).toEqual({ x: 200, y: -100 });
  });
});

describe('touchDistance', () => {
  it('computes straight-line distance between two points', () => {
    expect(touchDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});

describe('touchMidpoint', () => {
  it('computes the average of two points', () => {
    expect(touchMidpoint({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 });
  });
});
