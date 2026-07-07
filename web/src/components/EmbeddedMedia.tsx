import { useEffect, useState } from 'react';
import { authFetch } from '../lib/api';
import { Lightbox } from './AttachmentPreview';
import type { EmbedKind, EmbedSize } from '../lib/embeds';
import { reservedAspectRatio, reservedBox, setCachedAspectRatio } from '../lib/mediaDimensions';

/**
 * Renders one <embedded-image|video …/> transcript block as a real <img> /
 * <video controls> at the mapped width (lib/embeds.ts EMBED_WIDTH).
 *
 * url handling (trust boundary — keep in sync with the server route):
 *  - http(s) URLs go straight into src (same as any markdown image today).
 *  - any other scheme (file:, data:, javascript:, …) and protocol-relative
 *    "//host" urls are rejected — a small inline chip, nothing fetched.
 *  - bare/relative paths are fetched from /api/media/<path> with the bearer
 *    header (media elements can't send Authorization) and blob-URL'd, same
 *    pattern as AttachmentPreview's upload thumbnails.
 *
 * Layout shift: the container reserves a fixed box (EMBED_WIDTH cap + an
 * aspect-ratio — the exact one once lib/mediaDimensions has seen this url
 * load before, else a default) the moment it mounts, with a skeleton shimmer
 * filling it until the asset's load event fires. The asset then object-fits
 * within that same box, so nothing reflows when it finishes loading.
 */

const HTTP_RE = /^https?:\/\//i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function mediaServeUrl(rel: string): string {
  return `/api/media/${encodeURIComponent(rel)}`;
}

function useMediaSrc(url: string): { src: string | null; rejected: boolean } {
  const direct = HTTP_RE.test(url);
  const rejected =
    !direct && (!url || SCHEME_RE.test(url) || url.startsWith('//'));
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    if (direct || rejected) return;
    let alive = true;
    let objectUrl: string | null = null;
    authFetch(mediaServeUrl(url))
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (!blob || !alive) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      })
      .catch(() => {
        /* leave null — the loading placeholder stays, acceptable for media */
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setBlobUrl(null);
    };
  }, [url, direct, rejected]);

  if (direct) return { src: url, rejected: false };
  return { src: blobUrl, rejected };
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
  const { src, rejected } = useMediaSrc(url);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Frozen at mount: onLoad writes the real ratio into the cache, and reading
  // it here would resize the frame the moment the asset lands — the exact
  // first-load jump this reservation exists to prevent. Only the NEXT mount
  // of this url gets the exact ratio.
  const [box] = useState(() => reservedBox(size, url));

  if (rejected) {
    return <code className="embed-media-rejected">media url rejected: {url}</code>;
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
// remarkEmbeds, marked via data-embed) become EmbeddedMedia; every other
// markdown image gets the same reserved-box + skeleton treatment via
// PlainMarkdownImage, at the bubble's full width (no size attribute to cap it).
type MdImgProps = {
  node?: unknown;
  'data-embed'?: string;
  'data-size'?: string;
  'data-url'?: string;
} & React.ImgHTMLAttributes<HTMLImageElement>;

function PlainMarkdownImage({ src, alt }: { src: string; alt?: string }) {
  const [loaded, setLoaded] = useState(false);
  // Frozen at mount — same reasoning as EmbeddedMedia's box above.
  const [aspectRatio] = useState(() => reservedAspectRatio(src));

  return (
    <span className="embed-media-frame" style={{ width: '100%', aspectRatio }}>
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
      />
      {!loaded ? <span className="embed-media-skeleton" aria-hidden="true" /> : null}
    </span>
  );
}

export function MarkdownImg(props: MdImgProps) {
  const {
    node: _node,
    'data-embed': kind,
    'data-size': size,
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
  if (!rest.src) return <img {...rest} />;
  return <PlainMarkdownImage src={rest.src} alt={rest.alt} />;
}
