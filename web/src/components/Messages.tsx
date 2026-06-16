import { useState } from 'react';
import {
  ActionBarPrimitive,
  MessagePrimitive,
  useMessage,
  type ReasoningMessagePartProps,
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

type PartLike = { readonly type: string };
type Group = { groupKey: string | undefined; indices: number[] };

/**
 * Turn-level work grouping (position-aware, so it needs the whole parts array —
 * hence Unstable_PartsGrouped rather than the adjacent-only GroupedParts).
 *
 * A turn = one merged assistant message (see convert.mergeAssistantTurns). Its
 * trailing run of text parts is the ANSWER (always shown). Everything before is
 * WORK (thinking + tool calls + intermediate narration). Rubric:
 *   - ≥2 work parts → one "chain of thought" group (collapsible).
 *   - 0–1 work part → shown inline (a chain of one isn't a chain; a lone tool
 *     or thought just shows).
 *   - answer text → always inline.
 */
function groupTurn(parts: readonly PartLike[]): Group[] {
  const n = parts.length;
  let answerStart = n;
  while (answerStart > 0 && parts[answerStart - 1].type === 'text') answerStart -= 1;

  const work: number[] = [];
  for (let i = 0; i < answerStart; i += 1) work.push(i);

  // Only group when the turn did ≥2 real ACTIONS (thinking blocks + tool calls).
  // A lone tool — even with a "let me…" text preamble — just shows inline (a
  // chain of one isn't a chain).
  const actions = work.filter(
    (i) => parts[i].type === 'reasoning' || parts[i].type === 'tool-call',
  ).length;

  const groups: Group[] = [];
  if (actions >= 2) {
    groups.push({ groupKey: 'group-thought', indices: work });
  } else {
    for (const i of work) groups.push({ groupKey: undefined, indices: [i] });
  }
  for (let i = answerStart; i < n; i += 1) groups.push({ groupKey: undefined, indices: [i] });
  return groups;
}

// Reasoning leaf: plain dim text. Inside a group the group owns the disclosure +
// flash; as a lone inline item it reads as a quiet thought.
function GroupedReasoning({ text }: ReasoningMessagePartProps) {
  if (!text || !text.trim()) return null;
  return <div className="cot-reasoning thinking-text">{text}</div>;
}

const partComponents = {
  Text: TextPart,
  Reasoning: GroupedReasoning,
  tools: { Fallback: ToolPart },
} as const;

/**
 * The collapsible chain-of-thought wrapping a turn's work. Label + step count
 * derive from the grouped parts: reasoning present → "chain of thought · N
 * steps"; tools only → "N tool calls". While the session is actively generating
 * THIS turn it flashes, stays OPEN (live preview of active work) and rolls the
 * latest reasoning line; when the turn ends it collapses. Children mount only
 * while open (collapsed history stays cheap).
 */
function ChainOfThought({
  indices,
  children,
}: {
  indices: number[];
  children: React.ReactNode;
}) {
  const messageId = useMessage((m) => m.id);
  const liveId = useLiveThinkingId();
  const live = !!liveId && messageId === liveId;
  const [userOpen, setUserOpen] = useState(false);
  const open = live || userOpen;

  // Select the stable content ref (changes only when parts change) and compute
  // counts in the render body — avoids re-render thrash from a selector that
  // returns a fresh object each call.
  const content = useMessage((m) => m.content) as readonly { type: string; text?: string }[];
  let reasoning = 0;
  let tools = 0;
  let lastThought = '';
  for (const i of indices) {
    const p = content[i];
    if (!p) continue;
    if (p.type === 'reasoning') {
      reasoning += 1;
      if (p.text?.trim()) lastThought = p.text;
    } else if (p.type === 'tool-call') {
      tools += 1;
    }
  }

  const steps = reasoning + tools;
  const label =
    reasoning > 0 ? 'chain of thought' : `${tools} tool call${tools === 1 ? '' : 's'}`;
  const last = lastUpdateLine(lastThought);

  return (
    <details
      className="block-cot"
      data-thinking={live ? 'true' : undefined}
      open={open}
      onToggle={(e) => setUserOpen(e.currentTarget.open)}
    >
      <summary>
        <span className="cot-label">{live ? 'thinking' : label}</span>
        {reasoning > 0 ? (
          <span className="cot-steps">
            · {steps} step{steps === 1 ? '' : 's'}
          </span>
        ) : null}
        {last ? (
          <span className="cot-last">{live ? <SlotText text={last} /> : last}</span>
        ) : null}
      </summary>
      {open ? <div className="cot-body">{children}</div> : null}
    </details>
  );
}

// Render a message's parts with turn-level work grouping.
function GroupedBody() {
  return (
    <MessagePrimitive.Unstable_PartsGrouped
      groupingFunction={groupTurn}
      components={{
        ...partComponents,
        Group: ({ groupKey, indices, children }) =>
          groupKey ? (
            <ChainOfThought indices={indices}>{children}</ChainOfThought>
          ) : (
            <>{children}</>
          ),
      }}
    />
  );
}

// User transcript message: right-aligned bubble. (Plain text — no work grouping
// — but keep the copy bar.)
export function UserMessage() {
  return (
    <MessagePrimitive.Root className="msg-row" data-role="user">
      <div className="msg-body">
        <MessagePrimitive.Parts components={partComponents} />
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
      <div className="msg-body">
        <GroupedBody />
      </div>
      <MessageActions />
    </MessagePrimitive.Root>
  );
}
