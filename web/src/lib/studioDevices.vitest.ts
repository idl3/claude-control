import { describe, it, expect } from 'vitest';
import {
  DEVICE_REGISTRY,
  DEVICE_CATEGORIES,
  DEFAULT_DEVICE_BY_CATEGORY,
  devicesByCategory,
  findDevice,
  orientedDims,
  studioLayoutMode,
  resolveSheetSnap,
  STUDIO_DOCK_MIN_WIDTH,
  studioEffectiveScale,
  zoomForEffectiveScale,
  zoomStep,
  panBounds,
  clampPan,
  panForFocalZoom,
  wheelZoomScale,
  ZOOM_MAX_SCALE,
  PAN_REVEAL_SLACK_PX,
  type DevicePreset,
} from './studioDevices';

describe('studioDevices — DEVICE_REGISTRY', () => {
  it('has exactly 17 devices: 6 phone, 5 tablet, 6 desktop', () => {
    expect(DEVICE_REGISTRY).toHaveLength(17);
    expect(devicesByCategory('phone')).toHaveLength(6);
    expect(devicesByCategory('tablet')).toHaveLength(5);
    expect(devicesByCategory('desktop')).toHaveLength(6);
  });

  it('has unique ids across the whole registry', () => {
    const ids = DEVICE_REGISTRY.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has positive integer width/height for every device', () => {
    for (const d of DEVICE_REGISTRY) {
      expect(Number.isInteger(d.width)).toBe(true);
      expect(Number.isInteger(d.height)).toBe(true);
      expect(d.width).toBeGreaterThan(0);
      expect(d.height).toBeGreaterThan(0);
    }
  });

  it('stores phone and tablet dims portrait (height > width)', () => {
    for (const d of [...devicesByCategory('phone'), ...devicesByCategory('tablet')]) {
      expect(d.height).toBeGreaterThan(d.width);
    }
  });

  it('stores desktop dims landscape (width > height)', () => {
    for (const d of devicesByCategory('desktop')) {
      expect(d.width).toBeGreaterThan(d.height);
    }
  });

  it('includes the exact iPhone 13/14 spec used as the phone default', () => {
    const iphone13 = findDevice('iphone-13');
    expect(iphone13).toEqual<DevicePreset>({
      id: 'iphone-13',
      name: 'iPhone 13/14',
      category: 'phone',
      width: 390,
      height: 844,
    });
  });

  it('includes the exact QHD 27" spec used for the heavily-scaled bezel check', () => {
    const qhd = findDevice('qhd-27');
    expect(qhd).toEqual<DevicePreset>({
      id: 'qhd-27',
      name: 'QHD 27"',
      category: 'desktop',
      width: 2560,
      height: 1440,
    });
  });

  it('findDevice returns undefined for an unknown id', () => {
    expect(findDevice('nonexistent-device')).toBeUndefined();
  });
});

describe('studioDevices — DEFAULT_DEVICE_BY_CATEGORY', () => {
  it('picks a real, correctly-categorized device for every category', () => {
    for (const category of DEVICE_CATEGORIES) {
      const id = DEFAULT_DEVICE_BY_CATEGORY[category];
      const device = findDevice(id);
      expect(device).toBeDefined();
      expect(device?.category).toBe(category);
    }
  });

  it('defaults to iphone-13 / ipad-pro-11 / laptop per spec', () => {
    expect(DEFAULT_DEVICE_BY_CATEGORY.phone).toBe('iphone-13');
    expect(DEFAULT_DEVICE_BY_CATEGORY.tablet).toBe('ipad-pro-11');
    expect(DEFAULT_DEVICE_BY_CATEGORY.desktop).toBe('laptop');
  });
});

