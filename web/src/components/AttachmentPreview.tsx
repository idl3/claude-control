import { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch, uploadServeUrl } from '../lib/api';
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

/**
 * Walks up from `el` to the nearest ancestor that is actually scrolled
 * (computed overflow-y is auto/scroll AND its content overflows) — a plain,
 * class-name-agnostic detector rather than a hardcoded selector, since the
 * Lightbox mounts from many different panes (main transcript, sub-agent
 * thread, attachments) each with their own scroll container.
 */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node && node !== document.documentElement) {
    const { overflowY } = window.getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

export function Lightbox({ src, alt, onClose }: LightboxProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus the dialog for a11y/Escape, without the browser's default
  // scroll-into-view. The backdrop is `position: fixed` (already covers the
  // full viewport) but is still a DOM descendant of whichever scrollable
  // pane rendered the triggering image, and some engines still try to
  // scroll that ancestor to "reveal" a newly focused descendant — which is
  // what was snapping the transcript to the top on open. `preventScroll`
  // stops that at the source; the scrollTop capture/restore is the belt-
  // and-braces fallback, and also covers the symmetric case on dismiss
  // (this element unmounting shouldn't leave the pane scrolled anywhere
  // other than where the user had it).
  useEffect(() => {
    const node = dialogRef.current;
    const scroller = findScrollParent(node);
    const savedScrollTop = scroller?.scrollTop ?? null;

    node?.focus({ preventScroll: true });
    if (scroller && savedScrollTop !== null && scroller.scrollTop !== savedScrollTop) {
      scroller.scrollTop = savedScrollTop;
    }

    return () => {
      if (scroller && savedScrollTop !== null) {
        scroller.scrollTop = savedScrollTop;
      }
    };
  }, []);

  // Scroll-lock + pull-to-refresh guard while the Lightbox is open. Belt and
  // braces, mounted for the lifetime of this single Lightbox instance:
  //  - `lightbox-open` on <html> (styles.css) hard-locks page scroll/rubber-band.
  //  - `touch-action`/`overscroll-behavior` on .lightbox-backdrop (styles.css)
  //    tell the browser not to hand this element's touches to native scrolling.
  //  - the non-passive touchmove listener below both preventDefaults (blocks
  //    iOS Safari's native pull-to-refresh, which our CSS overscroll-behavior
  //    normally suppresses but a fixed full-viewport overlay can bypass) and
  //    stopPropagation()s — this app also drives its OWN pull-to-refresh via
  //    JS (see hooks/usePullToRefresh.ts, bound to the app root and keyed off
  //    `.thread-viewport` scrollTop). Without stopping propagation here, a
  //    drag on the overlay — which sits inside `.thread-viewport` in the DOM
  //    despite being visually fixed on top — would still bubble to that
  //    listener and could trigger its hard `window.location.reload()`.
  useEffect(() => {
    document.documentElement.classList.add('lightbox-open');
    const node = dialogRef.current;
    const blockTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    node?.addEventListener('touchmove', blockTouchMove, { passive: false });
    return () => {
      document.documentElement.classList.remove('lightbox-open');
      node?.removeEventListener('touchmove', blockTouchMove);
    };
  }, []);

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

  return (
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
      <img className="lightbox-img" src={src} alt={alt} />
    </div>
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
