import {
  useMessage,
  type ReasoningMessagePartComponent,
  type TextMessagePartComponent,
  type ToolCallMessagePartComponent,
} from '@assistant-ui/react';
import { SlotText } from 'slot-text/react';
import 'slot-text/style.css';
import { toolInput, toolResult, toolSummary } from '../lib/convert';
import { MarkdownText } from './MarkdownText';
import { InlineAttachmentPreviews } from './AttachmentPreview';
import { useLiveThinkingId } from './ThinkingContext';

// The optimistic "Working…" placeholder (App.tsx, while Claude's real reply is
// pending) renders as an animated spinner; everything else is GitHub-flavored
// markdown (see MarkdownText).
const WORKING_RE = /^\s*working…?\s*$/i;
export const TextPart: TextMessagePartComponent = (props) => {
  if (typeof props.text === 'string' && WORKING_RE.test(props.text)) {
    return (
      <span className="working-indicator" role="status" aria-live="polite">
        <span className="working-spinner" aria-hidden="true" />
        <span className="shimmer-text">Working…</span>
      </span>
    );
  }
  // Render the markdown text + any inline attachment previews detected in the
  // raw text. Previews appear below the text block (thumbnails / file chips).
  return (
    <>
      <MarkdownText {...props} />
      {typeof props.text === 'string' ? (
        <InlineAttachmentPreviews text={props.text} />
      ) : null}
    </>
  );
};

// The last non-empty line of the reasoning, trimmed for the accordion summary.
const MAX_LAST = 90;
function lastUpdateLine(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l) return l.length > MAX_LAST ? l.slice(0, MAX_LAST - 1) + '…' : l;
  }
  return '';
}

// Thinking → native Reasoning content part: a collapsed accordion. The summary
// shows the latest "thinking" line (rolling via slot-text while live). While the
// session is actively generating THIS message, the text flashes multicolour
// (see .block-thinking[data-thinking]); once done it settles to solid/dim.
export const ReasoningPart: ReasoningMessagePartComponent = ({ text }) => {
  const messageId = useMessage((m) => m.id);
  const liveId = useLiveThinkingId();
  const thinking = !!liveId && messageId === liveId;

  // Empty reasoning is normally hidden — but while live, keep a flashing label
  // so a thinking block that hasn't emitted text yet still reads as "thinking".
  const body = text?.trim() ?? '';
  if (!body && !thinking) return null;

  const last = lastUpdateLine(body);

  return (
    <details className="block-thinking" data-thinking={thinking ? 'true' : undefined}>
      <summary>
        <span className="thinking-label">thinking</span>
        {last ? (
          <span className="thinking-last">
            {thinking ? <SlotText text={last} /> : last}
          </span>
        ) : null}
      </summary>
      <div className="thinking-text">{body}</div>
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
