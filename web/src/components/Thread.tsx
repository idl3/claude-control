import { ThreadPrimitive } from '@assistant-ui/react';
import { AssistantMessage, UserMessage } from './Messages';
import { Composer } from './Composer';

interface ThreadProps {
  hasSelection: boolean;
  /** Messages older than the render cap that are currently hidden. */
  hiddenCount: number;
  /** Reveal an older chunk of messages. */
  onLoadEarlier: () => void;
}

const messageComponents = {
  UserMessage,
  AssistantMessage,
  // System messages are converted to assistant role (tagged), so this is unused
  // but kept for completeness.
  SystemMessage: AssistantMessage,
} as const;

export function Thread({ hasSelection, hiddenCount, onLoadEarlier }: ThreadProps) {
  return (
    <ThreadPrimitive.Root className="thread-root">
      <ThreadPrimitive.Viewport className="thread-viewport" autoScroll>
        {!hasSelection ? (
          <div className="thread-empty">select a session</div>
        ) : (
          <ThreadPrimitive.Empty>
            <div className="thread-empty">no messages yet</div>
          </ThreadPrimitive.Empty>
        )}
        {hasSelection && hiddenCount > 0 ? (
          <button
            type="button"
            className="load-earlier"
            onClick={onLoadEarlier}
          >
            Load earlier messages ({hiddenCount} hidden)
          </button>
        ) : null}
        <ThreadPrimitive.Messages components={messageComponents} />
      </ThreadPrimitive.Viewport>
      <Composer disabled={!hasSelection} />
    </ThreadPrimitive.Root>
  );
}
