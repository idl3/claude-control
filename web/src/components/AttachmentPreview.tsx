import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { authFetch, uploadServeUrl } from '../lib/api';
import { prefersReducedMotion } from '../lib/anim';
import {
  clampPan,
  clampScale,
  fitScale,
  LIGHTBOX_MAX_SCALE,
  LIGHTBOX_MIN_SCALE,
  nextZoomStep,
  touchDistance,
  touchMidpoint,
  type Point,
  type Size,
} from '../lib/lightboxZoom';
import { XIcon } from './icons';

/**
 * Fetch an upload by basename through authFetch (sends the bearer header) and
 * expose it as an object URL. `<img src>` / `<a href>` can't carry an
 * Authorization header, so when a token is set we must fetch the bytes and
 * blob-URL them instead of pointing the element at the raw path. Returns the
 * object URL (revoked on unmount/basename change) or null while loading/failed.
 */
function useAuthedBlobUrl(basename: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    authFetch(uploadServeUrl(basename))
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (!blob || revoked) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        /* leave null — the element renders empty/broken, acceptable for a preview */
      });
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [basename]);
  return url;
}

// Image extensions we render as thumbnails (must match server IMAGE_MIME keys).
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.heic', '.heif', '.svg']);

// Match absolute upload paths embedded in message text, e.g.:
//   /Users/ernie/.claude-control/uploads/1717000000000-photo.jpg
// The uploads dir may vary; we match on the known segment pattern.
const UPLOAD_PATH_RE = /(?:^|\s)(\/[^\s]*\/\.claude-control\/uploads\/([^\s]+))/g;

export interface UploadRef {
  fullPath: string;
  basename: string;
  isImage: boolean;
}

