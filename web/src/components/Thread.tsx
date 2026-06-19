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
      {/* autoScroll is OFF: it fought our scroll on the 2s session re-renders and
          made the transcript feel stuck on touch. App owns tailing instead (a
          MutationObserver tails while pinned; scrolling up detaches). */}
      <ThreadPrimitive.Viewport className="thread-viewport">
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
      {/* Tail-to-bottom button (plain — App toggles `data-show` when detached and
          scrolls on click). Outside the Viewport so it can't affect iOS momentum
          scrolling. */}
      <button
        type="button"
        className="scroll-to-bottom"
        aria-label="Scroll to latest"
        title="Scroll to latest"
        onClick={() => {
          const vp = document.querySelector<HTMLElement>('.thread-viewport');
          if (vp) vp.scrollTo({ top: vp.scrollHeight, behavior: 'smooth' });
        }}
      >
        <ArrowDownIcon size={18} />
      </button>
      <Composer disabled={!hasSelection} sessionId={sessionId} />
    </ThreadPrimitive.Root>
  );
}
