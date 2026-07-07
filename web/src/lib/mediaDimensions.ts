import { EMBED_WIDTH, type EmbedSize } from './embeds';

// Layout-shift prevention for inline transcript media (EmbeddedMedia.tsx /
// MarkdownText.tsx's PlainMarkdownImage). Every image/video reserves a box
// BEFORE the asset loads — a fixed width cap (EMBED_WIDTH, per embed size)
// plus an aspect ratio — so the transcript never reflows out from under the
// reader once the asset finishes loading. A skeleton shimmer fills the box
// until then (styles.css .embed-media-skeleton).

/** Fallback aspect ratio (width / height) reserved before an asset's real
 * dimensions are known. A mild landscape ratio reads fine for the mix of
 * screenshots and screen recordings these embeds carry. */
export const DEFAULT_ASPECT_RATIO = 16 / 9;

// Natural aspect ratio per URL, populated once an asset actually loads
// (img onLoad naturalWidth/naturalHeight, video onLoadedMetadata). In-memory
// only for the life of the tab — no persistence — so a re-render/remount of
// the same URL (e.g. scrolling a message back into view) reserves its EXACT
// ratio instead of the default, but a fresh page load starts cold.
const dimensionCache = new Map<string, number>();

/** Cached aspect ratio for `url`, or undefined if never recorded. */
export function getCachedAspectRatio(url: string): number | undefined {
  return dimensionCache.get(url);
}

/** Record `url`'s natural aspect ratio. Ignores non-positive dimensions
 * (a load event firing with a broken/zero-size asset shouldn't poison the
 * cache with an unusable ratio). */
export function setCachedAspectRatio(url: string, width: number, height: number): void {
  if (width > 0 && height > 0) dimensionCache.set(url, width / height);
}

/** The aspect ratio to reserve for `url` right now: the cached exact value
 * when known, else the default. */
export function reservedAspectRatio(url: string): number {
  return dimensionCache.get(url) ?? DEFAULT_ASPECT_RATIO;
}

export interface ReservedBox {
  /** CSS width value — the size's mapped cap (EMBED_WIDTH). */
  width: string;
  /** CSS aspect-ratio value for the container. */
  aspectRatio: number;
}

/** Reserved box for one `<embedded-image|video>` at `size`, keyed by `url`
 * for the aspect-ratio cache lookup. Unknown/missing sizes fall back to md,
 * matching EmbeddedMedia's existing `EMBED_WIDTH[size] ?? EMBED_WIDTH.md`. */
export function reservedBox(size: EmbedSize, url: string): ReservedBox {
  return {
    width: EMBED_WIDTH[size] ?? EMBED_WIDTH.md,
    aspectRatio: reservedAspectRatio(url),
  };
}
