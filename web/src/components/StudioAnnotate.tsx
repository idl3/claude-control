// cockpit-prototype-studio, Phase D annotation overlay — RETAINED, EDITABLE
// object model rendered as an SVG overlay (replaces the old baked-raster
// <canvas> where every stroke was drawn once and forgotten). The base image
// is displayed responsively via a plain <img>; a same-size <svg
// viewBox="0 0 W H"> (W/H = the image's NATURAL resolution) sits on top of
// it. Every annotation is stored in IMAGE space (viewBox units), so it stays
// correct across resize/zoom and `exportPng()` needs zero coordinate
// remapping — it just replays the same annotations onto an offscreen canvas
// at the image's natural size.
//
// Pointer Events (onPointerDown/Move/Up), not separate mouse+touch handlers:
// the Pointer Events spec already unifies mouse, touch, and pen input under
// one event model.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { PencilIcon, ArrowUpRightIcon, TypeIcon, UndoIcon, MousePointerIcon, Trash2Icon } from './icons';
import {
  type Annotation,
  type AnnId,
  type Point,
  type TextAnnotation,
  type History,
  createHistory,
  pushHistory,
  undo,
  redo,
  canUndo,
  canRedo,
  createPen,
  createArrow,
  createText,
  translateAnnotation,
  retargetArrow,
  recolorAnnotation,
  resizeText,
  editText,
} from '../lib/annotationModel';
import {
  clientToImagePoint,
  pxToImg,
  handleRadiusPx,
  topmostHit,
  nearestArrowHandle,
  annotationBounds,
  computeArrowHeadPoints,
  drawAnnotation,
  type DrawCtx,
} from '../lib/annotationGeometry';

export type { Point } from '../lib/annotationModel';

type DrawTool = 'pen' | 'arrow' | 'text';
export type AnnotateTool = 'select' | DrawTool;

const TOOL_ICONS: Record<DrawTool, typeof PencilIcon> = {
  pen: PencilIcon,
  arrow: ArrowUpRightIcon,
  text: TypeIcon,
};

const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff', '#000000'];
const DEFAULT_TEXT_SIZE = 20;
const MIN_TEXT_SIZE = 10;
const MAX_TEXT_SIZE = 64;
const FINE_HIT_TOLERANCE_PX = 10;
const COARSE_HIT_TOLERANCE_PX = 18;

export interface StudioAnnotateHandle {
  /** Composites the source image + every committed annotation into a single PNG dataUrl, at the image's own natural resolution. */
  exportPng(): Promise<string>;
}

export interface StudioAnnotateProps {
  imageDataUrl: string;
  /** Fires `true` once the source image has successfully decoded and `false` at the start of every load attempt AND on decode failure. */
  onReady?: (ready: boolean) => void;
  /** Fires when the source image fails to decode. */
  onError?: () => void;
}

/** jsdom (this project's test environment) does not implement `matchMedia` at all — every call must be guarded, mirroring lib/anim.ts's `prefersReducedMotion()`. */
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(pointer: coarse)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(pointer: coarse)');
    const handler = (e: MediaQueryListEvent) => setCoarse(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return coarse;
}

type DragState =
  | { kind: 'draw-pen'; id: AnnId; pointerId: number }
  | { kind: 'draw-arrow'; id: AnnId; pointerId: number }
  | { kind: 'move'; id: AnnId; start: Point; original: Annotation; pointerId: number; moved: boolean }
  | { kind: 'retarget'; id: AnnId; which: 'start' | 'end'; pointerId: number; moved: boolean };

type EditingText = { id: AnnId; isNew: boolean; draft: string };

