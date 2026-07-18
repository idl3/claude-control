import { memo, useEffect, useMemo, useState } from 'react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import type {
  CodeHeaderProps,
  SyntaxHighlighterProps,
} from '@assistant-ui/react-markdown';
import { useMessage } from '@assistant-ui/react';
import type { TextMessagePartComponent } from '@assistant-ui/react';
import remarkGfm from 'remark-gfm';
import { highlightCode, resolveLanguage } from '../lib/highlight';
import { remarkEmbeds } from '../lib/embeds';
import { remarkDelivery } from '../lib/delivery';
import { remarkUltrathink } from '../lib/reservedTokens';
import { MarkdownImg } from './EmbeddedMedia';
import { MarkdownDiv } from './DeliveryCard';
import { UltrathinkText } from './ReservedTokens';
import { useArtifactPanel, codeArtifactId } from './ArtifactContext';
import { UrlLink } from './UrlLink';
import { linkifyChildren, hljsHtmlToNodes } from '../lib/linkify';

/**
 * GitHub-flavored markdown for assistant/system text parts.
 *
 * Built on assistant-ui's `MarkdownTextPrimitive`, which reads the current
 * text part from message-part context (no `text` prop needed), so it is a
 * drop-in replacement for the `Text` part component. remark-gfm enables
 * tables, strikethrough, task-lists and autolinks (prose only — see
 * lib/linkify.ts's module doc for why code spans/blocks need their own path).
 * Fenced code is highlighted via a lazily-loaded, locally-bundled highlight.js
 * (see lib/highlight.ts) with a dark theme; unknown languages and load
 * failures fall back to the default <pre><code>, styled for the dark compact
 * theme in styles.css under the `.aui-md` wrapper. All content is escaped by
 * react-markdown; the only HTML we ever parse is highlight.js output (which
 * escapes the source and emits only <span class="hljs-*"> wrappers) — and
 * that HTML is parsed via DOMParser into a real React tree (lib/linkify.ts's
 * `hljsHtmlToNodes`), not injected via dangerouslySetInnerHTML, so every URL
 * inside it can be linkified through the same `UrlLink`/popover mechanism as
 * prose and inline code.
 */

// Compact language tag above fenced blocks, with an "open in panel" button.
// The block body is rendered by the SyntaxHighlighter below.
const CodeHeader = ({ language, code }: CodeHeaderProps) => {
  const { open } = useArtifactPanel();
  if (!language) return null;

  const hasCode = typeof code === 'string' && code.length > 0;

  const openInPanel = () => {
    if (!hasCode || typeof code !== 'string') return;
    const title = language || 'code';
    open({
      id: codeArtifactId(language, code),
      kind: 'code',
      title,
      language,
      content: code,
    });
  };

  return (
    <div className="aui-md-code-lang">
      <span className="aui-md-code-lang-name">{language}</span>
      {hasCode ? (
        <button
          type="button"
          className="aui-md-code-open-btn"
          onClick={openInPanel}
          title="Open in side panel"
          aria-label={`Open ${language} code in side panel`}
        >
          ↗
        </button>
      ) : null}
    </div>
  );
};

// renderUrl passed to every code-path linkify call below — module-scope so
// it's a stable reference (no need to recreate a closure per render/branch).
const renderCodeUrl = (url: string) => <UrlLink url={url} variant="code" />;

// Fenced-code rendering. We attempt to highlight via highlight.js (lazy). While
// the highlighter loads — and for unknown languages or failures — we render the
// raw text through the default Pre/Code, linkified. Once highlighted HTML is
// ready we parse it into a linkified React tree (see hljsHtmlToNodes's doc).
const CodeHighlighter = ({ components, language, code }: SyntaxHighlighterProps) => {
  const { Pre, Code } = components;
  const supported = resolveLanguage(language) !== null;
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) {
      setHtml(null);
      return;
    }
    let alive = true;
    setHtml(null);
    highlightCode(language, code)
      .then((res) => {
        if (alive) setHtml(res);
      })
      .catch(() => {
        if (alive) setHtml(null);
      });
    return () => {
      alive = false;
    };
  }, [supported, language, code]);

  // Parsing hljs's HTML into a React tree is pure work re-run identically
  // for the same `html` string — memoize so it isn't redone every render.
  const highlighted = useMemo(
    () => (html != null ? hljsHtmlToNodes(html, renderCodeUrl) : null),
    [html],
  );
  const fallback = useMemo(() => linkifyChildren(code, renderCodeUrl), [code]);

  if (supported && highlighted != null) {
    return (
      <Pre>
        <Code className="hljs">{highlighted}</Code>
      </Pre>
    );
  }
  return (
    <Pre>
      <Code className={supported ? 'hljs' : undefined}>{fallback}</Code>
    </Pre>
  );
};