/** Parse upload path references out of a text string. */
export function parseUploadRefs(text: string): UploadRef[] {
  const refs: UploadRef[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  UPLOAD_PATH_RE.lastIndex = 0;
  while ((m = UPLOAD_PATH_RE.exec(text)) !== null) {
    const fullPath = m[1].trim();
    if (seen.has(fullPath)) continue;
    seen.add(fullPath);
    const basename = m[2];
    const ext = basename.slice(basename.lastIndexOf('.')).toLowerCase();
    refs.push({ fullPath, basename, isImage: IMAGE_EXTS.has(ext) });
  }
  return refs;
}

// ── Lightbox ──────────────────────────────────────────────────────────────────

interface LightboxProps {
  src: string;
  alt: string;
  onClose: () => void;
}

/** Reads a touch's viewport coordinates as a plain Point (see lightboxZoom.ts). */
function touchPoint(t: Touch): Point {
  return { x: t.clientX, y: t.clientY };
}

/** In-progress single/two-finger gesture, tracked across one touchstart →
 * touchmove* → touchend/touchcancel cycle. `onImage` gates double-tap
 * detection to taps that actually started on the image (see touchend). */
type Gesture =
  | { mode: 'pinch'; startDist: number; startScale: number; startMid: Point; startPan: Point }
  | { mode: 'pan'; startPoint: Point; startPan: Point }
  | { mode: 'tap'; startPoint: Point; onImage: boolean };

const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 24;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;

/** The `transform: scale()` multiplier ("cssScale" — see lightboxZoom.ts's
 * module docs) at which the image sits exactly in its laid-out "Fit" box,
 * i.e. untransformed. This is always 1 by construction (the CSS box IS
 * Fit before any scale is applied), independent of the image's natural
 * pixel size — unlike the *effective*-scale value of Fit (see fitScale),
 * which does depend on natural size and is only meaningful once the image
 * has loaded. `scaleRef`/`renderScale` below store cssScale, so this is
 * the single "am I zoomed past Fit at all" threshold used throughout. */
const CSS_SCALE_AT_FIT = 1;

export function Lightbox({ src, alt, onClose }: LightboxProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Live zoom/pan state. `scaleRef`/`panRef` are the source of truth read by
  // the native gesture handlers below (they're set up once, on mount, so a
  // React-state closure would go stale); `renderScale`/`renderPan` mirror
  // them purely to drive the <img> transform + toolbar label on re-render.
  // `applyZoom` is the single path that ever writes either. `scaleRef`
  // stores cssScale (the transform multiplier — see CSS_SCALE_AT_FIT
  // above), NOT the toolbar's natural-pixel-relative effective scale;
  // toggleZoom/stepZoom/pinch/wheel convert to/from effective scale via
  // fitScale() only at the point they need to check the manual [25%,300%]
  // bounds or the 25% step grid.
  const scaleRef = useRef(CSS_SCALE_AT_FIT);
  const panRef = useRef<Point>({ x: 0, y: 0 });
  const [renderScale, setRenderScale] = useState(CSS_SCALE_AT_FIT);
  const [renderPan, setRenderPan] = useState<Point>({ x: 0, y: 0 });
  const [snapping, setSnapping] = useState(false);
  const gestureRef = useRef<Gesture | null>(null);
  const lastTapRef = useRef<{ time: number; point: Point } | null>(null);

  const applyZoom = useCallback((scale: number, pan: Point, animate: boolean) => {
    scaleRef.current = scale;
    panRef.current = pan;
    setSnapping(animate && !prefersReducedMotion());
    setRenderScale(scale);
    setRenderPan(pan);
  }, []);

  /** The image's own laid-out (untransformed) box — constant across zoom,
   * since `transform: scale()` never affects layout. */
  const displayedSize = useCallback((): Size => {
    const img = imgRef.current;
    return { width: img?.offsetWidth ?? 0, height: img?.offsetHeight ?? 0 };
  }, []);

  const naturalSize = useCallback((): Size => {
    const img = imgRef.current;
    return { width: img?.naturalWidth ?? 0, height: img?.naturalHeight ?? 0 };
  }, []);

  /** Fit ↔ 100% (actual pixel size) toggle — shared by double-tap,
   * double-click and the toolbar's middle button. Also doubles as the
   * always-available "return to Fit" affordance from any zoom level (not
   * just from 100%): toggling FROM anything other than Fit always lands
   * back on Fit first. No-ops before the image has finished loading
   * (naturalWidth still 0). */
  const toggleZoom = useCallback(() => {
    const natural = naturalSize();
    if (natural.width === 0) return;
    const displayed = displayedSize();
    const fit = fitScale(natural, displayed);
    const atFit = scaleRef.current === CSS_SCALE_AT_FIT;
    // atFit -> 100% actual pixels (cssScale = 1/fit); otherwise -> Fit
    // (cssScale = 1, by construction always in range — see CSS_SCALE_AT_FIT).
    const target = atFit ? 1 / fit : CSS_SCALE_AT_FIT;
    applyZoom(target, { x: 0, y: 0 }, true);
  }, [applyZoom, displayedSize, naturalSize]);

  /** −/+ toolbar buttons — snap to the next 25%-of-natural-pixels grid stop
   * (see nextZoomStep), clamped to [LIGHTBOX_MIN_SCALE, LIGHTBOX_MAX_SCALE].
   * Fit itself is intentionally not on this grid (it can legitimately fall
   * below 25% for a very large image) — the toolbar's middle button always
   * gets back to Fit regardless of where stepping lands (see toggleZoom). */
  const stepZoom = useCallback(
    (direction: 1 | -1) => {
      const natural = naturalSize();
      if (natural.width === 0) return;
      const displayed = displayedSize();
      const fit = fitScale(natural, displayed);
      const currentEffective = scaleRef.current * fit;
      const nextEffective = nextZoomStep(currentEffective, direction);
      const nextScale = nextEffective / fit;
      applyZoom(nextScale, clampPan(panRef.current, nextScale, displayed), true);
    },
    [applyZoom, displayedSize, naturalSize],
  );

  // Focus the dialog for a11y/Escape, without the browser's default
  // scroll-into-view. Now that the backdrop is portaled straight onto
  // `document.body` (see the return below), there's no scrollable
  // transcript/sub-agent-pane ancestor left to fight over scroll position —
  // `preventScroll` is kept purely as cheap, standard dialog-focus hygiene.
  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
  }, []);

  // Scroll-lock + gesture handling while the Lightbox is open, mounted for
  // the lifetime of this single instance. All of it lives in ONE native
  // (non-React) listener set on the backdrop, deliberately NOT React's
  // synthetic touch/wheel props: React attaches those passively by default,
  // so `preventDefault()` inside them silently no-ops (with a console
  // warning) — fatal for both the pull-to-refresh guard and pinch/wheel zoom
  // below, which all depend on actually blocking the browser's default.
  //  - `lightbox-open` on <html> (styles.css) hard-locks page scroll/rubber-band.
  //  - `touch-action: none` on .lightbox-backdrop/.lightbox-img (styles.css)
  //    tells the browser not to hand these elements' touches to native
  //    scrolling/pinch-zoom, so our own gesture math is the only thing
  //    driving them.
  //  - touchmove preventDefault()s+stopPropagation()s in every case: pinch
  //    and single-finger-pan-while-zoomed are handled below (and still
  //    preventDefault, since native scroll must stay off), and a plain drag
  //    with no recognized gesture falls through to the same
  //    preventDefault+stopPropagation as before — this app also drives its
  //    OWN pull-to-refresh via JS (hooks/usePullToRefresh.ts, bound to the
  //    app root and keyed off `.thread-viewport` scrollTop). Post-portal this
  //    node is no longer a DOM descendant of that root at all, so
  //    stopPropagation is now defensive-only — kept anyway, it's free.
  useEffect(() => {
    document.documentElement.classList.add('lightbox-open');
    const node = dialogRef.current;

    function onTouchStart(e: TouchEvent) {
      const touches = e.touches;
      if (touches.length === 2) {
        const t0 = touchPoint(touches[0]);
        const t1 = touchPoint(touches[1]);
        gestureRef.current = {
          mode: 'pinch',
          startDist: touchDistance(t0, t1),
          startScale: scaleRef.current,
          startMid: touchMidpoint(t0, t1),
          startPan: panRef.current,
        };
        return;
      }
      if (touches.length === 1) {
        const t0 = touchPoint(touches[0]);
        gestureRef.current =
          scaleRef.current > CSS_SCALE_AT_FIT
            ? { mode: 'pan', startPoint: t0, startPan: panRef.current }
            : { mode: 'tap', startPoint: t0, onImage: e.target === imgRef.current };
      }
    }

    function onTouchMove(e: TouchEvent) {
      const gesture = gestureRef.current;
      if (gesture?.mode === 'pinch' && e.touches.length === 2) {
        e.preventDefault();
        e.stopPropagation();
        const t0 = touchPoint(e.touches[0]);
        const t1 = touchPoint(e.touches[1]);
        const displayed = displayedSize();
        // Pinch is CONTINUOUS manual zoom (unlike the +/- buttons' grid
        // snap) — the raw multiplicative gesture delta is applied in
        // effective (natural-pixel-relative) space so it's clamped against
        // the spec's [25%,300%] bounds, then converted back to cssScale for
        // storage/render.
        const fit = fitScale(naturalSize(), displayed);
        const dist = touchDistance(t0, t1);
        const mid = touchMidpoint(t0, t1);
        const rawEffective = gesture.startScale * fit * (dist / gesture.startDist);
        const nextEffective = clampScale(rawEffective, LIGHTBOX_MIN_SCALE, LIGHTBOX_MAX_SCALE);
        const nextScale = nextEffective / fit;
        const nextPan = clampPan(
          {
            x: gesture.startPan.x + (mid.x - gesture.startMid.x),
            y: gesture.startPan.y + (mid.y - gesture.startMid.y),
          },
          nextScale,
          displayed,
        );
        applyZoom(nextScale, nextPan, false);
        return;
      }
      if (gesture?.mode === 'pan' && e.touches.length === 1) {
        e.preventDefault();
        e.stopPropagation();
        const t0 = touchPoint(e.touches[0]);
        const nextPan = clampPan(
          {
            x: gesture.startPan.x + (t0.x - gesture.startPoint.x),
            y: gesture.startPan.y + (t0.y - gesture.startPoint.y),
          },
          scaleRef.current,
          displayedSize(),
        );
        applyZoom(scaleRef.current, nextPan, false);
        return;
      }
      // No recognized multi-touch gesture in progress (plain scroll-attempt
      // drag, or a 'tap' gesture that turned into a move) — the
      // pull-to-refresh / native-scroll guard described above.
      e.preventDefault();
      e.stopPropagation();
    }

    function onTouchEnd(e: TouchEvent) {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      // ponytail: lifting one finger mid-pinch just ends the gesture rather
      // than smoothly handing off to single-finger pan — add a hand-off if
      // that jump ever bothers real users.
      if (gesture?.mode !== 'tap' || !gesture.onImage || e.touches.length > 0) return;
      const now = Date.now();
      const last = lastTapRef.current;
      lastTapRef.current = { time: now, point: gesture.startPoint };
      if (
        last &&
        now - last.time < DOUBLE_TAP_MS &&
        touchDistance(gesture.startPoint, last.point) < DOUBLE_TAP_SLOP_PX
      ) {
        // Suppress the synthesized "ghost click" that would otherwise follow
        // this touchend — without it, the second tap's click would bubble to
        // the backdrop's onClick and close the Lightbox right as it zooms in.
        e.preventDefault();
        lastTapRef.current = null;
        toggleZoom();
      }
    }

    function onTouchCancel() {
      gestureRef.current = null;
    }

    function onWheel(e: WheelEvent) {
      // Always claimed while the Lightbox is open — there is nothing behind
      // this fixed, fully-covering overlay that should scroll or that the
      // browser should page-zoom via ctrl/⌘+wheel.
      e.preventDefault();
      const natural = naturalSize();
      if (natural.width === 0) return;
      const displayed = displayedSize();
      // Continuous manual zoom, same effective-space clamp as pinch above.
      const fit = fitScale(natural, displayed);
      const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_SENSITIVITY);
      const rawEffective = scaleRef.current * fit * factor;
      const nextEffective = clampScale(rawEffective, LIGHTBOX_MIN_SCALE, LIGHTBOX_MAX_SCALE);
      const nextScale = nextEffective / fit;
      applyZoom(nextScale, clampPan(panRef.current, nextScale, displayed), false);
    }

    node?.addEventListener('touchstart', onTouchStart, { passive: true });
    node?.addEventListener('touchmove', onTouchMove, { passive: false });
    node?.addEventListener('touchend', onTouchEnd, { passive: false });
    node?.addEventListener('touchcancel', onTouchCancel, { passive: true });
    node?.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      document.documentElement.classList.remove('lightbox-open');
      node?.removeEventListener('touchstart', onTouchStart);
      node?.removeEventListener('touchmove', onTouchMove);
      node?.removeEventListener('touchend', onTouchEnd);
      node?.removeEventListener('touchcancel', onTouchCancel);
      node?.removeEventListener('wheel', onWheel);
    };
  }, [applyZoom, displayedSize, naturalSize, toggleZoom]);

  // Desktop drag-to-pan (mouse). Only active once zoomed in; plain React
  // handlers are fine here (unlike touch/wheel, mouse events aren't passive
  // by default, so preventDefault works normally).
  const onImgMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (scaleRef.current <= CSS_SCALE_AT_FIT) return;
      e.preventDefault();
      e.stopPropagation();
      const startPoint = { x: e.clientX, y: e.clientY };
      const startPan = panRef.current;
      function onMove(ev: MouseEvent) {
        const nextPan = clampPan(
          { x: startPan.x + (ev.clientX - startPoint.x), y: startPan.y + (ev.clientY - startPoint.y) },
          scaleRef.current,
          displayedSize(),
        );
        applyZoom(scaleRef.current, nextPan, false);
      }
      function onUp() {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [applyZoom, displayedSize],
  );

  // Dismiss on Escape.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [onClose],
  );

  // Any zoomed (non-Fit) state can only be reached through toggleZoom/
  // stepZoom/pinch/wheel, all of which require the image to have already
  // loaded (they early-return while naturalWidth is 0) — so it's always
  // safe to read natural/displayed size here once `zoomed` is true.
  const zoomed = renderScale > CSS_SCALE_AT_FIT;
  const zoomPercent = zoomed
    ? Math.round(renderScale * fitScale(naturalSize(), displayedSize()) * 100)
    : 100;

  return createPortal(
    <div
      className="lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview: ${alt}`}
      ref={dialogRef}
      tabIndex={-1}
      onClick={onClose}
      onKeyDown={onKeyDown}
    >
      {/* Explicit close affordance on top of #172's "tap anywhere closes" —
          not a replacement for it. stopPropagation only so this button's own
          click doesn't ALSO bubble into the backdrop's onClose (harmless
          either way, since onClose is idempotent, but keeps the two dismiss
          paths — X vs backdrop-tap — independently testable/observable). */}
      <button
        type="button"
        className="lightbox-close-btn"
        aria-label="Close"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <XIcon size={20} />
      </button>
      <img
        ref={imgRef}
        className={`lightbox-img${snapping ? ' lightbox-img--snap' : ''}`}
        style={{ transform: `translate(${renderPan.x}px, ${renderPan.y}px) scale(${renderScale})` }}
        data-zoomed={zoomed}
        src={src}
        alt={alt}
        onTransitionEnd={() => setSnapping(false)}
        // A single click/tap on the image no longer closes the Lightbox —
        // that's a deliberate change from the pre-zoom behavior, needed so a
        // tap can start a drag-to-pan or land as one half of a double-tap
        // without also dismissing. Backdrop-click and the explicit close
        // button remain the two dismiss paths.
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => {
          e.stopPropagation();
          toggleZoom();
        }}
        onMouseDown={onImgMouseDown}
      />
      {/* Fit/100%/percentage zoom controls — stopPropagation on every button
          so clicking one doesn't also bubble into the backdrop's onClose. */}
      <div className="lightbox-zoom-controls" onClick={(e) => e.stopPropagation()}>
        <button type="button" aria-label="Zoom out" onClick={() => stepZoom(-1)}>
          −
        </button>
        <button type="button" aria-label="Toggle fit / 100% zoom" onClick={toggleZoom}>
          {zoomed ? `${zoomPercent}%` : 'Fit'}
        </button>
        <button type="button" aria-label="Zoom in" onClick={() => stepZoom(1)}>
          +
        </button>
      </div>
    </div>,
    document.body,
  );
}

