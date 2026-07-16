export interface WelcomeChip {
  label: string;
  /** Text to insert into the composer on click. If absent the chip is decorative. */
  insert?: string;
}

/** Affordance chips shown under the hero subtitle. Decorative entries (no
 *  `insert`) hint at features (dictation, shell mode) without wiring an action. */
export const WELCOME_CHIPS: WelcomeChip[] = [
  { label: 'Plan with /plan-hard', insert: '/plan-hard ' },
  { label: 'Browse skills (/)', insert: '/' },
  { label: 'Mention an agent (@)', insert: '@' },
  { label: 'Dictate (⌘S)' },
  { label: 'Run a shell command (>_)' },
];

interface WelcomeHeroProps {
  /** Name shown in the subtitle ("Talk to {agentName} — …"). Defaults to 'Claude'. */
  agentName?: string;
  /** Called with a clickable chip's `insert` text when pressed. Decorative
   *  chips (no `insert`) never call this. */
  onInsert: (text: string) => void;
}

/**
 * Presentational "What are we shipping today?" hero — serif heading +
 * subtitle + affordance chip row. Extracted from Thread.tsx's live-transcript
 * welcome state (`.thread-welcome`) so NewSessionDraft.tsx can show the
 * EXACT same screen before a session exists, rather than a bespoke "New
 * session" look. Renders the identical markup/classes the transcript welcome
 * always has — `onInsert` replaces the direct `useComposerRuntime()` call so
 * this component has no assistant-ui dependency and works from a plain
 * controlled-textarea context (the draft) as well as the live composer.
 */
export function WelcomeHero({ agentName = 'Claude', onInsert }: WelcomeHeroProps) {
  return (
    <div className="thread-welcome">
      <h1 className="thread-welcome-heading">What are we shipping today?</h1>
      <p className="thread-welcome-subtitle">
        Talk to {agentName} — type a prompt, or use a skill&nbsp;/ agent.
      </p>
      <div className="thread-welcome-chips" role="list">
        {WELCOME_CHIPS.map((chip) => (
          <button
            key={chip.label}
            type="button"
            role="listitem"
            className="thread-welcome-chip"
            data-clickable={chip.insert ? 'true' : undefined}
            onClick={() => {
              if (chip.insert) onInsert(chip.insert);
            }}
          >
            {chip.label}
          </button>
        ))}
      </div>
    </div>
  );
}
