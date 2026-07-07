import { FunnelIcon } from './icons';
import type { SessionFilter } from './SessionRail';

export type CodexTransport = 'rpc' | 'tmux';
export type ClaudeTransport = 'tmux' | 'print';

interface NewSessionFormProps {
  /** Opens the new-session draft screen in the main content area. */
  onOpenDraft: () => void;
  /** Rail filter state + cycle (all → claude → codex → terminal). */
  filter: SessionFilter;
  onCycleFilter: () => void;
}

const FILTER_TITLE: Record<SessionFilter, string> = {
  all: 'Showing all panes — tap to show agents (Claude + Codex)',
  agents: 'Showing agents (Claude + Codex) — tap to show only Claude',
  claude: 'Showing Claude sessions — tap to show only Codex',
  codex: 'Showing Codex sessions — tap to show only terminals',
  terminal: 'Showing terminals — tap to show all',
};

/** Client-side mirror of the server's `session-<short-ts>` default name. */
export function defaultName(now: number = Date.now()): string {
  return `session-${now.toString(36).slice(-6)}`;
}

export function defaultAgentForFilter(filter: SessionFilter): 'claude' | 'codex' {
  return filter === 'codex' ? 'codex' : 'claude';
}

export function normalizeCodexTransport(value: unknown): CodexTransport {
  return value === 'tmux' ? 'tmux' : 'rpc';
}

export function normalizeClaudeTransport(value: unknown): ClaudeTransport {
  return value === 'print' ? 'print' : 'tmux';
}

/** Derive filter badge label for the funnel button. */
export function filterTag(filter: SessionFilter): string | null {
  if (filter === 'agents') return 'AI';
  if (filter === 'claude') return 'CC';
  if (filter === 'codex') return 'CX';
  if (filter === 'terminal') return '>_';
  return null;
}

/**
 * Rail-head "new session" control: a "+ New session" button that opens the
 * draft-composer screen in the main content area (see NewSessionDraft.tsx —
 * agent/transport/model/name/cwd pickers plus the initial-prompt composer all
 * live there now, not in an inline rail form), and the filter funnel button
 * (all → agents → Claude → Codex → terminals).
 */
export function NewSessionForm({ onOpenDraft, filter, onCycleFilter }: NewSessionFormProps) {
  const tag = filterTag(filter);
  return (
    <div className="rail-head">
      <button
        type="button"
        className="rail-new"
        onClick={onOpenDraft}
      >
        + New session
      </button>
      <button
        type="button"
        className="rail-filter"
        data-filter={filter}
        aria-label={FILTER_TITLE[filter]}
        title={FILTER_TITLE[filter]}
        onClick={onCycleFilter}
      >
        <FunnelIcon size={15} />
        {tag ? <span className="rail-filter-tag">{tag}</span> : null}
      </button>
    </div>
  );
}
