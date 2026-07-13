/**
 * Pure zoom/pan math for the transcript image Lightbox (AttachmentPreview.tsx
 * — see the Lightbox component). Kept DOM-free and dependency-free so the
 * gesture arithmetic is trivially unit-testable in isolation from React and
 * touch/mouse event wiring — see lightboxZoom.vitest.ts.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** "Fit" — the image's natural, un-zoomed displayed size (CSS max-width/
 * max-height letterboxing already applied, before any transform: scale). */
export const LIGHTBOX_MIN_SCALE = 1;

/** Zoom ceiling floor when the image is already small relative to its
 * displayed box (actual-size ratio <= 1) — always allow zooming in at least
 * this far past "fit" rather than capping at exactly 100%. */
export const LIGHTBOX_MAX_SCALE_FLOOR = 4;

export function clampScale(scale: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, scale));
}

/**
 * Scale factor from "fit" (scale 1) to "actual pixels" (1 image px = 1
 * screen px) — the double-tap/double-click/toolbar "100%" target. If the
 * image's natural size is already <= its displayed size (a small image
 * stretched to fill its frame), the true actual-size ratio would be a
 * DOWNSCALE (< 1); clamp to 1 so toggling "100%" never shrinks below fit.
 */
export function fitToActualScale(natural: Size, displayed: Size): number {
  if (displayed.width <= 0 || displayed.height <= 0) return LIGHTBOX_MIN_SCALE;
  const ratio = Math.max(natural.width / displayed.width, natural.height / displayed.height);
  return Math.max(LIGHTBOX_MIN_SCALE, ratio);
}

/** Upper pinch/wheel zoom bound: whichever is larger of the actual-size
 * ratio or the floor — so a tiny image can still be zoomed in meaningfully
 * past exactly 100%, while a huge image isn't artificially capped at 4x. */
export function maxZoomScale(natural: Size, displayed: Size): number {
  return Math.max(fitToActualScale(natural, displayed), LIGHTBOX_MAX_SCALE_FLOOR);
}

/**
 * Hard-clamps pan (in screen px) so the scaled image can never reveal empty
 * space beyond its own edges — no rubber-banding, just a firm bound. At
 * `scale`, the image occupies `scale`x its displayed box around its own
 * (untranslated) center, so the max offset per axis is half the extra size
 * the zoom introduced. At scale <= 1 there's no room to pan at all.
 */
export function clampPan(pan: Point, scale: number, displayed: Size): Point {
  if (scale <= LIGHTBOX_MIN_SCALE) return { x: 0, y: 0 };
  const maxX = (displayed.width * (scale - 1)) / 2;
  const maxY = (displayed.height * (scale - 1)) / 2;
  return {
    x: clampScale(pan.x, -maxX, maxX),
    y: clampScale(pan.y, -maxY, maxY),
  };
}

/** Euclidean distance between two touch points — pinch scale delta. */
export function touchDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Midpoint between two touch points — pinch pan anchor, so a two-finger
 * pinch that also drifts sideways pans the image along with the fingers
 * instead of only rescaling around a fixed center. */
export function touchMidpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