// Wrap tables in a horizontally-scrollable container so wide tables stay legible
// (the table keeps its natural column widths and scrolls within the bubble,
// instead of being clamped to bubble width and crushing columns to one char).
// `node` is react-markdown's AST node — strip it so it isn't spread onto <table>.
const TableWrap = ({ node: _node, ...props }: { node?: unknown } & React.HTMLAttributes<HTMLTableElement>) => (
  <div className="md-table-wrap">
    <table {...props} />
  </div>
);

// Prose links: remark-gfm autolinks bare URLs into real `<a>` nodes, and
// `[text](url)` markdown links land here too. Anything with an http(s) href
// routes through the shared UrlLink popover (see UrlLink.tsx); anything else
// (mailto:, relative paths, etc.) renders as a plain, unhandled anchor.
const ProseLink = ({ href, children }: { href?: string; children?: React.ReactNode }) =>
  typeof href === 'string' && /^https?:\/\//i.test(href) ? (
    <UrlLink url={href} variant="prose">
      {children}
    </UrlLink>
  ) : (
    <a href={href}>{children}</a>
  );

// Inline `code` (single-backtick spans). This is ALSO the `Code` slot handed
// to CodeHighlighter above for fenced blocks — there, `children` always
// arrives as already-linkified React nodes (an array), so the `typeof`
// check below only ever fires for genuine inline code (a plain string),
// keeping this one component correct for both call sites without double-
// linkifying fenced-block content. `node` is react-markdown's AST node —
// stripped so it isn't spread onto the DOM element.
const InlineCode = ({
  node: _node,
  className,
  children,
  ...rest
}: { node?: unknown; className?: string; children?: React.ReactNode } & React.HTMLAttributes<HTMLElement>) => (
  <code className={className} {...rest}>
    {typeof children === 'string' ? linkifyChildren(children, renderCodeUrl) : children}
  </code>
);

// The `ultrathink` rainbow highlight (lib/reservedTokens.ts remarkUltrathink)
// only ever applies to USER messages — an assistant reply that happens to
// contain the word is never repainted.
//
// remarkDelivery is listed before remarkEmbeds as a readability signal ("the
// delivery blob is consumed first") — the actual reason it isn't fooled by
// remark-gfm's autolink mangling is that it re-derives from the raw VFile
// source rather than the (already gfm-mangled) parsed children; see
// lib/delivery.ts's module doc for why array order among tree-transforms
// can't by itself prevent that mangling (gfm's autolinking is a micromark
// parse-time syntax extension, not a transform).
// Exported so non-text-part callers (e.g. MessageParts' ExitPlanPart, which
// renders ExitPlanMode's `plan` argument through the same markdown pipeline
// via TextMessagePartProvider) can reuse the exact assistant-message config
// instead of duplicating it.
export const BASE_PLUGINS = [remarkGfm, remarkDelivery, remarkEmbeds];
const USER_PLUGINS = [remarkGfm, remarkDelivery, remarkEmbeds, remarkUltrathink];

// Stable module-level component map. All six are module-scope refs, so this
// object never needs to change — hoisting it out of the render body keeps a
// single identity (matches the messageComponents / partComponents pattern) and
// avoids handing react-markdown a fresh `components` object on every render.
export const MD_COMPONENTS = {
  CodeHeader,
  SyntaxHighlighter: CodeHighlighter,
  table: TableWrap,
  // Every clickable URL — prose, inline code, and (via CodeHighlighter above)
  // fenced code blocks — funnels through UrlLink's shared popover.
  a: ProseLink,
  code: InlineCode,
  // <embedded-image|video …/> blocks (rewritten to image nodes by
  // remarkEmbeds) render as real <img>/<video>; other images unchanged.
  img: MarkdownImg,
  // delivery-payload blocks (rewritten to `div[data-delivery]` nodes by
  // remarkDelivery) render as a DeliveryCard; other divs unchanged.
  div: MarkdownDiv,
  // "ultrathink" (remarkUltrathink, user messages only) renders as an
  // animated rainbow gradient <mark>.
  mark: UltrathinkText,
};

const MarkdownTextImpl: TextMessagePartComponent = () => {
  const role = useMessage((m) => m.role);
  const remarkPlugins = useMemo(
    () => (role === 'user' ? USER_PLUGINS : BASE_PLUGINS),
    [role],
  );
  return (
    <MarkdownTextPrimitive
      className="aui-md"
      remarkPlugins={remarkPlugins}
      components={MD_COMPONENTS}
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);
