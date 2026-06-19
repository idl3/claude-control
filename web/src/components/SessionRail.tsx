import { useEffect, useMemo, useRef } from 'react';
import type { Session } from '../lib/types';
import gsap, { prefersReducedMotion } from '../lib/anim';
import { ClaudeRobotIcon } from './ClaudeRobotIcon';
import { TerminalSquareIcon } from './icons';

export type SessionFilter = 'all' | 'claude' | 'terminal';

interface SessionRailProps {
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Show all panes, only Claude, or only terminals. */
  filter: SessionFilter;
  /** Collapsed tmux session names (accordion). */
  collapsed: Set<string>;
  onToggleCollapse: (sessionName: string) => void;
  /** id → "⌘N" badge, computed by App over the VISIBLE+addressable Claude order. */
  hotkeyById: Map<string, string>;
}

/** A Claude pane reads as "working" while actively generating OR with very recent
 *  transcript activity (covers tool runs / sub-agents that the pane line misses).
 *  Uses `lastActivityMs` (ms number from server) for the 15 s recency check;
 *  `lastActivity` is an ISO string and is intentionally ignored here. */
export function claudeWorking(s: Session): boolean {
  if (s.thinking) return true;
  const la = s.lastActivityMs;
  return typeof la === 'number' && Number.isFinite(la) && Date.now() - la < 15_000;
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
  hotkey,
}: {
  s: Session;
  selected: boolean;
  onSelect: (id: string) => void;
  /** "⌘N" for the first 9 Claude sessions (matches the ⌘1-9 jump) — drives the
   *  Command-hold hint badge. Undefined for terminals + rows past 9. */
  hotkey?: string;
}) {
  const isTerminal = s.kind === 'terminal';
  const label = isTerminal
    ? s.ccShell
      ? `shell · ${s.cmd || 'sh'}`
      : s.cmd || s.tmuxName || 'shell'
    : s.title || s.name || s.id;

  // Claude character state: a pending question (?) > working (generating / tools
  // / sub-agents / recent activity) > idle (sleeping/Zzz). No state for terminals.
  const claudeState = isTerminal
    ? null
    : s.pending
      ? 'ask'
      : claudeWorking(s)
        ? 'working'
        : 'sleeping';

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
      data-hotkey={hotkey}
      data-hotkey-dir={hotkey ? 'right' : undefined}
      onClick={() => onSelect(s.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(s.id);
        }
      }}
    >
      <div className="session-top">
        {/* One icon per row: Claude vs terminal. Active tmux pane = full
            opacity; inactive panes dim (this replaces the old green/grey orb). */}
        <span
          className="pane-icon"
          data-kind={isTerminal ? 'terminal' : 'claude'}
          data-active={s.active ? 'true' : 'false'}
          data-state={claudeState ?? undefined}
          aria-label={isTerminal ? 'terminal pane' : 'Claude pane'}
          title={
            isTerminal
              ? s.active
                ? 'active pane'
                : 'inactive pane'
              : claudeState === 'ask'
                ? 'waiting on a question'
                : claudeState === 'working'
                  ? 'working…'
                  : 'idle'
          }
        >
          {isTerminal ? <TerminalSquareIcon size={15} /> : <ClaudeRobotIcon size={14} />}
          {claudeState === 'ask' ? (
            <span className="pane-icon-badge pane-icon-ask" aria-hidden="true">?</span>
          ) : claudeState === 'sleeping' ? (
            <span className="pane-icon-badge pane-icon-zzz" aria-hidden="true">z</span>
          ) : null}
        </span>
        <span className="session-name">{label}</span>
        {!isTerminal && claudeState === 'working' ? (
          <span className="thinking-dot" aria-label="working" title="Working…" />
        ) : null}
        {s.pending ? (
          <span className="ask-badge" aria-label="pending question">
            ASK
          </span>
        ) : null}
        {/* Terminals are a single lean line: cwd sits right-aligned beside the
            name, no second meta row. */}
        {isTerminal && s.cwd ? (
          <span className="meta-cwd meta-cwd-inline">{basename(s.cwd)}</span>
        ) : null}
      </div>
      {!isTerminal && (s.model || s.ctxPct != null) ? (
        <div className="session-meta">
          {s.model ? <span className="meta-model">{s.model}</span> : null}
          {s.ctxPct != null ? (
            <span className="meta-ctx">ctx:{Math.round(s.ctxPct)}%</span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function SessionRail({
  sessions,
  selectedId,
  onSelect,
  filter,
  collapsed,
  onToggleCollapse,
  hotkeyById,
}: SessionRailProps) {
  // Apply the kind filter BEFORE grouping so empty groups/windows drop out.
  const groups = useMemo(() => {
    const visible = sessions.filter((s) =>
      filter === 'all'
        ? true
        : filter === 'terminal'
          ? s.kind === 'terminal'
          : s.kind !== 'terminal',
    );
    return groupByTmux(visible);
  }, [sessions, filter]);

  if (groups.length === 0) {
    return (
      <div className="session-list" role="listbox" aria-label="Sessions">
        <div className="session-empty">
          {filter === 'all' ? 'no tmux panes' : `no ${filter} sessions`}
        </div>
      </div>
    );
  }

  return (
    <div className="session-list" role="listbox" aria-label="Sessions">
      {groups.map((g) => {
        const isCollapsed = collapsed.has(g.sessionName);
        const paneCount = g.windows.reduce((n, w) => n + w.panes.length, 0);
        return (
          <section key={g.sessionName} className="session-group" data-collapsed={isCollapsed ? 'true' : undefined}>
            <button
              type="button"
              className="session-group-head"
              aria-expanded={!isCollapsed}
              onClick={() => onToggleCollapse(g.sessionName)}
            >
              <span className="session-group-chevron" aria-hidden="true">
                {isCollapsed ? '▸' : '▾'}
              </span>
              <span className="session-group-name">{g.sessionName}</span>
              {isCollapsed ? <span className="session-group-count">{paneCount}</span> : null}
            </button>
            {isCollapsed
              ? null
              : g.windows.map((w) => (
                  <div key={w.windowIndex} className="session-window">
                    <div className="session-window-head">
                      <span className="window-idx">{w.windowIndex}</span>
                      <span className="window-name">{w.windowName}</span>
                    </div>
                    <ul className="session-pane-list">
                      {w.panes.map((s) => (
                        <PaneRow
                          key={s.id}
                          s={s}
                          selected={s.id === selectedId}
                          onSelect={onSelect}
                          hotkey={hotkeyById.get(s.id)}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
          </section>
        );
      })}
    </div>
  );
}