describe('studioDevices — orientedDims', () => {
  it('phone portrait returns the stored dims unchanged', () => {
    const iphone13 = findDevice('iphone-13')!;
    expect(orientedDims(iphone13, 'portrait')).toEqual({ width: 390, height: 844 });
  });

  it('phone landscape swaps width/height', () => {
    const iphone13 = findDevice('iphone-13')!;
    expect(orientedDims(iphone13, 'landscape')).toEqual({ width: 844, height: 390 });
  });

  it('tablet portrait returns the stored dims unchanged', () => {
    const ipadPro11 = findDevice('ipad-pro-11')!;
    expect(orientedDims(ipadPro11, 'portrait')).toEqual({ width: 834, height: 1194 });
  });

  it('tablet landscape swaps width/height', () => {
    const ipadPro11 = findDevice('ipad-pro-11')!;
    expect(orientedDims(ipadPro11, 'landscape')).toEqual({ width: 1194, height: 834 });
  });

  it('desktop ignores orientation and always returns the stored (landscape) dims', () => {
    const laptop = findDevice('laptop')!;
    expect(orientedDims(laptop, 'portrait')).toEqual({ width: 1280, height: 800 });
    expect(orientedDims(laptop, 'landscape')).toEqual({ width: 1280, height: 800 });
  });
});

describe('studioDevices — studioLayoutMode', () => {
  it('exposes 720 as the dock/sheet breakpoint constant', () => {
    expect(STUDIO_DOCK_MIN_WIDTH).toBe(720);
  });

  it('390 (phone) resolves to sheet', () => {
    expect(studioLayoutMode(390)).toBe('sheet');
  });

  it('719 (one px below the breakpoint) resolves to sheet', () => {
    expect(studioLayoutMode(719)).toBe('sheet');
  });

  it('720 (exactly the breakpoint) resolves to dock', () => {
    expect(studioLayoutMode(720)).toBe('dock');
  });

  it('834 (iPad landscape width) resolves to dock', () => {
    expect(studioLayoutMode(834)).toBe('dock');
  });

  it('1600 (desktop) resolves to dock', () => {
    expect(studioLayoutMode(1600)).toBe('dock');
  });
});

describe('studioDevices — resolveSheetSnap', () => {
  const collapsedOffset = 600;

  it('a fast downward flick (velocity >= 0.5 px/ms, positive) always snaps to collapsed, regardless of position near the top', () => {
    expect(resolveSheetSnap({ offset: 10, collapsedOffset, velocity: 0.6 })).toBe('collapsed');
  });

  it('a fast upward flick (velocity <= -0.5 px/ms) always snaps to expanded, regardless of position near the bottom', () => {
    expect(resolveSheetSnap({ offset: 590, collapsedOffset, velocity: -0.6 })).toBe('expanded');
  });

  it('velocity exactly at the threshold (0.5) counts as fast and follows direction', () => {
    expect(resolveSheetSnap({ offset: 590, collapsedOffset, velocity: 0.5 })).toBe('collapsed');
    expect(resolveSheetSnap({ offset: 10, collapsedOffset, velocity: -0.5 })).toBe('expanded');
  });

  it('a slow release closer to the top snaps to expanded (nearest-by-position)', () => {
    expect(resolveSheetSnap({ offset: 100, collapsedOffset, velocity: 0.1 })).toBe('expanded');
  });

  it('a slow release closer to the bottom snaps to collapsed (nearest-by-position)', () => {
    expect(resolveSheetSnap({ offset: 500, collapsedOffset, velocity: -0.1 })).toBe('collapsed');
  });

  it('a slow release exactly at the midpoint deterministically resolves to collapsed', () => {
    expect(resolveSheetSnap({ offset: collapsedOffset / 2, collapsedOffset, velocity: 0 })).toBe('collapsed');
  });

  it('zero velocity at the very top resolves to expanded', () => {
    expect(resolveSheetSnap({ offset: 0, collapsedOffset, velocity: 0 })).toBe('expanded');
  });

  it('zero velocity at the very bottom resolves to collapsed', () => {
    expect(resolveSheetSnap({ offset: collapsedOffset, collapsedOffset, velocity: 0 })).toBe('collapsed');
  });
});

