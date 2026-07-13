// Pure coordinate transforms, hit-testing, and canvas rendering for the
// annotation overlay. No DOM/React — StudioAnnotate.tsx wires this to
// pointer/keyboard events and an actual <svg>/<canvas>.
import type { Annotation, ArrowAnnotation, AnnId, Point } from './annotationModel';

// --- coordinate transform --------------------------------------------------

/**
 * Converts a pointer event's viewport-relative (clientX/clientY) coordinates
 * into IMAGE space (the SVG's viewBox units == the source image's natural
 * resolution). This is the load-bearing transform: every annotation is
 * stored in image space so it stays correct across resize/zoom, and export
 * needs zero remapping. Identical math to the old canvas-backing-buffer
 * transform it replaces (`toCanvasPoint`), just renamed for the new model.
 */
export function clientToImagePoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  imageWidth: number,
  imageHeight: number,
): Point {
  const scaleX = rect.width > 0 ? imageWidth / rect.width : 1;
  const scaleY = rect.height > 0 ? imageHeight / rect.height : 1;
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}

/** Screen-px size (e.g. a handle radius) converted into image-space units, given the current display scale (svgRect.width / imageWidth). */
export function pxToImg(px: number, displayScale: number): number {
  return displayScale > 0 ? px / displayScale : px;
}

/** Constant on-screen handle radius: bigger under a coarse (touch) pointer so handles stay finger-hittable. */
export function handleRadiusPx(coarsePointer: boolean): number {
  return coarsePointer ? 13 : 7;
}

// --- arrow head geometry ----------------------------------------------------

/**
 * The two "barb" endpoints of an arrowhead pointing from `from` to `to`.
 * Returned as [left barb, right barb] as seen facing along the direction of
 * travel. Ported verbatim from the old canvas implementation.
 */
export function computeArrowHeadPoints(
  from: Point,
  to: Point,
  headLength = 14,
  headAngleRad = Math.PI / 7,
): [Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const left: Point = {
    x: to.x - headLength * Math.cos(angle - headAngleRad),
    y: to.y - headLength * Math.sin(angle - headAngleRad),
  };
  const right: Point = {
    x: to.x - headLength * Math.cos(angle + headAngleRad),
    y: to.y - headLength * Math.sin(angle + headAngleRad),
  };
  return [left, right];
}

// --- hit-testing --------------------------------------------------------

/** Shortest distance from point `p` to the segment `a`-`b`. */
export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const proj: Point = { x: a.x + t * dx, y: a.y + t * dy };
  return Math.hypot(p.x - proj.x, p.y - proj.y);
}

// Text bbox is an APPROXIMATION: real glyph metrics aren't available outside
// a live canvas context, so we estimate a monospace advance width per
// character and use font-relative ascent/descent — good enough for
// hit-testing and a selection outline, not pixel-exact typography. Baseline
// placement mirrors canvas fillText: (pos.x, pos.y) is the alphabetic
// baseline, so the box spans UPWARD from pos.y (ascent) and slightly below
// (descent).
const TEXT_CHAR_WIDTH_FACTOR = 0.62;
const TEXT_ASCENT_FACTOR = 0.82;
const TEXT_DESCENT_FACTOR = 0.24;

function textBounds(a: { pos: Point; content: string; size: number }): { x: number; y: number; w: number; h: number } {
  const w = Math.max(a.size * 0.5, a.content.length * a.size * TEXT_CHAR_WIDTH_FACTOR);
  const ascent = a.size * TEXT_ASCENT_FACTOR;
  const descent = a.size * TEXT_DESCENT_FACTOR;
  return { x: a.pos.x, y: a.pos.y - ascent, w, h: ascent + descent };
}

export function hitTestAnnotation(a: Annotation, p: Point, tolImg: number): boolean {
  if (a.kind === 'pen') {
    if (a.points.length === 0) return false;
    if (a.points.length === 1) return Math.hypot(p.x - a.points[0].x, p.y - a.points[0].y) <= tolImg;
    for (let i = 1; i < a.points.length; i += 1) {
      if (distToSegment(p, a.points[i - 1], a.points[i]) <= tolImg) return true;
    }
    return false;
  }
  if (a.kind === 'arrow') {
    return distToSegment(p, a.start, a.end) <= tolImg;
  }
  // text: point within the approximate bbox, padded by the hit tolerance.
  const b = textBounds(a);
  return p.x >= b.x - tolImg && p.x <= b.x + b.w + tolImg && p.y >= b.y - tolImg && p.y <= b.y + b.h + tolImg;
}

/** Iterates LAST-to-first (topmost/most-recently-added wins ties) and returns the id of the first hit, or null. */
export function topmostHit(anns: Annotation[], p: Point, tolImg: number): AnnId | null {
  for (let i = anns.length - 1; i >= 0; i -= 1) {
    if (hitTestAnnotation(anns[i], p, tolImg)) return anns[i].id;
  }
  return null;
}

/** Which arrow endpoint (if any) is within tolImg of `p` — the closer one wins if both qualify. */
export function nearestArrowHandle(arrow: ArrowAnnotation, p: Point, tolImg: number): 'start' | 'end' | null {
  const dStart = Math.hypot(p.x - arrow.start.x, p.y - arrow.start.y);
  const dEnd = Math.hypot(p.x - arrow.end.x, p.y - arrow.end.y);
  const startHit = dStart <= tolImg;
  const endHit = dEnd <= tolImg;
  if (startHit && endHit) return dStart <= dEnd ? 'start' : 'end';
  if (startHit) return 'start';
  if (endHit) return 'end';
  return null;
}

/** Tight geometric bounding box of an annotation, in image space. */
export function annotationBounds(a: Annotation): { x: number; y: number; w: number; h: number } {
  if (a.kind === 'pen') {
    if (a.points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
    const xs = a.points.map((p) => p.x);
    const ys = a.points.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  if (a.kind === 'arrow') {
    const minX = Math.min(a.start.x, a.end.x);
    const maxX = Math.max(a.start.x, a.end.x);
    const minY = Math.min(a.start.y, a.end.y);
    const maxY = Math.max(a.start.y, a.end.y);
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  return textBounds(a);
}

// --- rendering (export path) ------------------------------------------------

/**
 * Minimal structural subset of CanvasRenderingContext2D so tests can pass a
 * plain call-recording mock instead of a real canvas context (jsdom's canvas
 * support is unreliable/absent without the optional `canvas` native module).
 */
export interface DrawCtx {
  strokeStyle: string;
  fillStyle: string;
  lineWidth: number;
  font: string;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  stroke(): void;
  fill(): void;
  fillText(text: string, x: number, y: number): void;
}

/** Renders one annotation onto a 2D context — the export path (offscreen canvas -> toDataURL). */
export function drawAnnotation(ctx: DrawCtx, a: Annotation): void {
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = 3;
  if (a.kind === 'pen') {
    if (a.points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(a.points[0].x, a.points[0].y);
    for (const p of a.points.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
    return;
  }
  if (a.kind === 'arrow') {
    ctx.beginPath();
    ctx.moveTo(a.start.x, a.start.y);
    ctx.lineTo(a.end.x, a.end.y);
    ctx.stroke();
    const [left, right] = computeArrowHeadPoints(a.start, a.end);
    ctx.beginPath();
    ctx.moveTo(a.end.x, a.end.y);
    ctx.lineTo(left.x, left.y);
    ctx.moveTo(a.end.x, a.end.y);
    ctx.lineTo(right.x, right.y);
    ctx.stroke();
    return;
  }
  // text
  ctx.font = `${a.size}px ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.fillText(a.content, a.pos.x, a.pos.y);
}
