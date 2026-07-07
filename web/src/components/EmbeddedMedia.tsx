import { useEffect, useState } from 'react';
import { authFetch } from '../lib/api';
import { Lightbox } from './AttachmentPreview';
import { EMBED_WIDTH, type EmbedKind, type EmbedSize } from '../lib/embeds';

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
  const width = EMBED_WIDTH[size] ?? EMBED_WIDTH.md;

  if (rejected) {
    return <code className="embed-media-rejected">media url rejected: {url}</code>;
  }

  if (kind === 'video') {
    return src ? (
      // eslint-disable-next-line jsx-a11y/media-has-caption -- agent screen recordings have no caption track
      <video
        className="embed-media"
        controls
        src={src}
        style={{ width, maxWidth: '100%' }}
      />
    ) : (
      <span
        className="embed-media embed-media-loading"
        style={{ width, maxWidth: '100%' }}
        aria-label="loading media"
      />
    );
  }

  return (
    <>
      <button
        type="button"
        className="embed-media-btn"
        style={{ width, maxWidth: '100%' }}
        onClick={() => src && setLightboxOpen(true)}
        aria-label={`Preview ${url}`}
        title={url}
      >
        {src ? (
          <img className="embed-media" src={src} alt={url} loading="lazy" />
        ) : (
          <span className="embed-media embed-media-loading" aria-hidden="true" />
        )}
      </button>
      {lightboxOpen && src ? (
        <Lightbox src={src} alt={url} onClose={() => setLightboxOpen(false)} />
      ) : null}
    </>
  );
}

// react-markdown `img` component override: embed image nodes (planted by
// remarkEmbeds, marked via data-embed) become EmbeddedMedia; every other
// markdown image renders exactly as before.
type MdImgProps = {
  node?: unknown;
  'data-embed'?: string;
  'data-size'?: string;
  'data-url'?: string;
} & React.ImgHTMLAttributes<HTMLImageElement>;

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
  return <img {...rest} />;
}
