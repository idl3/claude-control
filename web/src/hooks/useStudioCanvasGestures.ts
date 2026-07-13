import { useEffect, useRef } from 'react';
import {
  studioEffectiveScale,
  zoomForEffectiveScale,
  zoomStep,
  panForFocalZoom,
  wheelZoomScale,
  panBounds,
  ZOOM_MAX_SCALE,
  type Vec2,
} from '../lib/studioDevices';

/**
 * Prototype Studio canvas gestures — the imperative half of zoom/pan.
 *
 * Detection only: this hook reads pointer/wheel/keyboard input on the stage
 * element and converts each gesture into a `(nextZoom, nextPanRaw)` pair, then
 * hands it to `actions.applyView`. ALL view-state math (effective scale,
 * zoom-to-focal, pan clamping) is pure and lives in `lib/studioDevices.ts`;
 * ALL React state ownership lives in StudioModal (which supplies `applyView`,
 * clamping the raw pan against the live footprint). So this file holds no
 * component state and touches nothing AppFrameLayer owns — the hosted iframe is
 * never remounted; only StudioModal's `zoom`/`pan` state changes, which is a
 * pure display transform.
 *
 * Sandbox note: the hosted app iframe (z-310) paints over the device frame and
 * eats its own pointer/wheel events, so every gesture here necessarily
 * originates on the EMPTY canvas around the frame — which is exactly the spec
 * ("drag on empty canvas pans; NOT on the device frame's content"). Keyboard
 * nav is the always-available fallback for when a zoomed-in frame covers the
 * stage; it is gated on the studio owning input (the "Disable cockpit hotkeys"
 * toggle) so it never steals keys from the rest of the app.
 */
export interface StudioCanvasView {
  zoom: number;
  pan: Vec2;
  fitScale: number;
  dims: { width: number; height: number };
  /** Stage content box the frame pans within (px). */
  viewport: Vec2;
  /** Studio owns keyboard input right now (the suppress-hotkeys toggle is ON). */
  ownsInput: boolean;
}

export interface StudioCanvasActions {
  /** Commit a new view. `nextPanRaw` is unclamped — StudioModal clamps it
   *  against the footprint implied by `nextZoom`. */
  applyView: (nextZoom: number, nextPanRaw: Vec2) => void;
}

const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 24;
const KEY_PAN_STEP_PX = 64;

