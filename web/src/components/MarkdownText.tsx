import { memo, useEffect, useState } from 'react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import type {
  CodeHeaderProps,
  SyntaxHighlighterProps,
} from '@assistant-ui/react-markdown';
import type { TextMessagePartComponent } from '@assistant-ui/react';
import remarkGfm from 'remark-gfm';
import { highlightCode, resolveLanguage } from '../lib/highlight';

/**
 * GitHub-flavored markdown for assistant/system text parts.
 *
 * Built on assistant-ui's `MarkdownTextPrimitive`, which reads the current
 * text part from message-part context (no `text` prop needed), so it is a
 * drop-in replacement for the `Text` part component. remark-gfm enables
 * tables, strikethrough, task-lists and autolinks. Fenced code is highlighted
 * via a lazily-loaded, locally-bundled highlight.js (see lib/highlight.ts) with
 * a dark theme; unknown languages and load failures fall back to the default
 * <pre><code>, styled for the dark compact theme in styles.css under the
 * `.aui-md` wrapper. All content is escaped by react-markdown; the only HTML we
 * inject is highlight.js output, which escapes the source and emits only
 * <span class="hljs-*"> wrappers.
 */

// Compact language tag above fenced blocks. The block body is rendered by the
// SyntaxHighlighter below; this is purely the header chrome.
const CodeHeader = ({ language }: CodeHeaderProps) => {
  if (!language) return null;
  return <div className="aui-md-code-lang">{language}</div>;
};

// Fenced-code rendering. We attempt to highlight via highlight.js (lazy). While
// the highlighter loads — and for unknown languages or failures — we render the
// raw, React-escaped text through the default Pre/Code. Once highlighted HTML is
// ready we inject it (hljs output is safe, see module doc above).
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

  if (supported && html != null) {
    return (
      <Pre>
        <Code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </Pre>
    );
  }
  return (
    <Pre>
      <Code className={supported ? 'hljs' : undefined}>{code}</Code>
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

const MarkdownTextImpl: TextMessagePartComponent = () => (
  <MarkdownTextPrimitive
    className="aui-md"
    remarkPlugins={[remarkGfm]}
    components={{
      CodeHeader,
      SyntaxHighlighter: CodeHighlighter,
      table: TableWrap,
    }}
  />
);

export const MarkdownText = memo(MarkdownTextImpl);
