// Client-side normalization for embedded media urls (EmbeddedMedia.tsx).
//
// Trust boundary — keep in sync with the server's /api/media route
// (server.js handleServeMedia + lib/media.js resolveMediaPath, which
// decodeURIComponents the whole tail and rejects absolute paths / ".."
// segments / symlink escapes via realpath confinement).
//
//  - http(s) urls: used directly as <img>/<video> src, no auth needed.
//  - urls already shaped like /api/media/<path> (e.g. one echoed back out of
//    a previous transcript render): used AS-IS. Re-prefixing these produces
//    /api/media/%2Fapi%2Fmedia%2F... which 404s — the double-prefix bug this
//    module exists to fix.
//  - any other absolute path ("/x"), protocol-relative ("//host/x"), or other
//    scheme (file:, data:, javascript:, …): rejected. No server route serves
//    them, so fetching would just 404 forever.
//  - ".." traversal segments: rejected client-side (the server also rejects
//    them, but there is no reason to round-trip a request that can only 404).
//  - bare/relative paths: built into /api/media/<per-segment-encoded path>,
//    matching how the server decodes it — encoding per path segment (rather
//    than the whole string) keeps literal "/" separators intact instead of
//    becoming "%2F".

const HTTP_RE = /^https?:\/\//i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const MEDIA_ROUTE_PREFIX = '/api/media/';

export type MediaUrlResolution =
  | { kind: 'direct'; src: string }
  | { kind: 'fetch'; fetchUrl: string }
  | { kind: 'rejected' };

/** Normalize a transcript embed url into how EmbeddedMedia should load it. */
export function resolveMediaUrl(url: string): MediaUrlResolution {
  if (!url) return { kind: 'rejected' };
  if (HTTP_RE.test(url)) return { kind: 'direct', src: url };
  if (url.startsWith(MEDIA_ROUTE_PREFIX)) return { kind: 'fetch', fetchUrl: url };
  if (SCHEME_RE.test(url) || url.startsWith('//') || url.startsWith('/')) {
    return { kind: 'rejected' };
  }
  if (url.split(/[/\\]/).some((seg) => seg === '..')) return { kind: 'rejected' };
  const fetchUrl =
    MEDIA_ROUTE_PREFIX + url.split('/').map(encodeURIComponent).join('/');
  return { kind: 'fetch', fetchUrl };
}

/**
 * D2: derive the server's canonical media-root-relative path for an app
 * embed's `url` prop, for comparing against a `media-app-changed` WS frame's
 * `path` field (server.js broadcasts media-root-relative paths, e.g.
 * "apps/counter.html" — see lib/media-watch.js).
 *
 * Reuses resolveMediaUrl so both forms an app can legally be embedded with
 * normalize to the same value: a bare relative url ("apps/counter.html")
 * IS already that path, while an already-prefixed url
 * ("/api/media/apps/counter.html") is decoded back to it. Returns null for
 * anything that doesn't resolve to a local media-root fetch (http(s) or
 * rejected urls never match a frame).
 */
export function mediaAppFramePath(url: string): string | null {
  const resolution = resolveMediaUrl(url);
  if (resolution.kind !== 'fetch') return null;
  const tail = resolution.fetchUrl.slice(MEDIA_ROUTE_PREFIX.length);
  try {
    return tail.split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
}
