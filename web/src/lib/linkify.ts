/**
 * Pure URL-detection + linkification helpers shared by every rendering path
 * that can contain a bare `http(s)://` URL in the assistant transcript:
 * prose text (handled today by remark-gfm's autolinker), inline `code`, and
 * fenced code blocks (both the highlight.js-rendered and plain-text-fallback
 * branches — see MarkdownText.tsx's `CodeHighlighter`). remark-gfm only
 * autolinks URLs in prose; it never looks inside code spans/blocks (that's
 * the CommonMark spec — code spans/blocks are verbatim, no inline parsing),
 * which is the bug this module exists to fix.
 *
 * Every helper here is a pure function with no React context/hook
 * dependency, so it's trivial to unit-test (see linkify.vitest.ts) and to
 * reuse from both the markdown pipeline and the popover positioning logic.
 */
import { createElement, Fragment, type ReactNode } from 'react';

// ── URL matching ─────────────────────────────────────────────────────────

/**
 * Matches a run of an http(s) URL, greedy up to (but excluding) whitespace
 * or a small set of characters that are never legally part of a bare URL
 * written in prose/markdown/code (angle brackets — markdown link/autolink
 * delimiters and blockquote markers; quotes and backtick — string/code
 * delimiters). This deliberately over-matches trailing punctuation (a
 * sentence-ending period, a comma before the next clause, a stray closing
 * paren/bracket that belongs to the surrounding prose, not the URL) —
 * `stripTrailingPunctuation` below trims that off explicitly as a separate,
 * readable step, rather than folding the trim into a denser regex.
 */
export const URL_RE = /https?:\/\/[^\s<>"'`]+/;

// Trailing characters that are far more likely to be prose punctuation
// following the URL than part of the URL itself.
const TRAILING_PUNCT_CHARS = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', "'", '"']);

/**
 * Strips trailing punctuation off a raw regex match, one character at a
 * time, re-evaluating after each strip (so e.g. a trailing `.").` peels off
 * in three separate, individually-justified steps). A trailing `)` is kept
 * — not stripped — when it's balanced by an earlier `(` inside the URL
 * (Wikipedia-style URLs such as `.../wiki/Bracket_(disambiguation)` are
 * common enough to special-case); every other trailing punctuation
 * character above is always stripped.
 */
export function stripTrailingPunctuation(url: string): string {
  let result = url;
  for (;;) {
    const last = result[result.length - 1];
    if (!last || !TRAILING_PUNCT_CHARS.has(last)) break;
    if (last === ')') {
      const opens = (result.match(/\(/g) ?? []).length;
      const closes = (result.match(/\)/g) ?? []).length;
      if (closes <= opens) break; // balanced (or under-balanced) — keep it
    }
    result = result.slice(0, -1);
  }
  return result;
}

export type Segment = { kind: 'text'; value: string } | { kind: 'url'; value: string };

/**
 * The pure core of linkification: splits `text` into alternating text/url
 * segments. Adjacent text is preserved verbatim; empty segments are never
 * emitted. A fresh global RegExp is constructed per call (rather than
 * reusing a module-level stateful one) so this function has no hidden
 * shared-state footgun across calls/tests.
 */
export function splitOnUrls(text: string): Segment[] {
  const re = new RegExp(URL_RE.source, 'g');
  const segments: Segment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const trimmed = stripTrailingPunctuation(match[0]);
    if (trimmed.length === 0) continue; // defensive; can't actually happen ("https://" always survives)
    const start = match.index;
    const end = start + trimmed.length;
    if (start > lastIndex) {
      segments.push({ kind: 'text', value: text.slice(lastIndex, start) });
    }
    segments.push({ kind: 'url', value: trimmed });
    lastIndex = end;
    re.lastIndex = end; // resume scanning right after the trimmed URL, so any trimmed trailing punctuation is re-scanned as plain text
  }
  if (lastIndex < text.length) {
    segments.push({ kind: 'text', value: text.slice(lastIndex) });
  }
  return segments;
}

// ── React-tree linkification ─────────────────────────────────────────────

function linkifyString(text: string, renderUrl: (url: string) => ReactNode): ReactNode {
  const segments = splitOnUrls(text);
  if (segments.length === 0) return text;
  if (segments.length === 1 && segments[0].kind === 'text') return text; // no URL found — return the original string untouched
  return segments.map((seg, i) =>
    createElement(Fragment, { key: i }, seg.kind === 'url' ? renderUrl(seg.value) : seg.value),
  );
}

/**
 * Walks `children` (a react-markdown/JSX `children` value) and linkifies any
 * bare URL found in string content, rendering each one through `renderUrl`.
 * Kept deliberately simple per the module's "small, readable helper" goal:
 * strings are split on URLs, arrays are mapped recursively, and anything
 * else (a already-an-element child, e.g. a `<strong>` produced by nested
 * markdown) is passed through unchanged rather than reaching into its props
 * — those elements render themselves and don't carry raw URL text at this
 * level.
 */
