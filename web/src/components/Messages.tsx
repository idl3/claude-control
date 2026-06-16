import {
  ActionBarPrimitive,
  MessagePrimitive,
  groupPartByType,
  useMessage,
  type ReasoningMessagePartProps,
  type TextMessagePartProps,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import { SlotText } from 'slot-text/react';
import 'slot-text/style.css';
import { TextPart, ToolPart, lastUpdateLine } from './MessageParts';
import { useLiveThinkingId } from './ThinkingContext';

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12l5 5L19 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Always-visible copy bar at the END of a message (per product decision: not a
// hover overlay). Copies the message's text; the button flips to a check via
// the `data-copied` attribute assistant-ui sets.
function MessageActions() {
  return (
    <ActionBarPrimitive.Root className="msg-actions">
      <ActionBarPrimitive.Copy className="act-btn" aria-label="Copy message">
        <span className="act-copy-idle">
          <CopyIcon /> copy
        </span>
        <span className="act-copy-done">
          <CheckIcon /> copied
        </span>
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  );
}

// Coalesce adjacent reasoning + tool-call parts into one "chain of thought"
// group; text stays ungrouped (rendered inline as the assistant's answer).
const groupBy = groupPartByType({
  reasoning: ['group-thought'],
  'tool-call': ['group-thought'],
});

// The collapsible "chain of thought" container wrapping a run of reasoning +
// tool-call parts. Header shows the step count; while the session is actively
// generating THIS message it flashes multicolour, auto-opens, and rolls the
// latest reasoning line via slot-text (textmotion.dev).
function ChainOfThought({
  stepCount,
  children,
}: {
  stepCount: number;
  children: React.ReactNode;
}) {
  const messageId = useMessage((m) => m.id);
  const liveId = useLiveThinkingId();
  const thinking = !!liveId && messageId === liveId;

  // Latest reasoning line across this message's parts, for the rolling summary.
  const lastThought = useMessage((m) => {
    const parts = m.content;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (p.type === 'reasoning' && p.text?.trim()) return p.text;
    }
    return '';
  });
  const last = lastUpdateLine(lastThought);

  return (
    <details
      className="block-cot"
      data-thinking={thinking ? 'true' : undefined}
      open={thinking ? true : undefined}
    >
      <summary>
        <span className="cot-label">{thinking ? 'thinking' : 'chain of thought'}</span>
        <span className="cot-steps">
          · {stepCount} step{stepCount === 1 ? '' : 's'}
        </span>
        {last ? (
          <span className="cot-last">{thinking ? <SlotText text={last} /> : last}</span>
        ) : null}
      </summary>
      <div className="cot-body">{children}</div>
    </details>
  );
}

// Reasoning leaf rendered INSIDE the chain-of-thought group: plain dim text (the
// group owns the disclosure + flash), not its own accordion.
function GroupedReasoning({ text }: { text: string }) {
  if (!text || !text.trim()) return null;
  return <div className="cot-reasoning thinking-text">{text}</div>;
}

// Render one message's parts grouped: reasoning+tools fold into a ChainOfThought
// block; text renders inline. Leaf parts arrive as EnrichedPartState; we pass
// them straight to the existing renderers.
function GroupedBody() {
  return (
    <MessagePrimitive.GroupedParts groupBy={groupBy} indicator="never">
      {({ part, children }) => {
        switch (part.type) {
          case 'group-thought':
            return <ChainOfThought stepCount={part.indices.length}>{children}</ChainOfThought>;
          case 'text':
            return <TextPart {...(part as unknown as TextMessagePartProps)} />;
          case 'reasoning':
            return <GroupedReasoning {...(part as unknown as ReasoningMessagePartProps)} />;
          case 'tool-call':
            return <ToolPart {...(part as unknown as ToolCallMessagePartProps)} />;
          default:
            return null;
        }
      }}
    </MessagePrimitive.GroupedParts>
  );
}

// User transcript message: right-aligned bubble. (No tool/reasoning grouping —
// user turns are plain text — but keep the copy bar.)
export function UserMessage() {
  return (
    <MessagePrimitive.Root className="msg-row" data-role="user">
      <div className="msg-role">user</div>
      <div className="msg-body">
        <GroupedBody />
      </div>
      <MessageActions />
    </MessagePrimitive.Root>
  );
}

// Assistant (and system, tagged via metadata.custom.cockpitRole) message.
export function AssistantMessage() {
  const cockpitRole =
    (useMessage((m) => m.metadata?.custom?.cockpitRole) as string | undefined) ??
    'assistant';

  return (
    <MessagePrimitive.Root className="msg-row" data-role={cockpitRole}>
      <div className="msg-role">{cockpitRole}</div>
      <div className="msg-body">
        <GroupedBody />
      </div>
      <MessageActions />
    </MessagePrimitive.Root>
  );
}
