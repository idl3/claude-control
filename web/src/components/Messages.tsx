import { ActionBarPrimitive, MessagePrimitive, useMessage } from '@assistant-ui/react';
import { ReasoningPart, TextPart, ToolPart } from './MessageParts';

const partComponents = {
  Text: TextPart,
  Reasoning: ReasoningPart,
  tools: { Fallback: ToolPart },
} as const;

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

// Copy-to-clipboard action bar under a message. Auto-hides except on hover / for
// the last message; the Copy button flips its icon via the `data-copied` attr.
function MessageActions() {
  return (
    <ActionBarPrimitive.Root className="msg-actions" hideWhenRunning autohide="not-last">
      <ActionBarPrimitive.Copy className="act-btn" aria-label="Copy message">
        <span className="act-copy-idle">
          <CopyIcon />
        </span>
        <span className="act-copy-done">
          <CheckIcon /> copied
        </span>
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  );
}

// User transcript message: right-aligned bubble.
export function UserMessage() {
  return (
    <MessagePrimitive.Root className="msg-row" data-role="user">
      <div className="msg-role">user</div>
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
      <div className="msg-role">{cockpitRole}</div>
      <div className="msg-body">
        <MessagePrimitive.Parts components={partComponents} />
      </div>
      <MessageActions />
    </MessagePrimitive.Root>
  );
}
