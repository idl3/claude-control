/**
 * Pure zoom/pan math for the transcript image Lightbox (AttachmentPreview.tsx
 * — see the Lightbox component). Kept DOM-free and dependency-free so the
 * gesture arithmetic is trivially unit-testable in isolation from React and
 * touch/mouse event wiring — see lightboxZoom.vitest.ts.
 *
 * ── Scale model ──────────────────────────────────────────────────────────
 * All "scale" values the Lightbox exposes to the user (`scaleRef`/
 * `renderScale`, the toolbar label, the manual zoom bounds, the +/- step
 * grid, pinch/wheel) are EFFECTIVE scale: a fraction of the image's own
 * NATURAL pixels, where 1.0 = "100%" = 1 image px = 1 screen px — matching
 * what the toolbar label shows. That is deliberately NOT the multiplier fed
 * to the img's `transform: scale()`: the img's CSS box is already laid out
 * at "Fit" size (max-width/max-height letterboxing in styles.css), so the
 * actual CSS multiplier is `effectiveScale / fitScale(natural, displayed)`
 * ("cssScale"). Only the render path (AttachmentPreview.tsx) converts
 * between the two spaces; clampPan below intentionally takes cssScale (its
 * "is there pan room" question is about the rendered box, not natural
 * pixels) — every other export in this module works in effectiveScale.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Manual zoom floor — 25% of the image's natural pixels. Below 100% a
 * large image can render smaller than its own "Fit" letterboxed size; the
 * bound is always relative to natural pixels, not to Fit. */
export const LIGHTBOX_MIN_SCALE = 0.25;

/** Manual zoom ceiling — 300% of the image's natural pixels. Flat for every
 * image, no longer size-dependent (replaces the old
 * LIGHTBOX_MAX_SCALE_FLOOR/maxZoomScale pair). */
export const LIGHTBOX_MAX_SCALE = 3;

/** Grid spacing for the +/- toolbar buttons' discrete steps (25%, 50%, …,
 * 300%) — see nextZoomStep. Pinch/wheel zoom stays continuous and does not
 * use this grid. */
export const ZOOM_STEP = 0.25;

export function clampScale(scale: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, scale));
}

/**
 * Effective scale (relative to natural pixels — see module docs) at which
 * the image exactly fills its own CSS-computed "Fit" box, i.e. "Fit"
 * expressed in the same units the toolbar label and manual-zoom bounds use.
 * Always <= 1: the img's CSS (width:auto;height:auto;max-width:100%;
 * max-height:90dvh, see styles.css) never upscales past natural size, so
 * `displayed` can only be smaller than or equal to `natural`. Returns 1
 * (rather than dividing by zero) before the image has loaded / laid out.
 */
export function fitScale(natural: Size, displayed: Size): number {
  if (natural.width <= 0 || displayed.width <= 0) return 1;
  return Math.min(1, displayed.width / natural.width);
}

/**
 * Pure helper for the toolbar's −/+ buttons: snaps `scale` (effective, see
 * module docs) to the NEXT 25% grid stop in `dir`'s direction. Always moves
 * at least one full step even from an off-grid value left behind by a
 * continuous pinch/wheel zoom (e.g. 42% → up lands on 50%, the next stop
 * strictly above 42% — not "round to nearest," which would also land on
 * 50% here but for the wrong reason at an exact grid value). Clamped to
 * [LIGHTBOX_MIN_SCALE, LIGHTBOX_MAX_SCALE] — stepping beyond either end
 * holds at that bound instead of going out of range.
 */
export function nextZoomStep(scale: number, dir: 1 | -1): number {
  const EPS = 1e-6;
  const steps = scale / ZOOM_STEP;
  const nextSteps = dir === 1 ? Math.floor(steps + EPS) + 1 : Math.ceil(steps - EPS) - 1;
  return clampScale(nextSteps * ZOOM_STEP, LIGHTBOX_MIN_SCALE, LIGHTBOX_MAX_SCALE);
}

/**
 * Hard-clamps pan (in screen px) so the scaled image can never reveal empty
 * space beyond its own edges — no rubber-banding, just a firm bound.
 * `scale` here is the CSS multiplier (cssScale — see module docs, NOT the
 * natural-pixel-relative effective scale): at `scale`, the image occupies
 * `scale`x its displayed ("Fit") box around its own (untranslated) center,
 * so the max offset per axis is half the extra size the zoom introduced.
 * At cssScale <= 1 (at or below Fit) there's no room to pan, regardless of
 * what % of natural pixels that represents.
 */
export function clampPan(pan: Point, scale: number, displayed: Size): Point {
  if (scale <= 1) return { x: 0, y: 0 };
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