export function linkifyChildren(children: ReactNode, renderUrl: (url: string) => ReactNode): ReactNode {
  if (typeof children === 'string') return linkifyString(children, renderUrl);
  if (Array.isArray(children)) {
    return children.map((child, i) => createElement(Fragment, { key: i }, linkifyChildren(child, renderUrl)));
  }
  return children;
}

// ── highlight.js output → linkified React tree ───────────────────────────

/**
 * Parses highlight.js's HTML output (escaped source text wrapped only in
 * `<span class="hljs-*">` — see MarkdownText.tsx's module doc) via
 * `DOMParser` and re-renders it as a React tree, linkifying any URL found in
 * the (decoded) text content while preserving every hljs `<span>`'s
 * highlight class. This replaces the previous `dangerouslySetInnerHTML`
 * path for the highlighted-code branch: we now walk real DOM nodes instead
 * of trusting the HTML string.
 *
 * ACCEPTED DEGRADATION: a URL that happens to be split across two sibling
 * hljs tokens (e.g. the scheme highlighted differently from the host) links
 * only its longest contiguous run within a single text/span node — hljs
 * essentially never splits a bare URL like this in practice (URLs inside
 * comments/strings/etc. are single tokens), so this is a deliberate,
 * documented tradeoff rather than a bug.
 *
 * Callers should `useMemo` this on `html` — DOMParser + tree construction is
 * needless work to repeat every render.
 */
export function hljsHtmlToNodes(html: string, renderUrl: (url: string) => ReactNode): ReactNode {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return renderHljsNodeList(doc.body.childNodes, renderUrl);
}

function renderHljsNodeList(nodes: NodeListOf<ChildNode>, renderUrl: (url: string) => ReactNode): ReactNode[] {
  const out: ReactNode[] = [];
  nodes.forEach((node, i) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(createElement(Fragment, { key: i }, linkifyString(node.textContent ?? '', renderUrl)));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return; // hljs never emits comments/other node types
    const el = node as Element;
    if (el.tagName.toLowerCase() === 'span') {
      out.push(
        createElement(
          'span',
          { className: el.className || undefined, key: i },
          renderHljsNodeList(el.childNodes, renderUrl),
        ),
      );
      return;
    }
    // Defensive fallback — hljs only ever emits <span>; if some other
    // element sneaks in, render its flattened, linkified text content
    // rather than dropping it silently.
    out.push(createElement(Fragment, { key: i }, linkifyString(el.textContent ?? '', renderUrl)));
  });
  return out;
}

// ── Inline-preview framing heuristic ─────────────────────────────────────

/**
 * Cross-origin `X-Frame-Options`/`frame-ancestors` refusal isn't reliably
 * detectable from the framing document — a blocked iframe just renders
 * blank, with no synchronous error the parent can observe. This resolves
 * the practical proxy the inline-preview overlay uses: if the iframe's
 * `load` event has fired, treat it as loaded; if a fixed timeout elapses
 * without `load` firing, treat it as blocked; otherwise it's still loading.
 */
export function framingFallbackState({
  loadFired,
  timedOut,
}: {
  loadFired: boolean;
  timedOut: boolean;
}): 'loading' | 'loaded' | 'blocked' {
  if (loadFired) return 'loaded';
  if (timedOut) return 'blocked';
  return 'loading';
}

// ── Popover positioning ───────────────────────────────────────────────────

export interface RectLike {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface SizeLike {
  width: number;
  height: number;
}

export interface MenuPosition {
  top: number;
  left: number;
}

/** Gap kept between the menu and both its anchor and the viewport edges. */
const MENU_VIEWPORT_MARGIN = 8;

/**
 * Computes a `position: fixed` top/left for the URL action menu, anchored
 * below-left of `anchor` by default. Flips above the anchor when there
 * isn't room below; clamps to the viewport on every axis so the menu never
 * renders partially (or fully) off-screen, even for an anchor near an edge
 * or a viewport too small to fit the menu in either direction.
 */
export function computeMenuPosition(anchor: RectLike, menu: SizeLike, viewport: SizeLike): MenuPosition {
  let top = anchor.top + anchor.height + MENU_VIEWPORT_MARGIN;
  if (top + menu.height > viewport.height - MENU_VIEWPORT_MARGIN) {
    const aboveTop = anchor.top - menu.height - MENU_VIEWPORT_MARGIN;
    top = aboveTop >= MENU_VIEWPORT_MARGIN ? aboveTop : Math.max(MENU_VIEWPORT_MARGIN, viewport.height - menu.height - MENU_VIEWPORT_MARGIN);
  }

  let left = anchor.left;
  const maxLeft = viewport.width - menu.width - MENU_VIEWPORT_MARGIN;
  left = Math.min(Math.max(left, MENU_VIEWPORT_MARGIN), Math.max(maxLeft, MENU_VIEWPORT_MARGIN));

  return { top, left };
}
