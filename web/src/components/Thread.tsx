import { memo, useEffect, useState } from 'react';
import { ThreadPrimitive, useComposerRuntime } from '@assistant-ui/react';
import { AssistantMessage, UserMessage } from './Messages';
import { PendingAskCard } from './MessageParts';
import { Composer } from './Composer';
import { SubAgentStrip } from './SubAgentStrip';
import { SubAgentThread } from './SubAgentThread';
import { ErrorBoundary } from './ErrorBoundary';
import { ArrowDownIcon } from './icons';
import type { SubAgentMode } from '../lib/subAgent';
import type { Pending, SubAgent } from '../lib/types';
import type { ActivePrompt } from './AskInline';

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
  /** True while Claude is compacting the conversation — blocks sends + shows progress. */
  compacting?: boolean;
  /** True while a dormant remote session's "Resume & send" is in flight
   *  (Phase C, C5) — blocks sends + shows progress, mirrors `compacting`. */
  resuming?: boolean;
  /** True when the session hit an API error and stalled — shows a Retry strip. */
  errored?: boolean;
  /** Retry handler for the error strip (sends "Continue"). */
  onRetry?: () => void;
  /** Cancel in-flight generation (send Escape to the Claude pane). */
  onStop?: () => void;
  /** Inline prompt morph props — forwarded to Composer. */
  askActive?: boolean;
  activePrompt?: ActivePrompt | null;
  /** Live unanswered AskUserQuestion to surface in the transcript timeline (with
   *  full context), or null when it's already present as a real transcript record. */
  incomingAsk?: Pending | null;
  onAnswer?: (toolUseId: string, selections: string[][]) => void;
  onKey?: (key: string) => void;
  onSelect?: (labels: string[]) => void;
  onReply?: (text: string) => void;
  /**
   * Override the empty-transcript state (default: the "What are we shipping
   * today?" welcome + chips, which implies the user should type first). Set
   * for remote (olam) sessions where the agent may already be working and
   * transcript is simply still loading over the wire — a centered status
   * message reads better than a compose invitation.
   */
  emptyState?: { heading: string; subtitle?: string } | null;
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

// Safety fallback: if the transcript frame itself never arrives (`loading`) for
// more than 8s (e.g. the WS frame is lost), stop waiting so the empty/welcome
// state renders rather than spinning forever. Doesn't apply to the
// `working`-driven wait below (see stillLoading in ThreadImpl) — that's already
// self-bounded by claudeWorking's own 15s recency window, so a second hard
// cutoff would just blank out a session that's still visibly generating.
const LOADER_TIMEOUT_MS = 8_000;

function useLoaderTimedOut(loading: boolean): boolean {
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (!loading) {
      setTimedOut(false);
      return;
    }
    const id = setTimeout(() => setTimedOut(true), LOADER_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [loading]);

  return timedOut;
}

/** Widths (%) for each skeleton row's text bars — mimics a couple of real chat
 *  turns (a multi-line assistant paragraph, a short user reply) so the shape
 *  reads as "message-ish" rather than generic. Percentages are relative to the
 *  real message column: .thread-skeleton/.thread-skeleton-row in styles.css are
 *  sized to match .thread-viewport/.msg-row exactly, not a fixed narrow box. */
const SKELETON_ROWS: { align?: 'end'; widths: number[] }[] = [
  { widths: [88, 72, 45] },
  { align: 'end', widths: [72, 40] },
  { widths: [95, 80, 60, 30] },
];

/** Skeleton + spinner shown while the transcript tail is expected but hasn't
 *  rendered yet. The skeleton rows give a sense of "content incoming" (vs. a
 *  bare spinner reading as indefinite/stuck); the spinner keeps the classic
 *  in-progress affordance for users who scan past the shimmer. */
