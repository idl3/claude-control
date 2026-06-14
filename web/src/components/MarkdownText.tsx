import { memo } from 'react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import type {
  CodeHeaderProps,
  SyntaxHighlighterProps,
} from '@assistant-ui/react-markdown';
import type { TextMessagePartComponent } from '@assistant-ui/react';
import remarkGfm from 'remark-gfm';

/**
 * GitHub-flavored markdown for assistant/system text parts.
 *
 * Built on assistant-ui's `MarkdownTextPrimitive`, which reads the current
 * text part from message-part context (no `text` prop needed), so it is a
 * drop-in replacement for the `Text` part component. remark-gfm enables
 * tables, strikethrough, task-lists and autolinks. No syntax highlighter is
 * registered (keeps the bundle small) — fenced blocks fall back to the
 * default <pre><code>, styled for the dark compact theme in styles.css under
 * the `.aui-md` wrapper. All content is escaped by react-markdown; nothing is
 * passed through dangerouslySetInnerHTML.
 */

// Compact language tag above fenced blocks. The block body is rendered by the
// default Pre/Code components; this is purely the header chrome.
const CodeHeader = ({ language }: CodeHeaderProps) => {
  if (!language) return null;
  return <div className="aui-md-code-lang">{language}</div>;
};

// Default fenced-code rendering (no highlighter) — wraps the supplied Pre/Code.
const PlainHighlighter = ({ components, code }: SyntaxHighlighterProps) => {
  const { Pre, Code } = components;
  return (
    <Pre>
      <Code>{code}</Code>
    </Pre>
  );
};

const MarkdownTextImpl: TextMessagePartComponent = () => (
  <MarkdownTextPrimitive
    className="aui-md"
    remarkPlugins={[remarkGfm]}
    components={{
      CodeHeader,
      SyntaxHighlighter: PlainHighlighter,
    }}
  />
);

export const MarkdownText = memo(MarkdownTextImpl);