describe('studioDevices — studioEffectiveScale (effective = fitScale × zoom)', () => {
  it('zoom 1 is exactly Fit (effective === fitScale)', () => {
    expect(studioEffectiveScale(0.47, 1)).toBeCloseTo(0.47, 10);
    expect(studioEffectiveScale(1, 1)).toBe(1);
  });

  it('multiplies fitScale by zoom', () => {
    expect(studioEffectiveScale(0.5, 2)).toBeCloseTo(1, 10);
    expect(studioEffectiveScale(0.25, 4)).toBeCloseTo(1, 10);
  });

  it('floors at fitScale — never below Fit', () => {
    expect(studioEffectiveScale(0.47, 0.5)).toBeCloseTo(0.47, 10);
    expect(studioEffectiveScale(0.47, 0)).toBeCloseTo(0.47, 10);
  });

  it('ceils at ZOOM_MAX_SCALE (300%)', () => {
    expect(studioEffectiveScale(0.5, 100)).toBe(ZOOM_MAX_SCALE);
    expect(studioEffectiveScale(1, 10)).toBe(ZOOM_MAX_SCALE);
  });
});

describe('studioDevices — zoomForEffectiveScale (inverse)', () => {
  it('round-trips with studioEffectiveScale', () => {
    const fit = 0.47;
    for (const eff of [0.47, 0.5, 0.75, 1, 2, 3]) {
      const zoom = zoomForEffectiveScale(fit, eff);
      expect(studioEffectiveScale(fit, zoom)).toBeCloseTo(eff, 10);
    }
  });

  it('effective 1.0 (100%) maps to zoom = 1/fitScale', () => {
    expect(zoomForEffectiveScale(0.5, 1)).toBeCloseTo(2, 10);
  });

  it('clamps out-of-band effective into [fitScale, max] before inverting', () => {
    expect(zoomForEffectiveScale(0.5, 0.1)).toBeCloseTo(1, 10); // below Fit -> Fit
    expect(zoomForEffectiveScale(0.5, 99)).toBeCloseTo(ZOOM_MAX_SCALE / 0.5, 10); // above max -> max
  });
});

describe('studioDevices — zoomStep (−/+ snap to 25% grid)', () => {
  const fit = 0.47;

  it('+ from Fit snaps up to the first grid step above fit', () => {
    const z = zoomStep(fit, 1, 1);
    expect(studioEffectiveScale(fit, z)).toBeCloseTo(0.5, 10);
  });

  it('+ walks the 25% grid: 0.5 -> 0.75 -> 1.0', () => {
    const z1 = zoomForEffectiveScale(fit, 0.5);
    const z2 = zoomStep(fit, z1, 1);
    expect(studioEffectiveScale(fit, z2)).toBeCloseTo(0.75, 10);
    const z3 = zoomStep(fit, z2, 1);
    expect(studioEffectiveScale(fit, z3)).toBeCloseTo(1.0, 10);
  });

  it('− from a grid step drops to the previous grid step', () => {
    const z = zoomForEffectiveScale(fit, 1.0);
    expect(studioEffectiveScale(fit, zoomStep(fit, z, -1))).toBeCloseTo(0.75, 10);
  });

  it('− that would fall below Fit resolves to Fit (zoom 1)', () => {
    const z = zoomForEffectiveScale(fit, 0.5); // one grid step above fit(0.47)
    expect(zoomStep(fit, z, -1)).toBeCloseTo(1, 10); // -> Fit
  });

  it('− at Fit stays at Fit', () => {
    expect(zoomStep(fit, 1, -1)).toBeCloseTo(1, 10);
  });

  it('+ never exceeds the 300% ceiling', () => {
    const z = zoomForEffectiveScale(fit, 3);
    expect(studioEffectiveScale(fit, zoomStep(fit, z, 1))).toBe(ZOOM_MAX_SCALE);
  });
});

