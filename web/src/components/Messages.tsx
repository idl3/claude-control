import { MessagePrimitive, useMessage } from '@assistant-ui/react';
import { ReasoningPart, TextPart, ToolPart } from './MessageParts';

const partComponents = {
  Text: TextPart,
  Reasoning: ReasoningPart,
  tools: { Fallback: ToolPart },
} as const;

// User transcript message: right-aligned bubble.
export function UserMessage() {
  return (
    <MessagePrimitive.Root className="msg-row" data-role="user">
      <div className="msg-role">user</div>
      <div className="msg-body">
        <MessagePrimitive.Parts components={partComponents} />
      </div>
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
    </MessagePrimitive.Root>
  );
}
