import { useState } from 'react';
import type {
  ImageMessagePartComponent,
  ReasoningMessagePartComponent,
  TextMessagePartComponent,
  ToolCallMessagePartComponent,
} from '@assistant-ui/react';
import { toolInput, toolResult, toolSummary } from '../lib/convert';
import { fileUrl } from '../lib/api';
import { MarkdownText } from './MarkdownText';
import { useLightbox } from './Lightbox';

// Inline image preview (uploaded attachment surfaced in the transcript). The
// `image` field carries the absolute uploaded path; we fetch it back through the
// token-gated /api/file route. Tap to open the lightbox. If the server refuses
// the path (not inside its uploads dir), the <img> errors and we render nothing.
export const ImagePart: ImageMessagePartComponent = ({ image }) => {
  const { open } = useLightbox();
  const [failed, setFailed] = useState(false);
  if (!image || failed) return null;
  const src = fileUrl(image);
  return (
    <img
      className="transcript-img"
      src={src}
      alt=""
      loading="lazy"
      role="button"
      tabIndex={0}
      title="Open preview"
      onClick={() => open(src)}
      onError={() => setFailed(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open(src);
        }
      }}
    />
  );
};

// The optimistic "Working…" placeholder (App.tsx, while Claude's real reply is
// pending) renders as an animated spinner; everything else is GitHub-flavored
// markdown (see MarkdownText).
const WORKING_RE = /^\s*working…?\s*$/i;
export const TextPart: TextMessagePartComponent = (props) => {
  if (typeof props.text === 'string' && WORKING_RE.test(props.text)) {
    return (
      <span className="working-indicator" role="status" aria-live="polite">
        <span className="working-spinner" aria-hidden="true" />
        Working…
      </span>
    );
  }
  return <MarkdownText {...props} />;
};

// Thinking → native Reasoning content part: collapsible, dimmed. Collapsed by
// default. assistant-ui passes the reasoning text as `text`.
export const ReasoningPart: ReasoningMessagePartComponent = ({ text }) => {
  if (!text || !text.trim()) return null;
  return (
    <details className="block-thinking">
      <summary>thinking</summary>
      <div className="thinking-text">{text}</div>
    </details>
  );
};

// Pretty-print structured tool input. Falls back to the summary string for
// primitives / empty objects.
function formatInput(args: unknown): string {
  const input = toolInput(args);
  if (input == null) return '';
  if (typeof input === 'object' && Object.keys(input).length === 0) return '';
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

// tool_use → native tool-call part rendered as an expandable row:
//   ▸ <ToolName> — <one-line input summary>
// The header is a single non-wrapping flex row (the tool name is nowrap, the
// summary truncates with ellipsis). The per-flex-child `min-width:0` in CSS is
// what prevents the old one-letter-per-line wrap. Expanding reveals the full
// pretty-printed input and the tool result. Result is folded in by toolUseId
// upstream (convert.ts) and arrives as `result`.
export const ToolPart: ToolCallMessagePartComponent = ({ toolName, args, result }) => {
  const summary = toolSummary(args);
  const inputText = formatInput(args);
  const res = toolResult(result);
  const hasDetails = inputText.length > 0 || res != null;

  const header = (
    <span className="tool-head">
      <span className="tool-arrow" aria-hidden="true">
        ▸
      </span>
      <span className="tool-name">{toolName}</span>
      {summary ? (
        <>
          <span className="tool-sep">—</span>
          <span className="tool-input">{summary}</span>
        </>
      ) : null}
    </span>
  );

  if (!hasDetails) {
    return (
      <div className="block-tool">
        <div className="block-tool-use">{header}</div>
      </div>
    );
  }

  return (
    <details className="block-tool">
      <summary className="block-tool-use">{header}</summary>
      <div className="block-tool-body">
        {inputText ? (
          <pre className="block-tool-args">{inputText}</pre>
        ) : null}
        {res != null ? (
          <div
            className="block-tool-result"
            data-error={res.isError ? 'true' : 'false'}
          >
            {res.text}
          </div>
        ) : null}
      </div>
    </details>
  );
};
