import { useEffect, useMemo, useRef } from 'react';
import type { Session } from '../lib/types';
import gsap, { prefersReducedMotion } from '../lib/anim';

interface SessionRailProps {
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** Last path segment of a cwd, e.g. "/a/b/c" → "c". */
function basename(cwd?: string): string {
  if (!cwd) return '';
  const parts = cwd.replace(/\/$/, '').split('/');
  return parts[parts.length - 1] || cwd;
}

interface WindowGroup {
  windowIndex: number;
  windowName: string;
  panes: Session[];
}
interface SessionGroup {
  sessionName: string;
  windows: WindowGroup[];
}

/**
 * Deterministic tmux structure: SESSION → WINDOW → PANE, in natural tmux order
 * (session name, then window index, then pane index). Each pane is one row,
 * tagged Claude (transcript) or terminal (live shell) — mirroring exactly what
 * tmux shows, with no title/time guessing.
 */
function groupByTmux(sessions: Session[]): SessionGroup[] {
  const bySession = new Map<string, Map<number, Session[]>>();
  for (const s of sessions) {
    const sn = s.sessionName ?? '?';
    const wi = s.windowIndex ?? 0;
    if (!bySession.has(sn)) bySession.set(sn, new Map());
    const byWin = bySession.get(sn)!;
    if (!byWin.has(wi)) byWin.set(wi, []);
    byWin.get(wi)!.push(s);
  }
  return [...bySession.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([sessionName, byWin]) => ({
      sessionName,
      windows: [...byWin.entries()]
        .sort(([a], [b]) => a - b)
        .map(([windowIndex, panes]) => ({
          windowIndex,
          windowName: panes[0]?.tmuxName || `window ${windowIndex}`,
          panes: [...panes].sort((x, y) => (x.paneIndex ?? 0) - (y.paneIndex ?? 0)),
        })),
    }));
}

function PaneRow({
  s,
  selected,
  onSelect,
}: {
  s: Session;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const isTerminal = s.kind === 'terminal';
  const label = isTerminal
    ? s.ccShell
      ? `shell · ${s.cmd || 'sh'}`
      : s.cmd || s.tmuxName || 'shell'
    : s.title || s.name || s.id;

  // One-shot attention nudge: flash an accent ring when this pane STARTS needing
  // a reply (pending false→true). The steady ASK-badge pulse is CSS.
  const rowRef = useRef<HTMLLIElement>(null);
  const prevPending = useRef(s.pending);
  useEffect(() => {
    if (s.pending && !prevPending.current && rowRef.current && !prefersReducedMotion()) {
      gsap.fromTo(
        rowRef.current,
        { boxShadow: '0 0 0 2px var(--accent)' },
        { boxShadow: '0 0 0 0 rgba(0,0,0,0)', duration: 1.1, ease: 'power2.out' },
      );
    }
    prevPending.current = s.pending;
  }, [s.pending]);

  return (
    <li
      ref={rowRef}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      className="session-item"
      data-active={s.active ? 'true' : 'false'}
      data-selected={selected ? 'true' : 'false'}
      data-kind={s.kind ?? 'claude'}
      data-pending={s.pending ? 'true' : undefined}
      onClick={() => onSelect(s.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(s.id);
        }
      }}
    >
      <div className="session-top">
        <span className="active-dot" data-on={s.active ? 'true' : 'false'} aria-hidden="true" />
        <span className="pane-glyph" aria-hidden="true">
          {isTerminal ? '>_' : '✳'}
        </span>
        <span className="session-name">{label}</span>
        {s.thinking && !s.pending ? (
          <span className="thinking-dot" aria-label="working" title="Working…" />
        ) : null}
        {s.pending ? (
          <span className="ask-badge" aria-label="pending question">
            ASK
          </span>
        ) : null}
      </div>
      <div className="session-meta">
        <span className="meta-prov">p{s.paneIndex ?? 0}</span>
        {isTerminal ? (
          s.cwd ? <span className="meta-cwd">{basename(s.cwd)}</span> : null
        ) : (
          <>
            {s.model ? <span className="meta-model">{s.model}</span> : null}
            {s.ctxPct != null ? (
              <span className="meta-ctx">ctx:{Math.round(s.ctxPct)}%</span>
            ) : null}
          </>
        )}
      </div>
    </li>
  );
}

export function SessionRail({ sessions, selectedId, onSelect }: SessionRailProps) {
  const groups = useMemo(() => groupByTmux(sessions), [sessions]);

  if (groups.length === 0) {
    return (
      <div className="session-list" role="listbox" aria-label="Sessions">
        <div className="session-empty">no tmux panes</div>
      </div>
    );
  }

  return (
    <div className="session-list" role="listbox" aria-label="Sessions">
      {groups.map((g) => (
        <section key={g.sessionName} className="session-group">
          <div className="session-group-head">{g.sessionName}</div>
          {g.windows.map((w) => (
            <div key={w.windowIndex} className="session-window">
              <div className="session-window-head">
                <span className="window-idx">{w.windowIndex}</span>
                <span className="window-name">{w.windowName}</span>
              </div>
              <ul className="session-pane-list">
                {w.panes.map((s) => (
                  <PaneRow key={s.id} s={s} selected={s.id === selectedId} onSelect={onSelect} />
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
