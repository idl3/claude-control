import { useEffect, useState } from 'react';
import { authFetch } from '../lib/api';
import { Lightbox } from './AttachmentPreview';
import { APP_HEIGHT_DEFAULT, type EmbedKind, type EmbedSize } from '../lib/embeds';
import { reservedAspectRatio, reservedBox, setCachedAspectRatio } from '../lib/mediaDimensions';
import { resolveMediaUrl } from '../lib/mediaUrl';
import { EmbeddedApp } from './EmbeddedApp';

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
  'data-width'?: string;
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
    'data-width': width,
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
        width={width === 'wide' ? 'wide' : width === 'medium' ? 'medium' : 'default'}
      />
    );
  }
  if (!rest.src) return <img {...rest} />;
  return <PlainMarkdownImage src={rest.src} alt={rest.alt} />;
}
