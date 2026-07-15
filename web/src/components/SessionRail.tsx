import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '../lib/types';
import gsap, { prefersReducedMotion } from '../lib/anim';
import { ClaudeRobotIcon } from './ClaudeRobotIcon';
import { TerminalSquareIcon, CloudIcon, PencilIcon } from './icons';
import { CodexIcon } from './CodexIcon';
import { prettifyRemoteId } from '../lib/olamLabel';
import { renameTmuxSession } from '../lib/api';

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
  /** Success/error feedback for the tmux-session rename affordance below —
   *  same shape as App's showToast. Optional so existing/test call sites
   *  don't need to wire it; failures are silently logged when absent. */
  onToast?: (text: string, kind?: 'ok' | 'error' | '') => void;
}

/**
 * Sanitize a user-typed tmux SESSION name client-side before it ever reaches
 * the network — same rule as lib/tmux.js's sanitizeName (which re-applies it
 * server-side too, so this is defense-in-depth, not the source of truth):
 * strip ASCII control chars/newlines, collapse whitespace, trim, cap length.
 * Exported for direct unit testing.
 */
export function sanitizeGroupName(name: string): string {
  return String(name ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
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

interface RemoteOrgGroup {
  org: string;
  health: { status: string; reason: string | null };
  /** Non-archived AND current (live or active in the last 48h) — shown by default. */
  rows: Session[];
  /** Non-archived but older-idle rows — collapsed under "Earlier (N)", default
   *  collapsed. Keeps a large backfill from scrolling the rail. Never dropped. */
  earlierRows: Session[];
  /** Archived rows (lib/olam-archive.js deriveArchived) — rendered under a
   *  collapsible "Archived (N)" section, default collapsed. Never dropped. */
  archivedRows: Session[];
}

/** Newest-activity-first comparator shared by active + archived rail lists. */
function byRecentActivity(x: Session, y: Session): number {
  return String(y.lastActivity ?? '').localeCompare(String(x.lastActivity ?? ''));
}

/** Rows older than this with no live signal collapse under "Earlier". */
const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000; // 48h

/** Best-effort activity epoch (ms) for a remote row. `lastActivityMs` wins;
 *  otherwise `lastActivity`, which the olam client sets from the server as an
 *  ISO string (`last_turn_at ?? created_at`) even though the field is loosely
 *  typed `number`. Handles both string (ISO) and numeric (epoch-ms) forms. */
function activityMs(s: Session): number {
  if (typeof s.lastActivityMs === 'number' && Number.isFinite(s.lastActivityMs)) return s.lastActivityMs;
  const la: unknown = s.lastActivity;
  if (typeof la === 'number' && Number.isFinite(la)) return la;
  if (typeof la === 'string' && la) {
    const p = Date.parse(la);
    if (Number.isFinite(p)) return p;
  }
  return NaN;
}

/** A remote row is "current" (shown by default) when it's still LIVE — in-flight,
 *  awaiting a reply (`pending`), or `halted` — OR it saw activity within the last
 *  48h. Older idle rows collapse under "Earlier (N)" so a large backfill can't
 *  scroll the rail off. Nothing is dropped; the collapse is one click away. */
export function isCurrentRemote(s: Session, now: number = Date.now()): boolean {
  if (s.inFlight || s.pending || s.halted) return true;
  const ms = activityMs(s);
  return Number.isFinite(ms) && now - ms < RECENT_WINDOW_MS;
}

/** Group remote (olam) rows per org into current / earlier / archived, newest
 *  activity first within each. `now` is injectable for deterministic tests. */
export function groupRemoteByOrg(sessions: Session[], now: number = Date.now()): RemoteOrgGroup[] {
  const byOrg = new Map<string, Session[]>();
  for (const s of sessions) {
    const org = s.org ?? '?';
    if (!byOrg.has(org)) byOrg.set(org, []);
    byOrg.get(org)!.push(s);
  }
  return [...byOrg.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([org, all]) => {
      const active = all.filter((s) => !s.archived);
      return {
        org,
        health: all[0]?.orgHealth ?? { status: 'unknown', reason: null },
        rows: active.filter((s) => isCurrentRemote(s, now)).sort(byRecentActivity),
        earlierRows: active.filter((s) => !isCurrentRemote(s, now)).sort(byRecentActivity),
        archivedRows: all.filter((s) => s.archived).sort(byRecentActivity),
      };
    });
}

/**
 * Rail-row label for a remote (olam) session. Never falls through to the raw
 * 36-char `olam:org:uuid` id — the SAME prettifier the detail header uses
 * (sessionDisplayLabel/prettifyRemoteId, web/src/lib/olamLabel.ts) turns an
 * id-only row into "atlas · 55717fae". Real titles backfill separately
 * server-side and take over automatically once present.
 */
export function remoteRowLabel(s: Pick<Session, 'title' | 'summary' | 'id'>): string {
  return s.title || s.summary || prettifyRemoteId(s.id);
}

function RemoteRow({
  s,
  selected,
  onSelect,
}: {
  s: Session;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const label = remoteRowLabel(s);
  const phase = s.phase ?? (s.halted ? 'halted' : null);
  return (
    <li>
      <button
        type="button"
        className={`session-item remote-item${selected ? ' selected' : ''}${s.stale ? ' remote-stale' : ''}`}
        role="option"
        aria-selected={selected}
        onClick={() => onSelect(s.id)}
        title={s.linearRef ? `Linear agent session ${s.linearRef}` : s.id}
      >
        <div className="session-top">
          {/* Leading icon, mirroring PaneRow's .session-top / .pane-icon — gives
              remote rows the same visual anchor as local Claude/Codex/terminal rows. */}
          <span
            className="pane-icon"
            data-kind="remote"
            data-active="true"
            aria-label="olam remote session"
          >
            <CloudIcon size={16} />
          </span>
          <span className="remote-item-label">{label}</span>
          <span className="remote-item-badges">
            {s.inFlight ? <span className="remote-badge remote-badge-inflight">in-flight</span> : null}
            {phase ? <span className={`remote-badge remote-badge-phase-${phase}`}>{phase}</span> : null}
            {s.pool ? <span className="remote-badge remote-badge-pool">{s.pool}</span> : null}
            {s.archived ? <span className="remote-badge remote-badge-archived">archived</span> : null}
            {s.prs?.length ? (
              <a
                href={s.prs[0].url}
                target="_blank"
                rel="noopener noreferrer"
                className="remote-badge remote-badge-pr"
                onClick={(e) => e.stopPropagation()}
              >
                {s.prs.length > 1 ? `${s.prs.length} PRs` : `PR #${s.prs[0].number ?? ''}`}
              </a>
            ) : null}
            {s.stale ? <span className="remote-badge remote-badge-stale">stale</span> : null}
          </span>
        </div>
        {/* Model + context-remaining — SAME session-meta render local PaneRow
            uses (Change 2, coordinator direction: cockpit-only render
            passthrough). Silent until s.model/s.ctxPct are populated; the
            olam-side SPA change to surface message_usage lands separately. */}
        {s.model || s.ctxPct != null ? (
          <div className="session-meta">
            {s.model ? <span className="meta-model">{s.model}</span> : null}
            {s.ctxPct != null ? (
              <span className="meta-ctx">ctx:{Math.round(s.ctxPct)}%</span>
            ) : null}
          </div>
        ) : null}
      </button>
    </li>
  );
}

/** One org's remote (olam) section: active rows always shown, archived rows
 *  collapsed under "Archived (N)" by default — never hard-removed. */
function RemoteOrgSection({
  g,
  selectedId,
  onSelect,
}: {
  g: RemoteOrgGroup;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [earlierOpen, setEarlierOpen] = useState(false);
  return (
    <section className="session-group remote-group">
      <div className="session-group-head remote-group-head">
        <span
          className={`remote-health remote-health-${g.health.status}`}
          title={g.health.reason ?? g.health.status}
          aria-label={`org ${g.org} health ${g.health.status}`}
        />
        <span className="session-group-name">olam · {g.org}</span>
        <span className="session-group-count">{g.rows.length}</span>
      </div>
      {g.health.reason ? (
        <div className="remote-group-reason" role="note">{g.health.reason}</div>
      ) : null}
      {g.rows.length === 0 && g.earlierRows.length === 0 && g.archivedRows.length === 0 ? (
        <div className="session-empty">no remote sessions</div>
      ) : (
        // .session-window (no header — olam rows have no tmux window concept)
        // matches the left-border indent local PaneRow lists get for free.
        <div className="session-window remote-window">
          <ul className="session-pane-list">
            {g.rows.map((s) => (
              <RemoteRow key={s.id} s={s} selected={s.id === selectedId} onSelect={onSelect} />
            ))}
          </ul>
        </div>
      )}
      {g.earlierRows.length > 0 ? (
        <div className="remote-archived remote-earlier" data-collapsed={earlierOpen ? undefined : 'true'}>
          <button
            type="button"
            className="remote-archived-toggle"
            aria-expanded={earlierOpen}
            onClick={() => setEarlierOpen((v) => !v)}
          >
            <span className="remote-archived-chevron" aria-hidden="true">
              {earlierOpen ? '▾' : '▸'}
            </span>
            Earlier ({g.earlierRows.length})
          </button>
          {earlierOpen ? (
            <div className="session-window remote-window">
              <ul className="session-pane-list">
                {g.earlierRows.map((s) => (
                  <RemoteRow key={s.id} s={s} selected={s.id === selectedId} onSelect={onSelect} />
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
      {g.archivedRows.length > 0 ? (
        <div className="remote-archived" data-collapsed={archivedOpen ? undefined : 'true'}>
          <button
            type="button"
            className="remote-archived-toggle"
            aria-expanded={archivedOpen}
            onClick={() => setArchivedOpen((v) => !v)}
          >
            <span className="remote-archived-chevron" aria-hidden="true">
              {archivedOpen ? '▾' : '▸'}
            </span>
            Archived ({g.archivedRows.length})
          </button>
          {archivedOpen ? (
            <div className="session-window remote-window">
              <ul className="session-pane-list">
                {g.archivedRows.map((s) => (
                  <RemoteRow key={s.id} s={s} selected={s.id === selectedId} onSelect={onSelect} />
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
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
          {/* ⌘N badge — covers the icon glyph while ⌘ is held (see
              .app[data-cmd-held] in styles.css), so the hotkey target of
              each local row is readable at a glance. Only local claude/codex
              rows ever get a `hotkey` value (hotkeyById excludes
              terminal/remote — see App.tsx addressableClaude). */}
          {hotkey ? (
            <span className="session-hotkey-badge" aria-hidden="true">
              {hotkey}
            </span>
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
  onToast,
}: SessionRailProps) {
  // Inline tmux-session rename (the group header, e.g. "0") — double-click the
  // name or use the hover-reveal pencil button. Only one group can be renaming
  // at a time; null when nothing is being edited. The rail picks up the new
  // name on the next registry refresh (same poll-driven convention as the
  // per-window rename in App.tsx — no forced refetch needed).
  const [renamingSession, setRenamingSession] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameSubmittingRef = useRef(false);

  useEffect(() => {
    if (renamingSession !== null) renameInputRef.current?.select();
  }, [renamingSession]);

  const startRenameSession = (name: string) => {
    setRenamingSession(name);
    setRenameDraft(name);
  };
  const cancelRenameSession = () => {
    setRenamingSession(null);
    setRenameDraft('');
  };
  const submitRenameSession = async () => {
    if (renameSubmittingRef.current) return;
    const oldName = renamingSession;
    const draft = sanitizeGroupName(renameDraft);
    cancelRenameSession(); // close immediately, mirrors App.tsx's submitRename
    if (!oldName || !draft || draft === oldName) return;
    renameSubmittingRef.current = true;
    try {
      await renameTmuxSession(oldName, draft);
      onToast?.(`Renamed session → ${draft}`, 'ok');
    } catch (err) {
      onToast?.(`rename failed: ${err instanceof Error ? err.message : 'error'}`, 'error');
    } finally {
      renameSubmittingRef.current = false;
    }
  };
  // Apply the kind filter BEFORE grouping so empty groups/windows drop out.
  const groups = useMemo(() => {
    const visible = sessions.filter((s) => {
      if (s.kind === 'remote') return false; // remote rows render in their own org sections
      if (filter === 'all') return true;
      if (filter === 'agents') return s.kind !== 'terminal'; // claude + codex, no shells
      if (filter === 'terminal') return s.kind === 'terminal';
      if (filter === 'codex') return s.kind === 'codex';
      // 'claude' filter: show claude panes (kind === 'claude' or kind unset, but not terminal/codex)
      return s.kind !== 'terminal' && s.kind !== 'codex';
    });
    return groupByTmux(visible);
  }, [sessions, filter]);

  // Remote (olam) org sections — shown under 'all' and 'agents' filters.
  const remoteGroups = useMemo(() => {
    if (filter !== 'all' && filter !== 'agents') return [];
    return groupRemoteByOrg(sessions.filter((s) => s.kind === 'remote'));
  }, [sessions, filter]);

  if (groups.length === 0 && remoteGroups.length === 0) {
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
        const isRenamingThis = renamingSession === g.sessionName;
        return (
          <section key={g.sessionName} className="session-group" data-collapsed={isCollapsed ? 'true' : undefined}>
            <div
              className="session-group-head"
              data-renaming={isRenamingThis ? 'true' : undefined}
            >
              <button
                type="button"
                className="session-group-toggle"
                aria-expanded={!isCollapsed}
                onClick={() => onToggleCollapse(g.sessionName)}
              >
                <span className="session-group-chevron" aria-hidden="true">
                  {isCollapsed ? '▸' : '▾'}
                </span>
                {isRenamingThis ? null : (
                  <span
                    className="session-group-name"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      startRenameSession(g.sessionName);
                    }}
                  >
                    {g.sessionName}
                  </span>
                )}
              </button>
              {isRenamingThis ? (
                <input
                  ref={renameInputRef}
                  className="session-group-rename-input"
                  type="text"
                  value={renameDraft}
                  aria-label={`Rename tmux session ${g.sessionName}`}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void submitRenameSession();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelRenameSession();
                    }
                  }}
                  onBlur={() => void submitRenameSession()}
                />
              ) : (
                <button
                  type="button"
                  className="session-group-rename-btn"
                  aria-label={`Rename tmux session ${g.sessionName}`}
                  title="Rename session"
                  onClick={(e) => {
                    e.stopPropagation();
                    startRenameSession(g.sessionName);
                  }}
                >
                  <PencilIcon size={12} />
                </button>
              )}
              {isCollapsed ? <span className="session-group-count">{paneCount}</span> : null}
            </div>
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
      {remoteGroups.map((g) => (
        <RemoteOrgSection key={`remote:${g.org}`} g={g} selectedId={selectedId} onSelect={onSelect} />
      ))}
    </div>
  );
}
