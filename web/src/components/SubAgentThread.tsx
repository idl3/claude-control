import { useMemo } from 'react';
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { convertMessages } from '../lib/convert';
import { AssistantMessage, UserMessage } from './Messages';
import type { SubAgent } from '../lib/types';

const messageComponents = {
  UserMessage,
  AssistantMessage,
  SystemMessage: AssistantMessage,
} as const;

interface SubAgentThreadProps {
  messages: SubAgent['messages'];
}

/**
 * Read-only nested chat: renders a sub-agent's transcript with the exact
 * message/tool/markdown components the main thread uses. A throwaway external-
 * store runtime feeds it; autoScroll tails the conversation as the agent runs.
 *
 * Used in both SubAgentPanel (side drawer) and the inline agent view in Thread.
 */
export function SubAgentThread({ messages }: SubAgentThreadProps) {
  const converted = useMemo<ThreadMessageLike[]>(
    () => convertMessages(messages),
    [messages],
  );
  const runtime = useExternalStoreRuntime({
    messages: converted,
    isDisabled: true,
    convertMessage: (m: ThreadMessageLike) => m,
    onNew: async () => {}, // read-only: composer is never shown
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="sa-thread-root">
        <ThreadPrimitive.Viewport className="sa-thread-viewport" autoScroll>
          <ThreadPrimitive.Empty>
            <div className="thread-empty">no output yet…</div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={messageComponents} />
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