export const StudioAnnotate = forwardRef<StudioAnnotateHandle, StudioAnnotateProps>(
  function StudioAnnotate({ imageDataUrl, onReady, onError }, ref) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const svgRef = useRef<SVGSVGElement | null>(null);
    const imgRef = useRef<HTMLImageElement | null>(null); // decode probe; not rendered (see the visible <img> below)
    const dragRef = useRef<DragState | null>(null);
    const displayScaleRef = useRef(1);

    const [tool, setTool] = useState<AnnotateTool>('select');
    const [color, setColor] = useState(COLORS[0]);
    const [imgReady, setImgReady] = useState(false);
    const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
    const [history, setHistory] = useState<History>(() => createHistory());
    const [liveAnnotations, setLiveAnnotations] = useState<Annotation[] | null>(null);
    const [selectedId, setSelectedId] = useState<AnnId | null>(null);
    const [editingText, setEditingText] = useState<EditingText | null>(null);
    const [displayScale, setDisplayScale] = useState(1);
    const coarse = useCoarsePointer();

    const annotations = liveAnnotations ?? history.present;
    const selectedAnn = selectedId ? (annotations.find((a) => a.id === selectedId) ?? null) : null;

    // Decode probe: a DETACHED `new Image()`, deliberately separate from the
    // visible <img> below. This preserves the exact imgReady/onReady/onError
    // contract StudioModal.vitest.ts asserts on (its stubImageLoad() helper
    // stubs the global `Image` constructor, which only affects `new Image()`
    // calls, not React's JSX-rendered <img>).
    useEffect(() => {
      setImgReady(false);
      setNaturalSize(null);
      onReady?.(false);
      const img = new Image();
      img.onload = () => {
        imgRef.current = img;
        setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
        setImgReady(true);
        onReady?.(true);
      };
      img.onerror = () => {
        setImgReady(false);
        onReady?.(false);
        onError?.();
      };
      img.src = imageDataUrl;
      return () => {
        img.onload = null;
        img.onerror = null;
      };
    }, [imageDataUrl, onReady, onError]);

    // A new source image means a fresh annotation history.
    useEffect(() => {
      setHistory(createHistory());
      setLiveAnnotations(null);
      setSelectedId(null);
      setEditingText(null);
      dragRef.current = null;
    }, [imageDataUrl]);

    const measureScale = useCallback(() => {
      const svg = svgRef.current;
      if (!svg || !naturalSize || naturalSize.w <= 0) return;
      const rect = svg.getBoundingClientRect();
      const next = rect.width > 0 ? rect.width / naturalSize.w : 1;
      displayScaleRef.current = next;
      setDisplayScale((prev) => (Math.abs(prev - next) > 1e-6 ? next : prev));
    }, [naturalSize]);

    useEffect(() => {
      measureScale();
      if (typeof window === 'undefined') return;
      window.addEventListener('resize', measureScale);
      return () => window.removeEventListener('resize', measureScale);
    }, [measureScale]);

    // Drop a stale selection (its annotation was deleted or undone away).
    useEffect(() => {
      if (selectedId && !history.present.some((a) => a.id === selectedId)) setSelectedId(null);
    }, [history.present, selectedId]);

    useImperativeHandle(
      ref,
      () => ({
        async exportPng() {
          if (!imgReady || !naturalSize || !imgRef.current) throw new Error('image not ready — cannot export');
          const canvas = document.createElement('canvas');
          canvas.width = naturalSize.w;
          canvas.height = naturalSize.h;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(imgRef.current, 0, 0, naturalSize.w, naturalSize.h);
            for (const a of history.present) drawAnnotation(ctx as unknown as DrawCtx, a);
          }
          return canvas.toDataURL('image/png');
        },
      }),
      [imgReady, naturalSize, history.present],
    );

    const commit = (next: Annotation[]) => {
      setHistory((h) => pushHistory(h, next));
      setLiveAnnotations(null);
    };

    const deleteSelected = () => {
      if (!selectedId) return;
      commit(history.present.filter((a) => a.id !== selectedId));
      setSelectedId(null);
      setEditingText(null);
    };

    const startEditingText = (ann: TextAnnotation, isNew: boolean) => {
      setSelectedId(ann.id);
      setEditingText({ id: ann.id, isNew, draft: ann.content });
    };

    const commitTextEdit = () => {
      const editing = editingText;
      if (!editing) return;
      setEditingText(null);
      const trimmed = editing.draft.trim();
      if (editing.isNew) {
        if (trimmed === '') {
          setLiveAnnotations(null);
          setSelectedId(null);
          return;
        }
        const source = liveAnnotations ?? history.present;
        const draftAnn = source.find((a): a is TextAnnotation => a.id === editing.id && a.kind === 'text');
        if (draftAnn) {
          commit([...history.present, editText(draftAnn, trimmed)]);
          setSelectedId(editing.id);
          setTool('select');
        } else {
          setLiveAnnotations(null);
        }
        return;
      }
      if (trimmed === '') {
        commit(history.present.filter((a) => a.id !== editing.id));
        setSelectedId(null);
        return;
      }
      const target = history.present.find((a): a is TextAnnotation => a.id === editing.id && a.kind === 'text');
      if (target) commit(history.present.map((a) => (a.id === editing.id ? editText(target, trimmed) : a)));
    };

    const cancelTextEdit = () => {
      const editing = editingText;
      setEditingText(null);
      if (editing?.isNew) {
        setLiveAnnotations(null);
        setSelectedId(null);
      }
    };

    const hitTolerance = (scale: number) => pxToImg(coarse ? COARSE_HIT_TOLERANCE_PX : FINE_HIT_TOLERANCE_PX, scale);

    const onSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
      if (!imgReady || !naturalSize || editingText) return;
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const nextScale = rect.width > 0 ? rect.width / naturalSize.w : 1;
      displayScaleRef.current = nextScale;
      setDisplayScale((prev) => (Math.abs(prev - nextScale) > 1e-6 ? nextScale : prev));
      const p = clientToImagePoint(e.clientX, e.clientY, rect, naturalSize.w, naturalSize.h);
      const tol = hitTolerance(nextScale);

      if (tool === 'pen') {
        const ann = createPen(color, [p]);
        setLiveAnnotations([...history.present, ann]);
        setSelectedId(null);
        dragRef.current = { kind: 'draw-pen', id: ann.id, pointerId: e.pointerId };
        svg.setPointerCapture?.(e.pointerId);
        return;
      }
      if (tool === 'arrow') {
        const ann = createArrow(color, p, p);
        setLiveAnnotations([...history.present, ann]);
        setSelectedId(null);
        dragRef.current = { kind: 'draw-arrow', id: ann.id, pointerId: e.pointerId };
        svg.setPointerCapture?.(e.pointerId);
        return;
      }
      if (tool === 'text') {
        const ann = createText(color, p, '', DEFAULT_TEXT_SIZE);
        setLiveAnnotations([...history.present, ann]);
        startEditingText(ann, true);
        return;
      }
      // select tool: prefer an arrow handle on the current selection, else hit-test everything.
      if (selectedAnn && selectedAnn.kind === 'arrow') {
        const which = nearestArrowHandle(selectedAnn, p, tol);
        if (which) {
          dragRef.current = { kind: 'retarget', id: selectedAnn.id, which, pointerId: e.pointerId, moved: false };
          svg.setPointerCapture?.(e.pointerId);
          return;
        }
      }
      const hit = topmostHit(history.present, p, tol);
      if (hit) {
        const original = history.present.find((a) => a.id === hit)!;
        setSelectedId(hit);
        dragRef.current = { kind: 'move', id: hit, start: p, original, pointerId: e.pointerId, moved: false };
        svg.setPointerCapture?.(e.pointerId);
      } else {
        setSelectedId(null);
      }
    };

    const onSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      if (!drag || !naturalSize) return;
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const p = clientToImagePoint(e.clientX, e.clientY, rect, naturalSize.w, naturalSize.h);

      if (drag.kind === 'draw-pen') {
        setLiveAnnotations((prev) => {
          if (!prev) return prev;
          return prev.map((a) => (a.id === drag.id && a.kind === 'pen' ? { ...a, points: [...a.points, p] } : a));
        });
        return;
      }
      if (drag.kind === 'draw-arrow') {
        setLiveAnnotations((prev) => {
          if (!prev) return prev;
          return prev.map((a) => (a.id === drag.id && a.kind === 'arrow' ? retargetArrow(a, 'end', p) : a));
        });
        return;
      }
      if (drag.kind === 'move') {
        drag.moved = true;
        const dx = p.x - drag.start.x;
        const dy = p.y - drag.start.y;
        setLiveAnnotations(
          history.present.map((a) => (a.id === drag.id ? translateAnnotation(drag.original, dx, dy) : a)),
        );
        return;
      }
      if (drag.kind === 'retarget') {
        drag.moved = true;
        setLiveAnnotations(
          history.present.map((a) => (a.id === drag.id && a.kind === 'arrow' ? retargetArrow(a, drag.which, p) : a)),
        );
      }
    };

    const onSvgPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag) return;
      svgRef.current?.releasePointerCapture?.(e.pointerId);

      if (drag.kind === 'draw-pen') {
        const list = liveAnnotations ?? history.present;
        const ann = list.find((a) => a.id === drag.id);
        if (ann && ann.kind === 'pen' && ann.points.length >= 2) {
          commit(list);
          setSelectedId(ann.id);
          setTool('select');
        } else {
          setLiveAnnotations(null);
        }
        return;
      }
      if (drag.kind === 'draw-arrow') {
        const list = liveAnnotations ?? history.present;
        const ann = list.find((a) => a.id === drag.id);
        if (ann && ann.kind === 'arrow' && (ann.start.x !== ann.end.x || ann.start.y !== ann.end.y)) {
          commit(list);
          setSelectedId(ann.id);
          setTool('select');
        } else {
          setLiveAnnotations(null);
        }
        return;
      }
      // move / retarget
      if (drag.moved && liveAnnotations) {
        commit(liveAnnotations);
      } else {
        setLiveAnnotations(null);
      }
    };

    const onSvgDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
      if (tool !== 'select' || !imgReady || !naturalSize) return;
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const p = clientToImagePoint(e.clientX, e.clientY, rect, naturalSize.w, naturalSize.h);
      const tol = hitTolerance(displayScaleRef.current || 1);
      const hit = topmostHit(history.present, p, tol);
      if (!hit) return;
      const ann = history.present.find((a) => a.id === hit);
      if (ann && ann.kind === 'text') startEditingText(ann, false);
    };

    const onRootKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      const targetTag = (e.target as HTMLElement).tagName;
      if (targetTag === 'INPUT' || targetTag === 'TEXTAREA') return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        setLiveAnnotations(null);
        dragRef.current = null;
        setHistory((h) => (e.shiftKey ? redo(h) : undo(h)));
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault();
        deleteSelected();
      }
    };

    const onColorChange = (next: string) => {
      setColor(next);
      if (selectedId) {
        commit(history.present.map((a) => (a.id === selectedId ? recolorAnnotation(a, next) : a)));
      }
    };

    const onSizeChange = (next: number) => {
      if (selectedAnn && selectedAnn.kind === 'text') {
        const id = selectedAnn.id;
        commit(history.present.map((a) => (a.id === id && a.kind === 'text' ? resizeText(a, next) : a)));
      }
    };

    const onUndoClick = () => {
      setLiveAnnotations(null);
      dragRef.current = null;
      setHistory((h) => undo(h));
    };

    const onRedoClick = () => {
      setLiveAnnotations(null);
      dragRef.current = null;
      setHistory((h) => redo(h));
    };

    return (
      <div ref={rootRef} className="studio-annotate" tabIndex={0} onKeyDown={onRootKeyDown}>
        <div className="studio-annotate-toolbar">
          <button
            type="button"
            className="studio-annotate-tool-btn studio-annotate-select"
            aria-pressed={tool === 'select'}
            aria-label="select"
            onClick={() => setTool('select')}
          >
            <MousePointerIcon className="studio-tool-ico" />
          </button>
          {(['pen', 'arrow', 'text'] as const).map((t) => {
            const Icon = TOOL_ICONS[t];
            return (
              <button
                key={t}
                type="button"
                className="studio-annotate-tool-btn"
                aria-pressed={tool === t}
                aria-label={t}
                onClick={() => setTool(t)}
              >
                <Icon className="studio-tool-ico" />
              </button>
            );
          })}
          <input
            type="color"
            aria-label="annotation color"
            className="studio-annotate-color"
            value={color}
            onChange={(e) => onColorChange(e.target.value)}
          />
          {selectedAnn && selectedAnn.kind === 'text' && (
            <input
              type="range"
              aria-label="text size"
              className="studio-annotate-size"
              min={MIN_TEXT_SIZE}
              max={MAX_TEXT_SIZE}
              step={2}
              value={selectedAnn.size}
              onChange={(e) => onSizeChange(Number(e.target.value))}
            />
          )}
          <button type="button" className="studio-annotate-undo" disabled={!canUndo(history)} onClick={onUndoClick}>
            <UndoIcon className="studio-tool-ico" />
            Undo
          </button>
          <button type="button" className="studio-annotate-redo" disabled={!canRedo(history)} onClick={onRedoClick}>
            <UndoIcon className="studio-tool-ico studio-annotate-redo-ico" />
            Redo
          </button>
          <button
            type="button"
            className="studio-annotate-delete"
            disabled={!selectedId}
            aria-label="delete annotation"
            onClick={deleteSelected}
          >
            <Trash2Icon className="studio-tool-ico" />
            Delete
          </button>
        </div>
        <div className="studio-annotate-stage">
          <img src={imageDataUrl} alt="" aria-hidden="true" draggable={false} className="studio-annotate-img" />
          <svg
            ref={svgRef}
            data-testid="studio-annotate-canvas"
            className="studio-annotate-svg"
            data-tool={tool}
            viewBox={`0 0 ${naturalSize?.w || 1} ${naturalSize?.h || 1}`}
            onPointerDown={onSvgPointerDown}
            onPointerMove={onSvgPointerMove}
            onPointerUp={onSvgPointerUp}
            onPointerLeave={onSvgPointerUp}
            onDoubleClick={onSvgDoubleClick}
          >
            {annotations.map((a) => (
              <AnnotationShape key={a.id} a={a} hideText={editingText?.id === a.id} />
            ))}
            {tool === 'select' && selectedAnn && (
              <SelectionChrome ann={selectedAnn} displayScale={displayScale || 1} coarse={coarse} />
            )}
          </svg>
          {tool === 'select' && selectedAnn && (
            <button
              type="button"
              className="studio-annotate-float-delete"
              style={floatingDeleteStyle(selectedAnn, displayScale || 1)}
              aria-label="Delete annotation"
              onClick={deleteSelected}
            >
              <Trash2Icon className="studio-tool-ico" />
            </button>
          )}
          {editingText &&
            (() => {
              const ann = (liveAnnotations ?? history.present).find(
                (a): a is TextAnnotation => a.id === editingText.id && a.kind === 'text',
              );
              return (
                <TextEditorOverlay
                  ann={ann}
                  draft={editingText.draft}
                  displayScale={displayScale || 1}
                  onChange={(v) => setEditingText((cur) => (cur ? { ...cur, draft: v } : cur))}
                  onCommit={commitTextEdit}
                  onCancel={cancelTextEdit}
                />
              );
            })()}
        </div>
      </div>
    );
  },
);

