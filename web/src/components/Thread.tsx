import { ThreadPrimitive, useComposerRuntime } from '@assistant-ui/react';
import { AssistantMessage, UserMessage } from './Messages';
import { Composer } from './Composer';
import { SubAgentStrip } from './SubAgentStrip';
import { ArrowDownIcon } from './icons';
import type { SubAgentMode } from '../lib/subAgent';
import type { SubAgent } from '../lib/types';

interface ThreadProps {
  hasSelection: boolean;
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
  /** Open the full sub-agent panel (strip click). */
  onOpenAgents: () => void;
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
  sessionId,
  hiddenCount,
  onLoadEarlier,
  subAgentMode,
  onSubAgentModeChange,
  onTerminalModeChange,
  subagents,
  onOpenAgents,
  working,
  onStop,
}: ThreadProps) {
  return (
    <ThreadPrimitive.Root className="thread-root">
      {/* Top scrim: fades messages under the header while the composer is
          focused (CSS :focus-within), so text scrolling up behind the nav bar
          dissolves instead of hard-cutting. Fades out on blur. */}
      <div className="thread-fade" aria-hidden="true" />
      {/* Sticky tailing is owned by App's scroll controller (see useEffect): it
          tails new content while pinned, but PAUSES while you're actively
          touching/scrolling so it can never fight your gesture (the deadlock that
          previously froze scroll). autoScroll is therefore off. */}
      <ThreadPrimitive.Viewport className="thread-viewport">
        {!hasSelection ? (
          <div className="thread-empty">select a session</div>
        ) : (
          <ThreadPrimitive.Empty>
            <div className="thread-welcome">
              <h1 className="thread-welcome-heading">What are we shipping today?</h1>
              <p className="thread-welcome-subtitle">
                Talk to Claude — type a prompt, or use a skill&nbsp;/ agent.
              </p>
              <WelcomeChips />
            </div>
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
      <SubAgentStrip subagents={subagents} onOpen={onOpenAgents} />
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
