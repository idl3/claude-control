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

// ── Canvas zoom + pan ───────────────────────────────────────────────────────
// Prototype Studio canvas navigation. All pure + side-effect-free (same
// unit-testable convention as studioFitScale / resolveSheetSnap above).
//
// How this feeds the existing display machinery (the whole point — reuse, not a
// parallel transform system): StudioModal computes `fitScale`
// (studioFitScale) exactly as before, then the EFFECTIVE display scale is
// `fitScale × zoom`. That single number replaces `fitScale` at the ONE site
// that already consumed it — sizing the `.studio-frame` footprint box, and
// (via EmbeddedApp's logicalWidth/Height data-attrs) driving AppFrameLayer's
// `hoistGeometry` `scale = rect.width / logicalWidth`. So the hosted iframe
// always renders at the device's TRUE logical dims and only its DISPLAY scale
// changes — never a reload, pure transform. `pan` is a translate applied to
// the footprint container; the `.studio-frame` placeholder rect shifts and
// AppFrameLayer's rect-based positioning tracks it for free.

/** Effective-scale ceiling (300% of true device px). `fitScale` is always the
 *  floor — "− never below Fit". */
export const ZOOM_MAX_SCALE = 3;
/** The −/+ buttons snap the effective scale to this grid (25%). */
export const ZOOM_SNAP = 0.25;
/** Pan clamp: at maximum pan on an overflowing axis, this many px of empty
 *  canvas remain beyond the fully-revealed frame edge — so a zoomed-in frame
 *  can always be dragged to expose any region AND some grabbable void survives
 *  for the next drag, without ever letting the frame fly fully out of view. */
export const PAN_REVEAL_SLACK_PX = 140;

export interface Vec2 {
  x: number;
  y: number;
}

function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Effective display scale = `fitScale × zoom`, clamped to
 * `[fitScale, maxScale]`. `zoom === 1` is always exactly "Fit"
 * (effective === fitScale); the floor never drops below Fit and the ceiling is
 * `maxScale` (300% device px). `studioFitScale` already caps fitScale at 1, so
 * effective ∈ [fitScale, 3].
 */
export function studioEffectiveScale(fitScale: number, zoom: number, maxScale = ZOOM_MAX_SCALE): number {
  if (fitScale <= 0) return fitScale;
  const hi = Math.max(fitScale, maxScale);
  return clampNum(fitScale * zoom, fitScale, hi);
}

/**
 * Inverse of {@link studioEffectiveScale}: the `zoom` multiplier that yields a
 * given effective scale, clamped into the legal band. Continuous gestures
 * (⌘/ctrl-wheel, pinch) and the 100% toggle think in effective-scale terms and
 * convert back through here before storing `zoom`.
 */
export function zoomForEffectiveScale(fitScale: number, effectiveScale: number, maxScale = ZOOM_MAX_SCALE): number {
  if (fitScale <= 0) return 1;
  const hi = Math.max(fitScale, maxScale);
  return clampNum(effectiveScale, fitScale, hi) / fitScale;
}

/**
 * −/+ button step: snap the current effective scale to the next (`dir = 1`) or
 * previous (`dir = -1`) {@link ZOOM_SNAP} grid step, floored at Fit
 * (`fitScale`) and ceiled at `maxScale`. A step-down that would land below Fit
 * resolves to Fit (zoom 1). Returns the new `zoom` multiplier.
 */
export function zoomStep(
  fitScale: number,
  currentZoom: number,
  dir: 1 | -1,
  snap = ZOOM_SNAP,
  maxScale = ZOOM_MAX_SCALE,
): number {
  const eff = studioEffectiveScale(fitScale, currentZoom, maxScale);
  const EPS = 1e-4;
  const raw =
    dir > 0
      ? (Math.floor(eff / snap + EPS) + 1) * snap // smallest grid step strictly above
      : (Math.ceil(eff / snap - EPS) - 1) * snap; // largest grid step strictly below
  const hi = Math.max(fitScale, maxScale);
  const target = clampNum(raw, fitScale, hi);
  return zoomForEffectiveScale(fitScale, target, maxScale);
}

/**
 * Per-axis max |pan| in px. Zero when the footprint doesn't overflow the
 * viewport on that axis (the frame stays centered — pan is a no-op at Fit).
 * When it overflows, `overflow / 2` lets the near edge reach the viewport edge
 * (whole hidden region reachable) and {@link PAN_REVEAL_SLACK_PX} adds the void
 * strip that keeps a drag surface grabbable.
 */
export function panBounds(footprint: Vec2, viewport: Vec2, slack = PAN_REVEAL_SLACK_PX): Vec2 {
  return { x: axisPanBound(footprint.x, viewport.x, slack), y: axisPanBound(footprint.y, viewport.y, slack) };
}

function axisPanBound(fp: number, vp: number, slack: number): number {
  const overflow = fp - vp;
  if (overflow <= 0) return 0;
  return overflow / 2 + slack;
}

/** Clamp a pan vector to {@link panBounds}. StudioModal renders the clamped
 *  value every frame, so a device/zoom change that shrinks the bounds pulls a
 *  now-out-of-range pan back into view automatically. */
export function clampPan(pan: Vec2, footprint: Vec2, viewport: Vec2, slack = PAN_REVEAL_SLACK_PX): Vec2 {
  const b = panBounds(footprint, viewport, slack);
  return { x: clampNum(pan.x, -b.x, b.x), y: clampNum(pan.y, -b.y, b.y) };
}

/**
 * Zoom-to-focal-point: given a zoom change from effective scale `s0` → `s1`
 * about a `focal` point (px, relative to the stage CENTER), return the new pan
 * that keeps the focal point visually fixed. Classic formula —
 * `pan' = focal·(1 − k) + k·pan`, `k = s1 / s0` — derived from holding the
 * frame-center-to-focal vector's content point stationary across the scale
 * change. Caller clamps the result via {@link clampPan}.
 */
export function panForFocalZoom(pan: Vec2, s0: number, s1: number, focal: Vec2): Vec2 {
  if (s0 <= 0) return pan;
  const k = s1 / s0;
  return { x: focal.x * (1 - k) + k * pan.x, y: focal.y * (1 - k) + k * pan.y };
}

/**
 * Continuous (⌘/ctrl-wheel, trackpad-pinch) target effective scale: exponential
 * in wheel delta so equal notches feel like equal zoom ratios, clamped to
 * `[minScale, maxScale]` (i.e. `[fitScale, 3]`). Negative `deltaY` (wheel up /
 * pinch out) zooms in.
 */
export function wheelZoomScale(
  s0: number,
  deltaY: number,
  minScale: number,
  maxScale: number,
  rate = 0.0018,
): number {
  return clampNum(s0 * Math.exp(-deltaY * rate), minScale, Math.max(minScale, maxScale));
}
