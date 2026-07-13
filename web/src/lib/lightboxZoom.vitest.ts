import { describe, expect, it } from 'vitest';
import {
  LIGHTBOX_MAX_SCALE_FLOOR,
  LIGHTBOX_MIN_SCALE,
  clampPan,
  clampScale,
  fitToActualScale,
  maxZoomScale,
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

describe('fitToActualScale', () => {
  it('computes the ratio needed to reach natural pixel size', () => {
    // Natural image is 2x the displayed (fitted) box on the wider axis.
    expect(fitToActualScale({ width: 2000, height: 1000 }, { width: 1000, height: 800 })).toBe(2);
  });

  it('picks the larger-axis ratio so both dimensions reach actual size', () => {
    // Width ratio 2x, height ratio 3x — must use 3x or the height would
    // still be short of "actual" once width hits 100%.
    expect(fitToActualScale({ width: 2000, height: 3000 }, { width: 1000, height: 1000 })).toBe(3);
  });

  it('clamps to 1 when the image is already displayed larger than natural size (never shrinks below fit)', () => {
    expect(fitToActualScale({ width: 400, height: 300 }, { width: 800, height: 600 })).toBe(1);
  });

  it('returns the min scale when displayed size is not yet known (zero box)', () => {
    expect(fitToActualScale({ width: 2000, height: 1000 }, { width: 0, height: 0 })).toBe(
      LIGHTBOX_MIN_SCALE,
    );
  });
});

describe('maxZoomScale', () => {
  it('uses the actual-size ratio when it exceeds the floor', () => {
    expect(maxZoomScale({ width: 5000, height: 5000 }, { width: 500, height: 500 })).toBe(10);
  });

  it('uses the floor when the actual-size ratio is smaller than it', () => {
    // Actual-size ratio here is only 1.5x — the floor (4x) should win so a
    // modest image can still be pinch-zoomed meaningfully past "100%".
    expect(maxZoomScale({ width: 1500, height: 1500 }, { width: 1000, height: 1000 })).toBe(
      LIGHTBOX_MAX_SCALE_FLOOR,
    );
  });
});

describe('clampPan', () => {
  const displayed = { width: 400, height: 200 };

  it('forces pan to origin at or below the minimum scale (no room to pan when not zoomed)', () => {
    expect(clampPan({ x: 999, y: 999 }, 1, displayed)).toEqual({ x: 0, y: 0 });
    expect(clampPan({ x: 999, y: 999 }, 0.8, displayed)).toEqual({ x: 0, y: 0 });
  });

  it('passes pan through when within bounds', () => {
    // At scale 2, max offset is (400*1)/2=200 x, (200*1)/2=100 y.
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
