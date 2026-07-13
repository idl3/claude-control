// Prototype Studio — device-preset registry + pure layout/gesture helpers.
//
// Kept dependency-free and side-effect-free so it can be unit tested directly
// (mirrors the existing exported-pure-helper convention set by
// `studioFitScale` / `studioAvailableWidth` in StudioModal.tsx). StudioModal
// imports this module for the device picker, orientation toggle, the
// dock-vs-sheet inspector breakpoint, and the phone drag-to-snap gesture.

export type DeviceCategory = 'phone' | 'tablet' | 'desktop';
export type Orientation = 'portrait' | 'landscape';

export interface DevicePreset {
  id: string;
  name: string;
  category: DeviceCategory;
  /** CSS logical px. Phone/tablet dims are stored PORTRAIT; desktop dims are stored LANDSCAPE. */
  width: number;
  height: number;
}

// Widths/heights are CSS logical px (not device px) — matches how
// `studioFitScale`/`EmbeddedApp`'s logicalWidth/logicalHeight already treat
// device dimensions elsewhere in StudioModal.tsx.
export const DEVICE_REGISTRY: DevicePreset[] = [
  // Phone — portrait-stored
  { id: 'iphone-se', name: 'iPhone SE', category: 'phone', width: 375, height: 667 },
  { id: 'iphone-13', name: 'iPhone 13/14', category: 'phone', width: 390, height: 844 },
  { id: 'iphone-15-pro', name: 'iPhone 15/16 Pro', category: 'phone', width: 393, height: 852 },
  { id: 'iphone-16-pro-max', name: 'iPhone 16 Pro Max', category: 'phone', width: 440, height: 956 },
  { id: 'pixel-8', name: 'Pixel 8', category: 'phone', width: 412, height: 915 },
  { id: 'galaxy-s24', name: 'Galaxy S24', category: 'phone', width: 384, height: 832 },

  // Tablet — portrait-stored
  { id: 'ipad-mini', name: 'iPad mini', category: 'tablet', width: 744, height: 1133 },
  { id: 'ipad-10', name: 'iPad (10.9")', category: 'tablet', width: 820, height: 1180 },
  { id: 'ipad-pro-11', name: 'iPad Pro 11"', category: 'tablet', width: 834, height: 1194 },
  { id: 'ipad-pro-13', name: 'iPad Pro 13"', category: 'tablet', width: 1024, height: 1366 },
  { id: 'galaxy-tab-s9', name: 'Galaxy Tab S9', category: 'tablet', width: 800, height: 1280 },

  // Desktop — landscape-stored, orientation-locked
  { id: 'laptop', name: 'Laptop', category: 'desktop', width: 1280, height: 800 },
  { id: 'mba-13', name: 'MacBook Air 13"', category: 'desktop', width: 1440, height: 900 },
  { id: 'mbp-14', name: 'MacBook Pro 14"', category: 'desktop', width: 1512, height: 982 },
  { id: 'mbp-16', name: 'MacBook Pro 16"', category: 'desktop', width: 1728, height: 1117 },
  { id: 'fhd', name: 'FHD 1080p', category: 'desktop', width: 1920, height: 1080 },
  { id: 'qhd-27', name: 'QHD 27"', category: 'desktop', width: 2560, height: 1440 },
];

export const DEVICE_CATEGORIES: DeviceCategory[] = ['phone', 'tablet', 'desktop'];

export const DEFAULT_DEVICE_BY_CATEGORY: Record<DeviceCategory, string> = {
  phone: 'iphone-13',
  tablet: 'ipad-pro-11',
  desktop: 'laptop',
};

export function devicesByCategory(category: DeviceCategory): DevicePreset[] {
  return DEVICE_REGISTRY.filter((d) => d.category === category);
}

export function findDevice(id: string): DevicePreset | undefined {
  return DEVICE_REGISTRY.find((d) => d.id === id);
}

// Desktop presets are landscape-stored and orientation-locked (the toggle is
// disabled for that category in the toolbar). Phone/tablet presets are
// portrait-stored; 'landscape' swaps width/height.
export function orientedDims(preset: DevicePreset, orientation: Orientation): { width: number; height: number } {
  if (preset.category === 'desktop' || orientation === 'portrait') {
    return { width: preset.width, height: preset.height };
  }
  return { width: preset.height, height: preset.width };
}

// Dock (side-by-side live preview + inspector) vs sheet (bottom drawer over
// the live preview) — decided purely by Studio's own viewport width, never by
// pointer type. Mirrored by the `@media (max-width: 719px)` rule in
// styles.css — keep both in sync (see the cross-reference comments at both
// call sites).
export const STUDIO_DOCK_MIN_WIDTH = 720;

export function studioLayoutMode(viewportWidth: number): 'dock' | 'sheet' {
  return viewportWidth >= STUDIO_DOCK_MIN_WIDTH ? 'dock' : 'sheet';
}

export interface SheetSnapInput {
  /** Current translateY offset in px; 0 = fully expanded, collapsedOffset = fully collapsed. */
  offset: number;
  /** The translateY offset at rest when collapsed (sheetHeight - peekHeight). */
  collapsedOffset: number;
  /** Instantaneous drag velocity in px/ms; positive = moving down (toward collapsed). */
  velocity: number;
}

// A fast flick (>= this many px/ms) always follows its direction; a slow
// release resolves to whichever end the sheet is nearer.
const SHEET_SNAP_VELOCITY_THRESHOLD = 0.5;

export function resolveSheetSnap({ offset, collapsedOffset, velocity }: SheetSnapInput): 'expanded' | 'collapsed' {
  if (Math.abs(velocity) >= SHEET_SNAP_VELOCITY_THRESHOLD) {
    return velocity > 0 ? 'collapsed' : 'expanded';
  }
  return offset < collapsedOffset / 2 ? 'expanded' : 'collapsed';
}
