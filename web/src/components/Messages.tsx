import { MessagePrimitive, useMessage } from '@assistant-ui/react';
import { ImagePart, ReasoningPart, TextPart, ToolPart } from './MessageParts';

const partComponents = {
  Text: TextPart,
  Reasoning: ReasoningPart,
  Image: ImagePart,
  tools: { Fallback: ToolPart },
} as const;

// User transcript message: right-aligned bubble. Queued (not-yet-echoed) sends
// are tagged via metadata.custom.queued so they render dimmed with a "queued"
// marker until their real transcript echo arrives.
export function UserMessage() {
  const queued = useMessage((m) => m.metadata?.custom?.queued) === true;
  return (
    <MessagePrimitive.Root
      className="msg-row"
      data-role="user"
      data-queued={queued ? 'true' : undefined}
    >
      <div className="msg-role">{queued ? 'queued' : 'user'}</div>
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