function AnnotationShape({ a, hideText }: { a: Annotation; hideText: boolean }) {
  if (a.kind === 'pen') {
    if (a.points.length < 2) return null;
    const d = a.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
    return (
      <path
        d={d}
        fill="none"
        stroke={a.color}
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
        data-ann-id={a.id}
        data-ann-kind="pen"
      />
    );
  }
  if (a.kind === 'arrow') {
    const [left, right] = computeArrowHeadPoints(a.start, a.end);
    return (
      <g data-ann-id={a.id} data-ann-kind="arrow">
        <line
          x1={a.start.x}
          y1={a.start.y}
          x2={a.end.x}
          y2={a.end.y}
          stroke={a.color}
          strokeWidth={3}
          strokeLinecap="round"
        />
        <path
          d={`M${left.x},${left.y} L${a.end.x},${a.end.y} L${right.x},${right.y}`}
          fill="none"
          stroke={a.color}
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    );
  }
  if (hideText) return null;
  return (
    <text
      x={a.pos.x}
      y={a.pos.y}
      fill={a.color}
      fontSize={a.size}
      fontFamily='ui-monospace, "SF Mono", Menlo, monospace'
      data-ann-id={a.id}
      data-ann-kind="text"
    >
      {a.content}
    </text>
  );
}

