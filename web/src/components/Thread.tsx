import { useEffect, useState } from 'react';
import { ThreadPrimitive, useComposerRuntime } from '@assistant-ui/react';
import { AssistantMessage, UserMessage } from './Messages';
import { Composer } from './Composer';
import { SubAgentStrip } from './SubAgentStrip';
import { SubAgentThread } from './SubAgentThread';
import { ArrowDownIcon } from './icons';
import type { SubAgentMode } from '../lib/subAgent';
import type { SubAgent } from '../lib/types';

interface ThreadProps {
  hasSelection: boolean;
  /** Human-readable agent name used in the empty-state copy. */
  agentName?: string;
  /**
   * While true, the transcript for the selected session is still loading from
   * the server. Show a tasteful loader instead of the welcome screen.
   * Once the server delivers the `messages` frame this becomes false.
   */
  loading?: boolean;
  /** Active session id — passed to the Composer so enhance/review state is
   *  scoped per session. */
  sessionId?: string | null;
  /** Messages older than the render cap that are currently hidden. */
  hiddenCount: number;
  /** Reveal an older chunk of messages. */
  onLoadEarlier: () => void;
  /** Per-session sub-agent mode for the Composer checkbox. */
  subAgentMode: SubAgentMode;
  onSubAgentModeChange: (mode: SubAgentMode) => void;
  /** Notifies App when the Composer's >_ terminal mode changes. */
  onTerminalModeChange: (active: boolean) => void;
  /** Sub-agents for the active session — drives the above-composer strip. */
  subagents: SubAgent[];
  /** Open a specific running agent's transcript (pill click → inline view). */
  onOpenAgent: (agentId: string) => void;
  /** The sub-agent whose transcript is shown inline (null = show session). */
  viewingAgent?: SubAgent | null;
  /** Clear the inline agent view (back to session transcript). */
  onCloseAgent?: () => void;
  /** True while Claude is actively generating — flips the send button to STOP. */
  working?: boolean;
  /** Cancel in-flight generation (send Escape to the Claude pane). */
  onStop?: () => void;
}

const messageComponents = {
  UserMessage,
  AssistantMessage,
  // System messages are converted to assistant role (tagged), so this is unused
  // but kept for completeness.
  SystemMessage: AssistantMessage,
} as const;

interface WelcomeChip {
  label: string;
  /** Text to insert into the composer on click. If absent the chip is decorative. */
  insert?: string;
}

const WELCOME_CHIPS: WelcomeChip[] = [
  { label: 'Plan with /plan-hard', insert: '/plan-hard ' },
  { label: 'Browse skills (/)', insert: '/' },
  { label: 'Mention an agent (@)', insert: '@' },
  { label: 'Dictate (⌘S)' },
  { label: 'Run a shell command (>_)' },
];

// Safety fallback: if loading stays true for more than 8s (e.g. WS frame never
// arrives), flip showLoader off so the welcome renders rather than spinning forever.
const LOADER_TIMEOUT_MS = 8_000;

