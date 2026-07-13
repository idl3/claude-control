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
