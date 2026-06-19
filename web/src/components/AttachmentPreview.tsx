import { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch, uploadServeUrl } from '../lib/api';

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

export function Lightbox({ src, alt, onClose }: LightboxProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus trap: move focus to the dialog on open.
  useEffect(() => {
    dialogRef.current?.focus();
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
      <img
        className="lightbox-img"
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()} // tap on image doesn't dismiss
      />
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
