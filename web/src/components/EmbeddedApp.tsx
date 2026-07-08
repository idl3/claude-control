import { APP_FRAME_MAX_WIDTH } from '../lib/embeds';
import { resolveMediaUrl } from '../lib/mediaUrl';

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
 *
 * The live iframe itself does NOT live here. Transcript row DOM churns on
 * every message-list update (A2 churn-spike verdict — see
 * docs/plans/cockpit-pinned-artifacts/phase-a-tasks.md, A3), and a moved/
 * reparented iframe reloads by spec regardless of why it moved. This
 * component renders only a placeholder (a `data-embed-app-url`/
 * `data-embed-app-height` span, cheap to remount) that AppFrameLayer.tsx
 * tracks from a single always-mounted portal layer — the fetch, the
 * skeleton, and the failed-chip for fetch errors all happen there. The
 * rejected-url check stays here since it's synchronous and belongs inline
 * in the transcript flow, not floating in the hoisted layer.
 */
export function EmbeddedApp({ url, height }: { url: string; height: number }) {
  const resolution = resolveMediaUrl(url);

  // resolveMediaUrl's 'direct' branch is media's allowance for http(s)
  // hotlinking — app embeds reject that branch too (see doc comment above),
  // not just 'rejected', so only 'fetch' (local media-root) proceeds.
  if (resolution.kind !== 'fetch') {
    return <code className="embed-media-rejected">app url rejected: {url}</code>;
  }

  const frameStyle = {
    width: '100%',
    maxWidth: APP_FRAME_MAX_WIDTH,
    height: `${height}px`,
  };

  return (
    <span
      className="embed-media-frame embed-app-frame"
      style={frameStyle}
      data-embed-app-url={url}
      data-embed-app-height={height}
      aria-label="embedded app"
    />
  );
}
