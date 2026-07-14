// Inline media + micro-app embeds in transcript markdown.
//
// Agent responses may contain self-closing blocks:
//   <embedded-image url="…" size="sm|md|lg|full" />
//   <embedded-video url="…" size="sm|md|lg|full" />
//   <embedded-app url="…" height="160-800" width="wide"? />
// react-markdown (no rehype-raw) renders raw HTML as escaped literal text, so
// remarkEmbeds() rewrites the mdast `html` nodes into `image` nodes carrying
// data-embed / data-size|data-height / data-url props. MarkdownText maps
// `img` to MarkdownImg (components/EmbeddedMedia.tsx), which renders a real
// <img> / <video controls> for image|video and a sandboxed <iframe> for app —
// no raw HTML is ever injected into the transcript DOM directly (the app's
// HTML is set via `srcDoc` on an opaque-origin sandboxed iframe, never
// dangerouslySetInnerHTML'd into the page). Text around the tags (and html
// that contains no embed tag) renders exactly as before.

export type EmbedKind = 'image' | 'video';
export type EmbedSize = 'sm' | 'md' | 'lg' | 'full';
// <embedded-app width="…"> — 'wide' opts a presentation-type app (slide
// deck / webpage / dashboard, see the create-artifact skill's html/react
// lanes) into the widened, desktop/iPad-only reserved box (styles.css
// .embed-app-frame--wide). Missing/unknown value → 'default' (today's
// APP_FRAME_MAX_WIDTH cap, every breakpoint).
export type EmbedAppWidth = 'default' | 'wide';

// Mapped widths (full = 100% of the bubble). Missing/unknown size → md.
export const EMBED_WIDTH: Record<EmbedSize, string> = {
  sm: '240px',
  md: '420px',
  lg: '640px',
  full: '100%',
};

// <embedded-app height="…"> bounds (px). Missing/invalid/out-of-range → default.
export const APP_HEIGHT_MIN = 160;
export const APP_HEIGHT_MAX = 800;
export const APP_HEIGHT_DEFAULT = 360;
// Reserved-frame width cap for app embeds — same cap as the `lg` media size,
// wide enough for a real widget without blowing out the transcript bubble.
export const APP_FRAME_MAX_WIDTH = '640px';

export const TAG_RE = /<embedded-(image|video|app)\b([^<>]*?)\/>/g;

// Minimal mdast shape — enough to walk and rewrite without pulling in @types/mdast.
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  [key: string]: unknown;
}

/** Parse one tag's attribute string. Returns null when there is no url. */
export function parseEmbedAttrs(
  attrs: string,
): { url: string; size: EmbedSize } | null {
  const url = /(?:^|\s)url="([^"]+)"/.exec(attrs)?.[1];
  if (!url) return null;
  const size = /(?:^|\s)size="(sm|md|lg|full)"/.exec(attrs)?.[1] as
    | EmbedSize
    | undefined;
  return { url, size: size ?? 'md' };
}

/**
 * Parse an `<embedded-app>` tag's attribute string. Returns null when there
 * is no url. `height` is clamped to [APP_HEIGHT_MIN, APP_HEIGHT_MAX]; a
 * missing or non-numeric value falls back to APP_HEIGHT_DEFAULT. `width` is
 * 'wide' only for an exact `width="wide"` match; anything else (missing,
 * unrecognized value) falls back to 'default' — same robustness contract as
 * `size` in parseEmbedAttrs above.
 */
export function parseEmbedAppAttrs(
  attrs: string,
): { url: string; height: number; width: EmbedAppWidth } | null {
  const url = /(?:^|\s)url="([^"]+)"/.exec(attrs)?.[1];
  if (!url) return null;
  const raw = /(?:^|\s)height="(-?\d+)"/.exec(attrs)?.[1];
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : NaN;
  const height = Number.isFinite(parsed)
    ? Math.min(APP_HEIGHT_MAX, Math.max(APP_HEIGHT_MIN, parsed))
    : APP_HEIGHT_DEFAULT;
  const width: EmbedAppWidth =
    /(?:^|\s)width="wide"/.exec(attrs) !== null ? 'wide' : 'default';
  return { url, height, width };
}

// mdast image node carrying the embed props. The raw url rides in data-url
// (react-markdown percent-encodes `src` via its urlTransform; the component
// needs the untouched value to build the /api/media/ fetch or reject schemes).
function embedNode(kind: EmbedKind, url: string, size: EmbedSize): MdNode {
  return {
    type: 'image',
    url,
    alt: '',
    data: { hProperties: { dataEmbed: kind, dataSize: size, dataUrl: url } },
  };
}

// Same node-planting mechanism as embedNode, distinct data-embed='app'.
// height rides as a string (like dataSize) — MarkdownImg re-parses it, so
// there is one source of truth for "what does an invalid/missing value mean"
// (parseEmbedAppAttrs) rather than relying on hProperties value-type passthrough.
// width rides the same way, alongside it.
function embedAppNode(url: string, height: number, width: EmbedAppWidth): MdNode {
  return {
    type: 'image',
    url,
    alt: '',
    data: {
      hProperties: {
        dataEmbed: 'app',
        dataHeight: String(height),
        dataWidth: width,
        dataUrl: url,
      },
    },
  };
}

/**
 * Split an mdast `html` node's raw value into replacement nodes: an embed
 * `image` node per tag, text nodes for anything around them. Returns null when
 * the value contains no embed tag (leave the node untouched → today's render).
 */
export function embedNodesFromHtml(value: string): MdNode[] | null {
  TAG_RE.lastIndex = 0;
  if (!TAG_RE.test(value)) return null;
  TAG_RE.lastIndex = 0;
  const out: MdNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(value)) !== null) {
    const before = value.slice(last, m.index);
    if (before.trim()) out.push({ type: 'text', value: before });
    const tag = m[1];
    if (tag === 'app') {
      const parsed = parseEmbedAppAttrs(m[2]);
      out.push(
        parsed
          ? embedAppNode(parsed.url, parsed.height, parsed.width)
          : { type: 'text', value: m[0] }, // malformed (no url) — keep visible
      );
    } else {
      const parsed = parseEmbedAttrs(m[2]);
      out.push(
        parsed
          ? embedNode(tag as EmbedKind, parsed.url, parsed.size)
          : { type: 'text', value: m[0] }, // malformed (no url) — keep visible
      );
    }
    last = m.index + m[0].length;
  }
  const after = value.slice(last);
  if (after.trim()) out.push({ type: 'text', value: after });
  return out;
}

// Recursive walk: replace `html` nodes containing embed tags. Block-level html
// (direct child of root) gets its replacements wrapped in a paragraph so
// inline nodes stay valid; inline html is spliced in place.
function walk(node: MdNode): void {
  if (!node.children) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'html' && typeof child.value === 'string') {
      const repl = embedNodesFromHtml(child.value);
      if (repl) {
        if (node.type === 'root') {
          next.push({ type: 'paragraph', children: repl });
        } else {
          next.push(...repl);
        }
        continue;
      }
    }
    walk(child);
    next.push(child);
  }
  node.children = next;
}

/** remark plugin — add to MarkdownText's remarkPlugins after remark-gfm. */
export function remarkEmbeds() {
  return (tree: MdNode) => walk(tree);
}