// ── Single attachment chip/thumbnail ─────────────────────────────────────────

interface AttachPreviewProps {
  ref_: UploadRef;
}

export function AttachPreviewItem({ ref_ }: AttachPreviewProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  // Fetched with the bearer header and exposed as an object URL (img/href can't
  // send Authorization). Null while loading / on failure.
  const serveUrl = useAuthedBlobUrl(ref_.basename);

  if (!ref_.isImage) {
    // Non-image: render a tappable file chip linking to the blob download.
    return (
      <a
        className="transcript-file-chip"
        href={serveUrl ?? undefined}
        download={ref_.basename}
        aria-label={`Download ${ref_.basename}`}
        title={ref_.basename}
        aria-disabled={serveUrl ? undefined : true}
      >
        <span className="chip-icon" aria-hidden="true">📎</span>
        <span className="chip-name">{ref_.basename}</span>
      </a>
    );
  }

  return (
    <>
      <button
        type="button"
        className="transcript-thumb-btn"
        aria-label={`Preview ${ref_.basename}`}
        title={ref_.basename}
        onClick={() => setLightboxOpen(true)}
      >
        {serveUrl ? (
          <img
            className="transcript-thumb"
            src={serveUrl}
            alt={ref_.basename}
            loading="lazy"
          />
        ) : (
          <span className="transcript-thumb transcript-thumb-loading" aria-hidden="true" />
        )}
      </button>
      {lightboxOpen && serveUrl ? (
        <Lightbox
          src={serveUrl}
          alt={ref_.basename}
          onClose={() => setLightboxOpen(false)}
        />
      ) : null}
    </>
  );
}

// ── Inline previews block ─────────────────────────────────────────────────────

interface InlineAttachmentPreviewsProps {
  text: string;
}

/**
 * Scans `text` for upload path references and renders a row of inline
 * thumbnails (images) or file chips (non-images). Returns null when no
 * references are found so callers can skip rendering entirely.
 */
export function InlineAttachmentPreviews({ text }: InlineAttachmentPreviewsProps) {
  const refs = parseUploadRefs(text);
  if (refs.length === 0) return null;

  return (
    <div className="transcript-attachments" aria-label="Attachments">
      {refs.map((r) => (
        <AttachPreviewItem key={r.fullPath} ref_={r} />
      ))}
    </div>
  );
}
