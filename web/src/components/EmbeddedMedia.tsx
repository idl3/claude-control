import { useEffect, useState } from 'react';
import { authFetch } from '../lib/api';
import { Lightbox } from './AttachmentPreview';
import { APP_FRAME_MAX_WIDTH, APP_HEIGHT_DEFAULT, type EmbedKind, type EmbedSize } from '../lib/embeds';
import { reservedAspectRatio, reservedBox, setCachedAspectRatio } from '../lib/mediaDimensions';
import { resolveMediaUrl } from '../lib/mediaUrl';

/**
 * Renders one <embedded-image|video …/> transcript block as a real <img> /
 * <video controls> at the mapped width (lib/embeds.ts EMBED_WIDTH).
 *
 * url handling (trust boundary — see lib/mediaUrl.ts, kept in sync with the
 * server route):
 *  - http(s) URLs go straight into src (same as any markdown image today).
 *  - any other scheme (file:, data:, javascript:, …), protocol-relative
 *    "//host" urls, and any other absolute path are rejected — a small
 *    inline chip, nothing fetched.
 *  - bare/relative paths are fetched from /api/media/<path> with the bearer
 *    header (media elements can't send Authorization) and blob-URL'd, same
 *    pattern as AttachmentPreview's upload thumbnails. Urls already shaped
 *    like /api/media/<path> are fetched as-is, never re-prefixed.
 *
 * Layout shift: the container reserves a fixed box (EMBED_WIDTH cap + an
 * aspect-ratio — the exact one once lib/mediaDimensions has seen this url
 * load before, else a default) the moment it mounts, with a skeleton shimmer
 * filling it until the asset's load event fires. The asset then object-fits
 * within that same box, so nothing reflows when it finishes loading.
 *
 * Failure: a failed fetch (network error, non-2xx) or a load-time <img>/
 * <video> error both drop the skeleton and render the same rejected-chip
 * treatment as an unsupported url — the skeleton never shimmers forever.
 */