/** Spinner shown while the transcript tail is being fetched from the server. */
function TranscriptLoader({ loading }: { loading: boolean }) {
  const [showLoader, setShowLoader] = useState(true);

  useEffect(() => {
    if (!loading) {
      setShowLoader(true);
      return;
    }
    const id = setTimeout(() => setShowLoader(false), LOADER_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [loading]);

  if (!loading || !showLoader) return null;

  return (
    <div className="thread-loading" aria-label="Loading transcript" aria-live="polite">
      <span className="thread-loading-spinner" aria-hidden="true" />
    </div>
  );
}

/** Chip row rendered inside ThreadPrimitive.Empty — has access to composer runtime. */
function WelcomeChips() {
  const composer = useComposerRuntime();

  const handleChip = (chip: WelcomeChip) => {
    if (!chip.insert) return;
    composer.setText(chip.insert);
    // Focus the composer textarea so the user sees the inserted text immediately.
    const ta = document.querySelector<HTMLTextAreaElement>('.composer .composer-input');
    ta?.focus();
  };

  return (
    <div className="thread-welcome-chips" role="list">
      {WELCOME_CHIPS.map((chip) => (
        <button
          key={chip.label}
          type="button"
          role="listitem"
          className="thread-welcome-chip"
          data-clickable={chip.insert ? 'true' : undefined}
          onClick={() => handleChip(chip)}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}

export function Thread({
  hasSelection,
  agentName = 'Claude',
  loading = false,
  sessionId,
  hiddenCount,
  onLoadEarlier,
  subAgentMode,
  onSubAgentModeChange,
  onTerminalModeChange,
  subagents,
  onOpenAgent,
  viewingAgent = null,
  onCloseAgent,
  working,
  onStop,
}: ThreadProps) {
  return (
    <ThreadPrimitive.Root className="thread-root">
      {viewingAgent ? (
        /* INLINE AGENT TRANSCRIPT — replaces the session viewport */
        <div className="agent-inline-view">
          <div className="agent-inline-head">
            <button
              type="button"
              className="agent-inline-back"
              aria-label="Back to session"
              onClick={onCloseAgent}
            >
              ‹ back
            </button>
            <span className="agent-inline-title">
              <span className="sa-dot" data-status={viewingAgent.status} aria-hidden="true" />
              <span className="agent-inline-name">
                {viewingAgent.agentType || 'sub-agent'}
              </span>
              <span className="agent-inline-status">
                {viewingAgent.status === 'running' ? '· running' : '· done'}
              </span>
            </span>
          </div>
          <SubAgentThread messages={viewingAgent.messages} />
        </div>
      ) : (
        /* SESSION TRANSCRIPT */
        <>
          {/* Sticky tailing is owned by App's scroll controller (see useEffect): it
              tails new content while pinned, but PAUSES while you're actively
              touching/scrolling so it can never fight your gesture (the deadlock that
              previously froze scroll). autoScroll is therefore off. */}
          <ThreadPrimitive.Viewport className="thread-viewport">
            {!hasSelection ? (
              <div className="thread-empty">select a session</div>
            ) : (
              <ThreadPrimitive.Empty>
                {loading ? (
                  <TranscriptLoader loading={loading} />
                ) : (
                  <div className="thread-welcome">
                    <h1 className="thread-welcome-heading">What are we shipping today?</h1>
                    <p className="thread-welcome-subtitle">
                      Talk to {agentName} — type a prompt, or use a skill&nbsp;/ agent.
                    </p>
                    <WelcomeChips />
                  </div>
                )}
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
          {/* Tail-to-bottom: App toggles data-show when detached; click re-attaches.
              OUTSIDE the Viewport so it never affects iOS momentum scrolling. */}
          <button
            type="button"
            className="scroll-to-bottom"
            aria-label="Scroll to latest"
            title="Scroll to latest (⌘.)"
            data-hotkey="⌘."
            data-hotkey-dir="up"
            onClick={() => {
              const vp = document.querySelector<HTMLElement>('.thread-viewport');
              if (vp) vp.scrollTo({ top: vp.scrollHeight, behavior: 'smooth' });
            }}
          >
            <ArrowDownIcon size={18} />
          </button>
        </>
      )}

      {/* Pills + composer always visible so user can switch agents or type */}
      <SubAgentStrip
        subagents={subagents}
        onOpenAgent={onOpenAgent}
        viewingAgentId={viewingAgent?.agentId ?? null}
      />
      <Composer
        disabled={!hasSelection}
        sessionId={sessionId}
        subAgentMode={subAgentMode}
        onSubAgentModeChange={onSubAgentModeChange}
        onTerminalModeChange={onTerminalModeChange}
        working={working}
        onStop={onStop}
      />
    </ThreadPrimitive.Root>
  );
}
