import { useEffect, useMemo, useRef } from 'react';
import type { Session } from '../lib/types';
import gsap, { prefersReducedMotion } from '../lib/anim';
import { ClaudeRobotIcon } from './ClaudeRobotIcon';
import { TerminalSquareIcon } from './icons';
import { CodexIcon } from './CodexIcon';

export type SessionFilter = 'all' | 'agents' | 'claude' | 'codex' | 'terminal';

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
  /**
   * When App's `agentWorking` flag fires immediately on send (bridging the
   * poll gap), the selected session's rail icon should reflect that state even
   * if `claudeWorking(s)` hasn't caught up yet.  Pass the selected id while
   * working, null otherwise.
   */
  workingOverrideId?: string | null;
  /**
   * Number of running sub-agents per session id. Sessions with ≥1 running
   * sub-agent show the "cloning" icon state (amoeba-split animation) instead
   * of "sleeping". Priority: ask > cloning > working > sleeping.
   */
  runningSubagentCountById?: Record<string, number>;
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
 * Format a Codex rate-limit window in minutes to a human label.
 * 300 → "5h", 10080 → "7d", other → "${min}m".
 */
function formatUsageWindow(windowMin?: number | null): string {
  if (windowMin == null) return '?';
  if (windowMin === 300) return '5h';
  if (windowMin === 10080) return '7d';
  const hours = windowMin / 60;
  if (Number.isInteger(hours) && hours >= 1) return `${hours}h`;
  return `${windowMin}m`;
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
  workingOverrideId,
  hasRunningSubagents,
}: {
  s: Session;
  selected: boolean;
  onSelect: (id: string) => void;
  /** "⌘N" for the first 9 Claude sessions (matches the ⌘1-9 jump) — drives the
   *  Command-hold hint badge. Undefined for terminals + rows past 9. */
  hotkey?: string;
  /** See SessionRailProps.workingOverrideId — syncs rail icon with transcript loader. */
  workingOverrideId?: string | null;
  /** True when this session has ≥1 running sub-agent — triggers "cloning" icon state. */
  hasRunningSubagents?: boolean;
}) {
  const isTerminal = s.kind === 'terminal';
  const isCodex = s.kind === 'codex';
  const label = isTerminal
    ? s.ccShell
      ? `shell · ${s.cmd || 'sh'}`
      : s.cmd || s.tmuxName || 'shell'
    : s.title || s.name || s.id;

  // Claude/Codex character state priority (highest first):
  //   ask      — pending question (needs user reply)
  //   cloning  — ≥1 sub-agent actively running (cell-division amoeba animation)
  //   working  — Claude is generating / recent transcript activity
  //   sleeping — idle
  // No state for terminals. workingOverrideId bridges the poll gap on send.
  const claudeState = isTerminal
    ? null
    : s.pending
      ? 'ask'
      : hasRunningSubagents || s.subAgentActive
        ? 'cloning'
        : claudeWorking(s) || s.id === workingOverrideId
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
          data-kind={isTerminal ? 'terminal' : isCodex ? 'codex' : 'claude'}
          data-active={s.active ? 'true' : 'false'}
          data-state={claudeState ?? undefined}
          aria-label={isTerminal ? 'terminal pane' : isCodex ? 'Codex pane' : 'Claude pane'}
          title={
            isTerminal
              ? s.active
                ? 'active pane'
                : 'inactive pane'
              : claudeState === 'ask'
                ? 'waiting on a question'
                : claudeState === 'cloning'
                  ? 'running sub-agents…'
                  : claudeState === 'working'
                    ? 'working…'
                    : 'idle'
          }
        >
          {isTerminal ? (
            <TerminalSquareIcon size={18} />
          ) : isCodex ? (
            <CodexIcon size={15} />
          ) : (
            <ClaudeRobotIcon size={17} />
          )}
          {claudeState === 'ask' ? (
            <span className="pane-icon-badge pane-icon-ask" aria-hidden="true">?</span>
          ) : claudeState === 'cloning' ? (
            <span className="pane-icon-badge pane-icon-clone" aria-hidden="true" />
          ) : claudeState === 'sleeping' ? (
            <span className="pane-icon-badge pane-icon-zzz" aria-hidden="true">z</span>
          ) : null}
        </span>
        <span className="session-name">{label}</span>
        {!isTerminal && claudeState === 'working' ? (
          <span className="thinking-dot" aria-label="working" title="Working…" />
        ) : null}
        {s.errored ? (
          <span className="error-badge" aria-label="API error — needs retry">
            ERROR
          </span>
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
      {!isTerminal && (s.model || s.ctxPct != null || (isCodex && s.usagePct != null)) ? (
        <div className="session-meta">
          {s.model ? <span className="meta-model">{s.model}</span> : null}
          {s.ctxPct != null ? (
            <span className="meta-ctx">ctx:{Math.round(s.ctxPct)}%</span>
          ) : null}
          {isCodex && s.usagePct != null ? (
            <span className="meta-usage">
              {formatUsageWindow(s.usageWindowMin)}:{Math.round(s.usagePct)}%
            </span>
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
  workingOverrideId,
  runningSubagentCountById,
}: SessionRailProps) {
  // Apply the kind filter BEFORE grouping so empty groups/windows drop out.
  const groups = useMemo(() => {
    const visible = sessions.filter((s) => {
      if (filter === 'all') return true;
      if (filter === 'agents') return s.kind !== 'terminal'; // claude + codex, no shells
      if (filter === 'terminal') return s.kind === 'terminal';
      if (filter === 'codex') return s.kind === 'codex';
      // 'claude' filter: show claude panes (kind === 'claude' or kind unset, but not terminal/codex)
      return s.kind !== 'terminal' && s.kind !== 'codex';
    });
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
                          workingOverrideId={workingOverrideId}
                          hasRunningSubagents={
                            runningSubagentCountById != null &&
                            (runningSubagentCountById[s.id] ?? 0) > 0
                          }
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