function TranscriptLoader() {
  return (
    <div className="thread-loading" aria-label="Loading transcript" aria-live="polite">
      <span className="thread-loading-spinner" aria-hidden="true" />
      <div className="thread-skeleton" aria-hidden="true">
        {SKELETON_ROWS.map((row, i) => (
          <div key={i} className="thread-skeleton-row" data-align={row.align}>
            {row.widths.map((w, j) => (
              <span key={j} className="thread-skeleton-bar" style={{ width: `${w}%` }} />
            ))}
          </div>
        ))}
      </div>
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

function ThreadImpl({
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
  compacting,
  resuming,
  errored,
  onRetry,
  onStop,
  askActive,
  activePrompt,
  incomingAsk,
  onAnswer,
  onKey,
  onSelect,
  onReply,
  emptyState = null,
}: ThreadProps) {
  const loaderTimedOut = useLoaderTimedOut(!!loading);
  // Hold the skeleton (instead of falling through to the empty/welcome state)
  // while either:
  //  - the transcript frame itself hasn't arrived yet (`loading`), or
  //  - it HAS arrived (and is empty) but Claude is demonstrably active for this
  //    session (`working`) — covers a session just created with an initial
  //    prompt, where the tmux pane/transcript file can legitimately still be
  //    empty on the first WS frame while the prompt is being delivered.
  // Remote sessions already get their own tailored `emptyState` copy for this
  // exact "loading over the wire while working" case, so `working` only
  // extends the skeleton window when there's no `emptyState` override.
  const stillLoading = (!!loading && !loaderTimedOut) || (!!working && !emptyState);
  // Extra bottom room ONLY while the strip/Working indicator is showing, so the
  // last transcript line at max scroll never hides behind the overhanging pills.
  const showAgentRoom = subagents.length > 0 && (working || subagents.some((a) => a.status === 'running'));

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
          <SubAgentThread
            messages={viewingAgent.messages}
            loading={viewingAgent.messagesLoaded === false}
          />
        </div>
      ) : (
        /* SESSION TRANSCRIPT */
        <>
          {/* Sticky tailing is owned by App's scroll controller (see useEffect): it
              tails new content while pinned, but PAUSES while you're actively
              touching/scrolling so it can never fight your gesture (the deadlock that
              previously froze scroll). autoScroll is therefore off. */}
          <ThreadPrimitive.Viewport className={`thread-viewport${showAgentRoom ? ' has-subagents' : ''}`}>
            {!hasSelection ? (
              <div className="thread-empty">select a session</div>
            ) : (
              <ThreadPrimitive.Empty>
                {stillLoading ? (
                  <TranscriptLoader />
                ) : emptyState ? (
                  <div className="thread-empty-remote" role="status">
                    <p className="thread-empty-remote-heading">{emptyState.heading}</p>
                    {emptyState.subtitle ? (
                      <p className="thread-empty-remote-subtitle">{emptyState.subtitle}</p>
                    ) : null}
                  </div>
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
            {/* Nested firewall: a crash rendering THIS session's messages stays
                contained to the transcript pane — the composer, toolbar, rail and
                other sessions keep working, and Retry re-renders just this pane
                (no full page reload). Keyed by session so switching auto-clears. */}
            <ErrorBoundary
              resetKey={sessionId ?? undefined}
              label="This conversation's transcript failed to render"
            >
              <ThreadPrimitive.Messages components={messageComponents} />
              {/* Live incoming question — shows the asked context in the transcript
                  flow the moment it arrives, beside the composer choices below. */}
              {incomingAsk ? <PendingAskCard questions={incomingAsk.questions} /> : null}
            </ErrorBoundary>
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
        working={working}
      />
      <Composer
        disabled={!hasSelection || loading}
        loading={loading}
        sessionId={sessionId}
        subAgentMode={subAgentMode}
        onSubAgentModeChange={onSubAgentModeChange}
        onTerminalModeChange={onTerminalModeChange}
        working={working}
        compacting={compacting}
        resuming={resuming}
        errored={errored}
        onRetry={onRetry}
        onStop={onStop}
        askActive={askActive}
        activePrompt={activePrompt}
        onAnswer={onAnswer}
        onKey={onKey}
        onSelect={onSelect}
        onReply={onReply}
      />
    </ThreadPrimitive.Root>
  );
}

// Memoized: Thread's props are stabilized at the App call site (stable cockpit
// action refs, memoized derived props), so a WS frame for another session or the
// 5s resources tick no longer re-renders the transcript + composer subtree.
export const Thread = memo(ThreadImpl);