export function useStudioCanvasGestures(
  stageRef: React.RefObject<HTMLElement | null>,
  view: StudioCanvasView,
  actions: StudioCanvasActions,
): void {
  const viewRef = useRef(view);
  viewRef.current = view;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  // Pointer/wheel/dblclick on the stage element (native listeners so `wheel`
  // can be non-passive → preventDefault the page/⌘-zoom).
  useEffect(() => {
    const stageEl = stageRef.current;
    if (!stageEl) return;
    // Non-null typed alias so the hoisted gesture closures below don't re-widen
    // the ref back to `HTMLElement | null` (TS drops truthiness narrowing across
    // function boundaries).
    const stage: HTMLElement = stageEl;

    const footprintOf = (v: StudioCanvasView): Vec2 => {
      const eff = studioEffectiveScale(v.fitScale, v.zoom);
      return { x: Math.floor(v.dims.width * eff), y: Math.floor(v.dims.height * eff) };
    };
    const focalFrom = (clientX: number, clientY: number): Vec2 => {
      const r = stage.getBoundingClientRect();
      return { x: clientX - (r.left + r.width / 2), y: clientY - (r.top + r.height / 2) };
    };
    const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
    const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

    function onWheel(e: WheelEvent) {
      const v = viewRef.current;
      // ⌘/ctrl + wheel — and trackpad pinch, which the browser reports as
      // ctrl+wheel — zooms to the cursor (point under cursor stays fixed).
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const s0 = studioEffectiveScale(v.fitScale, v.zoom);
        const targetEff = wheelZoomScale(s0, e.deltaY, v.fitScale, ZOOM_MAX_SCALE);
        const nz = zoomForEffectiveScale(v.fitScale, targetEff);
        const s1 = studioEffectiveScale(v.fitScale, nz);
        if (s1 === s0) return;
        actionsRef.current.applyView(nz, panForFocalZoom(v.pan, s0, s1, focalFrom(e.clientX, e.clientY)));
        return;
      }
      // Plain wheel pans — but only when there's overflow to pan; otherwise let
      // the event through so a tall preset's `.studio-body` can still scroll.
      const b = panBounds(footprintOf(v), v.viewport);
      if (b.x === 0 && b.y === 0) return;
      e.preventDefault();
      actionsRef.current.applyView(v.zoom, { x: v.pan.x - e.deltaX, y: v.pan.y - e.deltaY });
    }

    const pointers = new Map<number, Vec2>();
    let drag: { id: number; startX: number; startY: number; startPan: Vec2 } | null = null;
    let pinch: { startDist: number; startEff: number; startPan: Vec2; startMid: Vec2 } | null = null;
    let lastTapT = 0;
    let lastTap: Vec2 = { x: 0, y: 0 };

    function beginPinch() {
      const pts = [...pointers.values()];
      const v = viewRef.current;
      pinch = {
        startDist: Math.max(1, dist(pts[0], pts[1])),
        startEff: studioEffectiveScale(v.fitScale, v.zoom),
        startPan: v.pan,
        startMid: mid(pts[0], pts[1]),
      };
      drag = null;
    }

    function onPointerDown(e: PointerEvent) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        beginPinch();
        try {
          stage.setPointerCapture(e.pointerId);
        } catch {
          /* jsdom / unsupported — harmless */
        }
        return;
      }
      if (pointers.size > 2) return;

      // Double-tap / double-click toggles Fit ↔ 100% at the tap point. (Mouse
      // also fires a native dblclick handled below; this covers touch, where
      // dblclick is unreliable, and de-dupes via the reset of lastTapT.)
      const now = e.timeStamp;
      if (now - lastTapT < DOUBLE_TAP_MS && dist({ x: e.clientX, y: e.clientY }, lastTap) < DOUBLE_TAP_SLOP_PX) {
        toggleFit100(focalFrom(e.clientX, e.clientY));
        lastTapT = 0;
        return;
      }
      lastTapT = now;
      lastTap = { x: e.clientX, y: e.clientY };

      const v = viewRef.current;
      const b = panBounds(footprintOf(v), v.viewport);
      if (b.x === 0 && b.y === 0) return; // at Fit / no overflow: nothing to pan
      drag = { id: e.pointerId, startX: e.clientX, startY: e.clientY, startPan: v.pan };
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {
        /* jsdom / unsupported */
      }
      stage.classList.add('is-grabbing');
    }

    function onPointerMove(e: PointerEvent) {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const v = viewRef.current;
      if (pinch && pointers.size >= 2) {
        const pts = [...pointers.values()];
        const d = dist(pts[0], pts[1]);
        const m = mid(pts[0], pts[1]);
        const r = stage.getBoundingClientRect();
        const center = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        const focal = { x: pinch.startMid.x - center.x, y: pinch.startMid.y - center.y };
        const rawEff = pinch.startEff * (d / pinch.startDist);
        const nz = zoomForEffectiveScale(v.fitScale, rawEff);
        const s1 = studioEffectiveScale(v.fitScale, nz);
        // zoom about the (fixed) start midpoint, then add the midpoint drift so
        // a two-finger drag pans at the same time.
        const zoomed = panForFocalZoom(pinch.startPan, pinch.startEff, s1, focal);
        actionsRef.current.applyView(nz, {
          x: zoomed.x + (m.x - pinch.startMid.x),
          y: zoomed.y + (m.y - pinch.startMid.y),
        });
        return;
      }
      if (drag && drag.id === e.pointerId) {
        actionsRef.current.applyView(v.zoom, {
          x: drag.startPan.x + (e.clientX - drag.startX),
          y: drag.startPan.y + (e.clientY - drag.startY),
        });
      }
    }

    function endPointer(e: PointerEvent) {
      pointers.delete(e.pointerId);
      try {
        stage.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (pointers.size < 2) pinch = null;
      if (drag && drag.id === e.pointerId) {
        drag = null;
        stage.classList.remove('is-grabbing');
      }
    }

    function toggleFit100(focal: Vec2) {
      const v = viewRef.current;
      if (v.zoom === 1) {
        const s0 = studioEffectiveScale(v.fitScale, v.zoom);
        const nz = zoomForEffectiveScale(v.fitScale, 1); // 100% (1 device px : 1 screen px)
        const s1 = studioEffectiveScale(v.fitScale, nz);
        actionsRef.current.applyView(nz, panForFocalZoom(v.pan, s0, s1, focal));
      } else {
        actionsRef.current.applyView(1, { x: 0, y: 0 }); // Fit
      }
    }

    function onDblClick(e: MouseEvent) {
      toggleFit100(focalFrom(e.clientX, e.clientY));
    }

    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('pointerdown', onPointerDown);
    stage.addEventListener('pointermove', onPointerMove);
    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', endPointer);
    stage.addEventListener('dblclick', onDblClick);

    return () => {
      stage.removeEventListener('wheel', onWheel);
      stage.removeEventListener('pointerdown', onPointerDown);
      stage.removeEventListener('pointermove', onPointerMove);
      stage.removeEventListener('pointerup', endPointer);
      stage.removeEventListener('pointercancel', endPointer);
      stage.removeEventListener('dblclick', onDblClick);
      stage.classList.remove('is-grabbing');
    };
  }, [stageRef]);

  // Keyboard nav — arrows pan, +/- zoom (about center), 0 fits. Only while the
  // studio owns input (suppress-hotkeys ON) and never while typing in a form
  // control (the Props editor).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const v = viewRef.current;
      if (!v.ownsInput) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;

      const zoomAboutCenter = (dir: 1 | -1) => {
        const s0 = studioEffectiveScale(v.fitScale, v.zoom);
        const nz = zoomStep(v.fitScale, v.zoom, dir);
        const s1 = studioEffectiveScale(v.fitScale, nz);
        actionsRef.current.applyView(nz, panForFocalZoom(v.pan, s0, s1, { x: 0, y: 0 }));
      };
      const nudge = (dx: number, dy: number) => actionsRef.current.applyView(v.zoom, { x: v.pan.x + dx, y: v.pan.y + dy });

      switch (e.key) {
        case '+':
        case '=':
          e.preventDefault();
          zoomAboutCenter(1);
          break;
        case '-':
        case '_':
          e.preventDefault();
          zoomAboutCenter(-1);
          break;
        case '0':
          e.preventDefault();
          actionsRef.current.applyView(1, { x: 0, y: 0 });
          break;
        case 'ArrowLeft':
          e.preventDefault();
          nudge(KEY_PAN_STEP_PX, 0);
          break;
        case 'ArrowRight':
          e.preventDefault();
          nudge(-KEY_PAN_STEP_PX, 0);
          break;
        case 'ArrowUp':
          e.preventDefault();
          nudge(0, KEY_PAN_STEP_PX);
          break;
        case 'ArrowDown':
          e.preventDefault();
          nudge(0, -KEY_PAN_STEP_PX);
          break;
        default:
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
