// cockpit-prototype-studio, Phase D (D2): canvas annotation overlay for a
// captured Studio screenshot (D1's cc-capture-result dataUrl). A single
// <canvas> IS the composite from the start — the source image is drawn onto
// it once (at the image's own natural resolution, so exported quality never
// degrades from a shrunken display size) and every annotation stroke is
// drawn on top of that same canvas, so `exportPng()` is just
// `canvas.toDataURL('image/png')`: no separate offscreen compositing pass,
// no image+overlay layering to keep in sync.
//
// Pointer Events (onPointerDown/Move/Up), not separate mouse+touch handlers:
// the Pointer Events spec already unifies mouse, touch, and pen input under
// one event model (`event.pointerType` distinguishes them only for callers
// who care) — this is the "native platform feature already covers it" case,
// not something to hand-roll two ways.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

export type AnnotateTool = 'pen' | 'arrow' | 'text';

export type Point = { x: number; y: number };

export type Stroke =
  | { tool: 'pen'; color: string; points: Point[] }
  | { tool: 'arrow'; color: string; points: [Point, Point] }
  | { tool: 'text'; color: string; points: [Point]; text: string };

export interface StudioAnnotateHandle {
  /** Composites the source image + every committed stroke into a single PNG dataUrl, at the image's own natural resolution. */
  exportPng(): Promise<string>;
}

/**
 * Pure coordinate transform: a pointer event's viewport-relative
 * (clientX/clientY) coordinates, converted into the canvas's own backing-
 * buffer pixel space. Needed because the canvas is displayed at whatever
 * size CSS gives it (e.g. `max-width: 100%`) while its `width`/`height`
 * attributes (and therefore every drawing coordinate) are fixed at the
 * source image's natural resolution — the two can differ by an arbitrary
 * scale factor.
 */
export function toCanvasPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  canvasWidth: number,
  canvasHeight: number,
): Point {
  const scaleX = rect.width > 0 ? canvasWidth / rect.width : 1;
  const scaleY = rect.height > 0 ? canvasHeight / rect.height : 1;
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}

/**
 * Pure geometry: the two "barb" endpoints of an arrowhead pointing from
 * `from` to `to`. Returned in the order [left barb, right barb] as seen
 * facing along the direction of travel.
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

/** Pure: drop the most recently committed stroke. No-op on an empty list — undo with nothing to undo is a safe idle, not an error. */
export function undoStrokes(strokes: Stroke[]): Stroke[] {
  return strokes.length === 0 ? strokes : strokes.slice(0, -1);
}

/**
 * Draws one stroke onto a 2D rendering context. `ctx` is typed as a minimal
 * structural subset of CanvasRenderingContext2D so tests can pass a plain
 * call-recording mock instead of a real canvas context (jsdom's canvas
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

export function drawStroke(ctx: DrawCtx, stroke: Stroke): void {
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = 3;
  if (stroke.tool === 'pen') {
    if (stroke.points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (const p of stroke.points.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
    return;
  }
  if (stroke.tool === 'arrow') {
    const [from, to] = stroke.points;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    const [left, right] = computeArrowHeadPoints(from, to);
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(left.x, left.y);
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(right.x, right.y);
    ctx.stroke();
    return;
  }
  // text
  ctx.font = '20px sans-serif';
  ctx.fillText(stroke.text, stroke.points[0].x, stroke.points[0].y);
}

const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff', '#000000'];

export const StudioAnnotate = forwardRef<StudioAnnotateHandle, { imageDataUrl: string }>(
  function StudioAnnotate({ imageDataUrl }, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [tool, setTool] = useState<AnnotateTool>('pen');
    const [color, setColor] = useState(COLORS[0]);
    const [strokes, setStrokes] = useState<Stroke[]>([]);
    const [imgReady, setImgReady] = useState(false);
    const imgRef = useRef<HTMLImageElement | null>(null);
    const drawingRef = useRef(false);

    // Load the source image once; the canvas backing buffer is sized to its
    // NATURAL resolution (never the on-screen display size), so annotations
    // and the exported PNG stay full quality regardless of how small the
    // review overlay renders the preview.
    useEffect(() => {
      const img = new Image();
      img.onload = () => {
        imgRef.current = img;
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
        }
        setImgReady(true);
      };
      img.src = imageDataUrl;
      return () => {
        img.onload = null;
      };
    }, [imageDataUrl]);

    // Redraw the full picture (base image + every committed stroke) any time
    // the stroke list changes or the image finishes loading.
    useEffect(() => {
      const canvas = canvasRef.current;
      const img = imgRef.current;
      if (!canvas || !img || !imgReady) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const s of strokes) drawStroke(ctx as unknown as DrawCtx, s);
    }, [strokes, imgReady]);

    useImperativeHandle(ref, () => ({
      async exportPng() {
        const canvas = canvasRef.current;
        if (!canvas) throw new Error('canvas not ready');
        return canvas.toDataURL('image/png');
      },
    }));

    const pointFromEvent = (e: { clientX: number; clientY: number }): Point | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      return toCanvasPoint(e.clientX, e.clientY, rect, canvas.width, canvas.height);
    };

    const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const p = pointFromEvent(e);
      if (!p) return;
      if (tool === 'text') {
        // ponytail: window.prompt is the native, zero-dependency text-input
        // affordance — a custom inline editor is real scope this feature
        // doesn't need yet.
        const text = window.prompt('Annotation text:');
        if (text) setStrokes((prev) => [...prev, { tool: 'text', color, points: [p], text }]);
        return;
      }
      drawingRef.current = true;
      if (tool === 'pen') {
        setStrokes((prev) => [...prev, { tool: 'pen', color, points: [p] }]);
      } else {
        setStrokes((prev) => [...prev, { tool: 'arrow', color, points: [p, p] }]);
      }
    };

    const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!drawingRef.current) return;
      const p = pointFromEvent(e);
      if (!p) return;
      setStrokes((prev) => {
        if (prev.length === 0) return prev;
        const last = prev[prev.length - 1];
        if (last.tool === 'pen') {
          const updated: Stroke = { ...last, points: [...last.points, p] };
          return [...prev.slice(0, -1), updated];
        }
        if (last.tool === 'arrow') {
          const updated: Stroke = { ...last, points: [last.points[0], p] };
          return [...prev.slice(0, -1), updated];
        }
        return prev;
      });
    };

    const onPointerUp = () => {
      drawingRef.current = false;
    };

    return (
      <div className="studio-annotate">
        <div className="studio-annotate-toolbar">
          {(['pen', 'arrow', 'text'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className="studio-annotate-tool-btn"
              aria-pressed={tool === t}
              onClick={() => setTool(t)}
            >
              {t}
            </button>
          ))}
          <input
            type="color"
            aria-label="annotation color"
            className="studio-annotate-color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
          <button
            type="button"
            className="studio-annotate-undo"
            disabled={strokes.length === 0}
            onClick={() => setStrokes(undoStrokes)}
          >
            Undo
          </button>
        </div>
        <canvas
          ref={canvasRef}
          className="studio-annotate-canvas"
          data-testid="studio-annotate-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        />
      </div>
    );
  },
);