describe('studioDevices — panBounds / clampPan', () => {
  it('is zero on an axis that does not overflow the viewport (frame stays centered)', () => {
    const b = panBounds({ x: 800, y: 600 }, { x: 1000, y: 800 });
    expect(b).toEqual({ x: 0, y: 0 });
    const clamped = clampPan({ x: 200, y: -50 }, { x: 800, y: 600 }, { x: 1000, y: 800 });
    expect(clamped.x).toBe(0);
    expect(Math.abs(clamped.y)).toBe(0); // no pan on a non-overflowing axis (±0 both fine)
  });

  it('allows half the overflow plus the reveal slack on an overflowing axis', () => {
    const b = panBounds({ x: 2000, y: 3000 }, { x: 1000, y: 800 });
    expect(b.x).toBeCloseTo((2000 - 1000) / 2 + PAN_REVEAL_SLACK_PX, 10);
    expect(b.y).toBeCloseTo((3000 - 800) / 2 + PAN_REVEAL_SLACK_PX, 10);
  });

  it('clamps an out-of-range pan back within bounds', () => {
    const fp = { x: 2000, y: 800 };
    const vp = { x: 1000, y: 800 };
    const b = panBounds(fp, vp);
    expect(clampPan({ x: 99999, y: 10 }, fp, vp)).toEqual({ x: b.x, y: 0 });
    expect(clampPan({ x: -99999, y: 0 }, fp, vp)).toEqual({ x: -b.x, y: 0 });
  });
});

describe('studioDevices — panForFocalZoom (zoom-to-cursor keeps focal fixed)', () => {
  // The invariant: the screen position of the content point under the focal
  // point is unchanged across the zoom. Screen position of that point =
  // frameCenter + (scale/scale0)·(pointScreen0 − frameCenter0), and here we
  // assert the algebraic identity the component relies on.
  it('a focal point at the stage center leaves pan unchanged (center-anchored zoom)', () => {
    expect(panForFocalZoom({ x: 30, y: -20 }, 1, 2, { x: 0, y: 0 })).toEqual({ x: 60, y: -40 });
  });

  it('keeps the focal point stationary: focal − pan scales by k about the focal', () => {
    const pan = { x: 40, y: 10 };
    const s0 = 1;
    const s1 = 2;
    const focal = { x: 100, y: 50 };
    const pan2 = panForFocalZoom(pan, s0, s1, focal);
    // vector from (stage-center + pan) to focal, before and after, must scale by k
    const before = { x: focal.x - pan.x, y: focal.y - pan.y };
    const after = { x: focal.x - pan2.x, y: focal.y - pan2.y };
    expect(after.x).toBeCloseTo((s1 / s0) * before.x, 10);
    expect(after.y).toBeCloseTo((s1 / s0) * before.y, 10);
  });

  it('is a no-op when the scale does not change (k = 1)', () => {
    expect(panForFocalZoom({ x: 12, y: -7 }, 1.5, 1.5, { x: 200, y: 90 })).toEqual({ x: 12, y: -7 });
  });
});

describe('studioDevices — wheelZoomScale (continuous ⌘/pinch zoom)', () => {
  it('negative deltaY (wheel up / pinch out) zooms in', () => {
    expect(wheelZoomScale(1, -100, 0.47, 3)).toBeGreaterThan(1);
  });

  it('positive deltaY zooms out', () => {
    expect(wheelZoomScale(1, 100, 0.47, 3)).toBeLessThan(1);
  });

  it('clamps to [minScale, maxScale] (i.e. [fitScale, 3])', () => {
    expect(wheelZoomScale(2.9, -100000, 0.47, 3)).toBe(3);
    expect(wheelZoomScale(0.6, 100000, 0.47, 3)).toBe(0.47);
  });
});
