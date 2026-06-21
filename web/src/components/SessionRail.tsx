import type { Session } from '../lib/types';
import { agentBadge } from '../lib/agent-badge';

interface SessionRailProps {
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** "session:window·pNN" provenance, e.g. "0:3 · p1". */
function provenance(s: Session): string {
  const sw =
    s.windowIndex != null && s.sessionName != null
      ? `${s.sessionName}:${s.windowIndex}`
      : s.id;
  const pane = s.paneIndex != null ? ` · p${s.paneIndex}` : '';
  return `${sw}${pane}`;
}

// Active sessions first, then by most recent activity.
function sortSessions(a: Session, b: Session): number {
  if (!!a.active !== !!b.active) return a.active ? -1 : 1;
  return (b.lastActivity ?? 0) - (a.lastActivity ?? 0);
}

export function SessionRail({
  sessions,
  selectedId,
  onSelect,
}: SessionRailProps) {
  const sorted = [...sessions].sort(sortSessions);

  return (
    <ul className="session-list" role="listbox" aria-label="Sessions">
      {sorted.map((s) => {
        const selected = s.id === selectedId;
        return (
          <li
            key={s.id}
            role="option"
            aria-selected={selected}
            tabIndex={0}
            className="session-item"
            data-active={s.active ? 'true' : 'false'}
            data-selected={selected ? 'true' : 'false'}
            onClick={() => onSelect(s.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(s.id);
              }
            }}
          >
            <div className="session-top">
              <span
                className="active-dot"
                data-on={s.active ? 'true' : 'false'}
                aria-hidden="true"
              />
              <span className="session-name">{s.name || s.id}</span>
              {(() => {
                const badge = agentBadge(s.agentType);
                return badge ? (
                  <span
                    className="agent-badge"
                    data-kind={badge.kind}
                    aria-label={`agent type: ${badge.kind}`}
                  >
                    {badge.label}
                  </span>
                ) : null;
              })()}
              {s.pending ? (
                <span className="ask-badge" aria-label="pending question">
                  ASK
                </span>
              ) : null}
            </div>
            <div className="session-meta">
              <span className="meta-prov">{provenance(s)}</span>
              {s.model ? <span className="meta-model">{s.model}</span> : null}
              {s.ctxPct != null ? (
                <span className="meta-ctx">ctx:{Math.round(s.ctxPct)}%</span>
              ) : null}
            </div>
          </li>
        );
      })}
      {sorted.length === 0 ? (
        <li className="session-empty">no agent sessions</li>
      ) : null}
    </ul>
  );
}