function useMediaSrc(url: string): { src: string | null; rejected: boolean; failed: boolean } {
  const resolution = resolveMediaUrl(url);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    if (resolution.kind !== 'fetch') return;
    let alive = true;
    let objectUrl: string | null = null;
    authFetch(resolution.fetchUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`media fetch failed: ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setBlobUrl(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  if (resolution.kind === 'direct') return { src: resolution.src, rejected: false, failed: false };
  if (resolution.kind === 'rejected') return { src: null, rejected: true, failed: false };
  return { src: blobUrl, rejected: false, failed };
}

export function EmbeddedMedia({
  kind,
  url,
  size,
}: {
  kind: EmbedKind;
  url: string;
  size: EmbedSize;
}) {
  const { src, rejected, failed } = useMediaSrc(url);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Set on an <img>/<video> load-time error event — a blob that fetched fine
  // but the browser couldn't decode (corrupt/unsupported media).
  const [elementFailed, setElementFailed] = useState(false);
  // Frozen at mount: onLoad writes the real ratio into the cache, and reading
  // it here would resize the frame the moment the asset lands — the exact
  // first-load jump this reservation exists to prevent. Only the NEXT mount
  // of this url gets the exact ratio.
  const [box] = useState(() => reservedBox(size, url));

  if (rejected) {
    return <code className="embed-media-rejected">media url rejected: {url}</code>;
  }
  if (failed || elementFailed) {
    return <code className="embed-media-rejected">media unavailable: {url}</code>;
  }

  const frameStyle = {
    width: box.width,
    maxWidth: '100%',
    aspectRatio: box.aspectRatio,
  };

  if (kind === 'video') {
    return (
      <span className="embed-media-frame" style={frameStyle}>
        {src ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption -- agent screen recordings have no caption track
          <video
            className="embed-media"
            controls
            src={src}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              setCachedAspectRatio(url, v.videoWidth, v.videoHeight);
              setLoaded(true);
            }}
            onError={() => setElementFailed(true)}
          />
        ) : null}
        {!loaded ? <span className="embed-media-skeleton" aria-label="loading media" /> : null}
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        className="embed-media-btn embed-media-frame"
        style={frameStyle}
        onClick={() => src && setLightboxOpen(true)}
        aria-label={`Preview ${url}`}
        title={url}
      >
        {src ? (
          <img
            className="embed-media"
            src={src}
            alt={url}
            loading="lazy"
            onLoad={(e) => {
              const img = e.currentTarget;
              setCachedAspectRatio(url, img.naturalWidth, img.naturalHeight);
              setLoaded(true);
            }}
            onError={() => setElementFailed(true)}
          />
        ) : null}
        {!loaded ? <span className="embed-media-skeleton" aria-hidden="true" /> : null}
      </button>
      {lightboxOpen && src ? (
        <Lightbox src={src} alt={url} onClose={() => setLightboxOpen(false)} />
      ) : null}
    </>
  );
}

/**
 * Renders one <embedded-app url="…" height="…" /> transcript block as a
 * sandboxed, isolated live iframe micro-app.
 *
 * url handling — STRICTER than EmbeddedMedia. Apps get real code execution
 * inside the transcript surface, so only local media-root content (operator-
 * trusted, same trust boundary as any other file under ~/.claude-control/media)
 * is allowed: bare/relative paths and urls already shaped like /api/media/…
 * (resolveMediaUrl's 'fetch' branch). http(s) urls — which EmbeddedMedia
 * allows straight through as a hotlinked <img src> — are REJECTED here too: a
 * remote iframe would run arbitrary third-party code inside the cockpit
 * origin's tab, an exfil/XSS surface media elements don't have. Every other
 * scheme, absolute path, or traversal segment is rejected the same as media.
 *
 * The HTML is fetched with authFetch (an <iframe src> can't send the bearer
 * header — the same reason EmbeddedMedia blob-fetches instead of using
 * <img src> directly for relative urls) and set via `srcDoc` on an
 * `sandbox="allow-scripts"` iframe. Deliberately NOT `allow-same-origin`:
 * srcdoc + sandbox WITHOUT allow-same-origin gives the iframe an opaque
 * (null) origin, so the embedded app cannot reach the parent DOM, the
 * cockpit's localStorage bearer token, or any cookie — even though its JS
 * runs. Do not add allow-same-origin here.
 *
 * Layout: like EmbeddedMedia, a reserved box (width capped, fixed height
 * from the `height` attr — already clamped by parseEmbedAppAttrs) is present
 * from mount so there is no scroll jump; a skeleton shimmer fills it until
 * the fetch resolves. A failed/non-ok fetch renders the same rejected-chip
 * treatment as an unsupported url.
 */
function useAppHtml(url: string): { html: string | null; rejected: boolean; failed: boolean } {
  const resolution = resolveMediaUrl(url);
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    setHtml(null);
    if (resolution.kind !== 'fetch') return;
    let alive = true;
    authFetch(resolution.fetchUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`app fetch failed: ${res.status}`);
        return res.text();
      })
      .then((text) => {
        if (alive) setHtml(text);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // resolveMediaUrl's 'direct' branch is media's allowance for http(s)
  // hotlinking — app embeds reject that branch too (see doc comment above),
  // not just 'rejected', so only 'fetch' (local media-root) proceeds.
  if (resolution.kind !== 'fetch') return { html: null, rejected: true, failed: false };
  return { html, rejected: false, failed };
}

export function EmbeddedApp({ url, height }: { url: string; height: number }) {
  const { html, rejected, failed } = useAppHtml(url);

  if (rejected) {
    return <code className="embed-media-rejected">app url rejected: {url}</code>;
  }
  if (failed) {
    return <code className="embed-media-rejected">app unavailable: {url}</code>;
  }

  const frameStyle = {
    width: '100%',
    maxWidth: APP_FRAME_MAX_WIDTH,
    height: `${height}px`,
  };

  return (
    <span className="embed-media-frame embed-app-frame" style={frameStyle}>
      {html != null ? (
        <iframe
          className="embed-app"
          sandbox="allow-scripts"
          srcDoc={html}
          title={url}
        />
      ) : (
        <span className="embed-media-skeleton" aria-label="loading app" />
      )}
    </span>
  );
}

// react-markdown `img` component override: embed image nodes (planted by
// remarkEmbeds, marked via data-embed) become EmbeddedMedia (image|video) or
// EmbeddedApp (app); every other markdown image gets the same reserved-box +
// skeleton treatment via PlainMarkdownImage (bubble's full width, no size
// attribute to cap it), wrapped in the same tap-to-open-Lightbox button as
// EmbeddedMedia.
type MdImgProps = {
  node?: unknown;
  'data-embed'?: string;
  'data-size'?: string;
  'data-height'?: string;
  'data-url'?: string;
} & React.ImgHTMLAttributes<HTMLImageElement>;

function PlainMarkdownImage({ src, alt }: { src: string; alt?: string }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  // Frozen at mount — same reasoning as EmbeddedMedia's box above.
  const [aspectRatio] = useState(() => reservedAspectRatio(src));

  if (failed) {
    return <code className="embed-media-rejected">media unavailable: {src}</code>;
  }

  return (
    <>
      <button
        type="button"
        className="embed-media-btn embed-media-frame"
        style={{ width: '100%', aspectRatio }}
        onClick={() => setLightboxOpen(true)}
        aria-label={alt ? `Preview ${alt}` : 'Preview image'}
      >
        <img
          className="embed-media"
          src={src}
          alt={alt ?? ''}
          loading="lazy"
          onLoad={(e) => {
            const img = e.currentTarget;
            setCachedAspectRatio(src, img.naturalWidth, img.naturalHeight);
            setLoaded(true);
          }}
          onError={() => setFailed(true)}
        />
        {!loaded ? <span className="embed-media-skeleton" aria-hidden="true" /> : null}
      </button>
      {lightboxOpen ? (
        <Lightbox src={src} alt={alt ?? ''} onClose={() => setLightboxOpen(false)} />
      ) : null}
    </>
  );
}

export function MarkdownImg(props: MdImgProps) {
  const {
    node: _node,
    'data-embed': kind,
    'data-size': size,
    'data-height': height,
    'data-url': rawUrl,
    ...rest
  } = props;
  if (kind === 'image' || kind === 'video') {
    return (
      <EmbeddedMedia
        kind={kind}
        url={rawUrl ?? rest.src ?? ''}
        size={(size ?? 'md') as EmbedSize}
      />
    );
  }
  if (kind === 'app') {
    const parsedHeight = Number.parseInt(height ?? '', 10);
    return (
      <EmbeddedApp
        url={rawUrl ?? rest.src ?? ''}
        height={Number.isFinite(parsedHeight) ? parsedHeight : APP_HEIGHT_DEFAULT}
      />
    );
  }
  if (!rest.src) return <img {...rest} />;
  return <PlainMarkdownImage src={rest.src} alt={rest.alt} />;
}