function SelectionChrome({ ann, displayScale, coarse }: { ann: Annotation; displayScale: number; coarse: boolean }) {
  const b = annotationBounds(ann);
  const pad = pxToImg(8, displayScale);
  return (
    <g className="studio-annotate-selection" aria-hidden="true">
      <rect
        x={b.x - pad}
        y={b.y - pad}
        width={b.w + pad * 2}
        height={b.h + pad * 2}
        className="studio-annotate-selection-outline"
        vectorEffect="non-scaling-stroke"
      />
      {ann.kind === 'arrow' &&
        (['start', 'end'] as const).map((which) => {
          const pt = which === 'start' ? ann.start : ann.end;
          const r = pxToImg(handleRadiusPx(coarse), displayScale);
          return (
            <circle
              key={which}
              cx={pt.x}
              cy={pt.y}
              r={r}
              className="studio-annotate-handle"
              vectorEffect="non-scaling-stroke"
              data-handle={which}
            />
          );
        })}
    </g>
  );
}

function floatingDeleteStyle(ann: Annotation, displayScale: number): React.CSSProperties {
  const b = annotationBounds(ann);
  return { left: (b.x + b.w) * displayScale, top: b.y * displayScale };
}

function TextEditorOverlay({
  ann,
  draft,
  displayScale,
  onChange,
  onCommit,
  onCancel,
}: {
  ann: TextAnnotation | undefined;
  draft: string;
  displayScale: number;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  if (!ann) return null;
  const left = ann.pos.x * displayScale;
  const top = (ann.pos.y - ann.size * 0.82) * displayScale;
  const fontSize = Math.max(10, ann.size * displayScale);
  return (
    <input
      autoFocus
      data-testid="studio-annotate-text-editor"
      className="studio-annotate-text-editor"
      style={{ left, top, fontSize, color: ann.color }}
      value={draft}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
        e.stopPropagation();
      }}
    />
  );
}
