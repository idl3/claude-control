// Inline media embeds in transcript markdown.
//
// Agent responses may contain self-closing blocks:
//   <embedded-image url="…" size="sm|md|lg|full" />
//   <embedded-video url="…" size="sm|md|lg|full" />
// react-markdown (no rehype-raw) renders raw HTML as escaped literal text, so
// remarkEmbeds() rewrites the mdast `html` nodes into `image` nodes carrying
// data-embed / data-size / data-url props. MarkdownText maps `img` to
// EmbeddedMedia (components/EmbeddedMedia.tsx), which renders a real <img> /
// <video controls> — no raw HTML is ever injected. Text around the tags (and
// html that contains no embed tag) renders exactly as before.

export type EmbedKind = 'image' | 'video';
export type EmbedSize = 'sm' | 'md' | 'lg' | 'full';

// Mapped widths (full = 100% of the bubble). Missing/unknown size → md.
export const EMBED_WIDTH: Record<EmbedSize, string> = {
  sm: '240px',
  md: '420px',
  lg: '640px',
  full: '100%',
};

const TAG_RE = /<embedded-(image|video)\b([^<>]*?)\/>/g;

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
    const parsed = parseEmbedAttrs(m[2]);
    if (parsed) {
      out.push(embedNode(m[1] as EmbedKind, parsed.url, parsed.size));
    } else {
      out.push({ type: 'text', value: m[0] }); // malformed (no url) — keep visible
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
