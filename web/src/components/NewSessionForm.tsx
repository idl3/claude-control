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
  all: 'Showing all panes — tap to show agents (Claude + Claudex + Codex)',
  agents: 'Showing agents (Claude + Claudex + Codex) — tap to show only Claude',
  claude: 'Showing Claude sessions — tap to show only Codex',
  codex: 'Showing Codex-flavored sessions (Claudex + legacy Codex) — tap to show only terminals',
  terminal: 'Showing terminals — tap to show all',
};

/** Client-side mirror of the server's `session-<short-ts>` default name. */
export function defaultName(now: number = Date.now()): string {
  return `session-${now.toString(36).slice(-6)}`;
}

/** Claudex (claude CLI → olam auth-worker → OpenAI) is the PRIMARY
 *  Codex-flavored option (claudex-integration design decision 7, locked):
 *  a Codex-ish rail filter seeds the draft with claudex, while the legacy
 *  codex CLI/RPC harness stays reachable under the picker's "Legacy" label.
 *  Claude remains the overall default for every other filter. */
export function defaultAgentForFilter(filter: SessionFilter): 'claude' | 'codex' | 'claudex' {
  return filter === 'codex' ? 'claudex' : 'claude';
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
 * Rail-foot "new session" control: the filter funnel button (all → agents →
 * Claude → Codex → terminals) on the left, and a "+ New session" button that
 * opens the draft-composer screen in the main content area (see
 * NewSessionDraft.tsx — agent/transport/model/name/cwd pickers plus the
 * initial-prompt composer all live there now, not in an inline rail form) on
 * the right. Lives in the rail's bottom bar (right-thumb reachable on
 * mobile) — filter first so the primary "+ New session" action lands
 * rightmost.
 */
export function NewSessionForm({ onOpenDraft, filter, onCycleFilter }: NewSessionFormProps) {
  const tag = filterTag(filter);
  return (
    <div className="rail-foot">
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
      <button
        type="button"
        className="rail-new"
        onClick={onOpenDraft}
      >
        + New session
      </button>
    </div>
  );
}
