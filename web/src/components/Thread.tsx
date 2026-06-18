import { ThreadPrimitive } from '@assistant-ui/react';
import { AssistantMessage, UserMessage } from './Messages';
import { Composer } from './Composer';
import { ArrowDownIcon } from './icons';

interface ThreadProps {
  hasSelection: boolean;
  /** Active session id — passed to the Composer so enhance/review state is
   *  scoped per session. */
  sessionId?: string | null;
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

export function Thread({ hasSelection, sessionId, hiddenCount, onLoadEarlier }: ThreadProps) {
  return (
    <ThreadPrimitive.Root className="thread-root">
      {/* Top scrim: fades messages under the header while the composer is
          focused (CSS :focus-within), so text scrolling up behind the nav bar
          dissolves instead of hard-cutting. Fades out on blur. */}
      <div className="thread-fade" aria-hidden="true" />
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
        {/* Tail-to-bottom: lives INSIDE the viewport, stuck to its bottom-right
            edge (just above the composer) so it never overlaps composer text.
            Auto-scroll keeps the thread pinned when at the bottom; the primitive
            disables itself there and CSS fades it out. */}
        <ThreadPrimitive.ScrollToBottom asChild>
          <button
            type="button"
            className="scroll-to-bottom"
            aria-label="Scroll to latest"
            title="Scroll to latest"
          >
            <ArrowDownIcon size={18} />
          </button>
        </ThreadPrimitive.ScrollToBottom>
      </ThreadPrimitive.Viewport>
      <Composer disabled={!hasSelection} sessionId={sessionId} />
    </ThreadPrimitive.Root>
  );
}
