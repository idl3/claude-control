import { useEffect, useMemo, useRef, useState } from 'react';
import { SlotText } from 'slot-text/react';
import type { Session } from '../lib/types';
import gsap, { prefersReducedMotion } from '../lib/anim';
import { ClaudeRobotIcon } from './ClaudeRobotIcon';
import { TerminalSquareIcon, CloudIcon, PencilIcon } from './icons';
import { CodexIcon } from './CodexIcon';
import { prettifyRemoteId } from '../lib/olamLabel';
import { renameTmuxSession } from '../lib/api';
import { loadRailTokens, orderMetaFields, type RailToken } from '../lib/railTokenPrefs';

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
  /** App's `cmdHeld` (useModifierHeld(500)) — same signal that drives the ⌘N
   *  hotkey badge via `.app[data-cmd-held]`. Threaded down as a prop (rather
   *  than a second listener in here) so each row's right-hand meta slot can
   *  swap to the tmux pane name in JS, not just CSS visibility. */
  cmdHeld?: boolean;
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
  panes: Session[];
}
interface SessionGroup {
  sessionName: string;
  windows: WindowGroup[];
}

/**
 * Format a Codex rate-limit window in minutes to a human label.
 * 300 → "5h", 10080 → "7d", other → "${min}m".
 * Exported for RailTokenConfig's live preview (Codex usage chip).
 */
export function formatUsageWindow(windowMin?: number | null): string {
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
  // Remote (olam) sessions have no `kind: 'codex'` — they're always
  // `kind: 'remote'` regardless of harness — so isCodex isn't readable off
  // s.kind here. Derive it from which effort source resolved: s.effort is
  // ONLY ever populated by the Claude statusLine scrape (lib/sessions.js), so
  // its presence means Claude; falling back to parsing the model id suffix
  // means the harness is Codex (the only convention that embeds effort
  // there).
  const remoteEffort = s.effort ?? (s.model ? parseEffort(s.model) : null);
  const remoteIsCodex = s.effort == null;
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
            {s.model ? <span className="meta-model">{formatModel(s.model)}</span> : null}
            {remoteEffort ? (
              <span className={effortClass(remoteEffort, remoteIsCodex)}>{remoteEffort}</span>
            ) : null}
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

/** Shared cycle period for every row's right-hand meta slot — see
 *  useMetaCyclePhase. Exported so the rail-token configurator's live preview
 *  (RailTokenConfig.tsx) can render the real separator interval
 *  (`${META_CYCLE_PERIOD_MS / 1000}s`) instead of a hardcoded guess, and
 *  reuse the same tick via useMetaCyclePhase. */
export const META_CYCLE_PERIOD_MS = 10_000;

/**
 * ONE shared 10s interval for the whole rail — every row's right-hand meta
 * slot reads the same tick, so they all swap in lockstep instead of each
 * row running its own timer. Returns a monotonically incrementing counter
 * (not just a boolean) so a row with N available fields can rotate through
 * all of them via `fields[tick % fields.length]` (see paneMetaFields).
 */
export function useMetaCyclePhase(periodMs = META_CYCLE_PERIOD_MS): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), periodMs);
    return () => clearInterval(timer);
  }, [periodMs]);
  return tick;
}

/** One field the row's right-hand meta slot can show, in cycle order. */
interface MetaField {
  key: 'model' | 'effort' | 'ctx' | 'usage' | 'cwd';
  text: string;
  className: string;
}

/**
 * Available meta fields for a row's right-hand slot, in cycle order —
 * model → context → (Codex-only) usage for Claude/Codex rows, or just the
 * cwd basename for terminals (a single "field" so it renders steady, never
 * blank). The shared `metaTick` (SessionRail-level, one interval for every
 * row) selects `fields[metaTick % fields.length]`, which reduces to a plain
 * model ⟷ context alternation for the common 2-field case and folds Codex's
 * extra rate-limit field into the same rotation instead of dropping it.
 */
/** Normalise the server's model label to a consistent lowercase `<model>-<version>`.
 *  Drops any trailing parenthetical (e.g. "Opus 4.8 (1M context)" → "opus-4.8") so
 *  every row reads the same. Already-hyphenated ids ("claude-fable-5", "gpt-5.5")
 *  pass through unchanged. */
/** Codex reasoning-effort suffixes baked into the model label (e.g.
 *  "gpt-5.5-xhigh"). Claude models carry no effort suffix — so effort is only
 *  available for the sessions whose model string ends in one of these. */
const EFFORT_RE = /-(minimal|low|medium|high|xhigh)$/;

/** Normalize a model id: drop trailing parenthetical, lowercase, hyphenate, and
 *  strip a "claude-" prefix. Does NOT touch the effort suffix. */
function normalizeModel(model: string): string {
  return model
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/^claude-/, ''); // "claude-fable-5" → "fable-5"
}

/** Display model id with the reasoning-effort suffix removed — effort is shown
 *  as its own meta dimension (see parseEffort / paneMetaFields), not inline.
 *  Exported for RailTokenConfig's live preview. */
export function formatModel(model: string): string {
  return normalizeModel(model).replace(EFFORT_RE, '');
}

/** The reasoning effort baked into a model id (e.g. "gpt-5.5-xhigh" → "xhigh"),
 *  or null when the model carries none (all Claude models, most Codex ones).
 *  Exported for RailTokenConfig's live preview. */
export function parseEffort(model: string): string | null {
  const m = normalizeModel(model).match(EFFORT_RE);
  return m ? m[1] : null;
}

/** Harness-aware color class for the effort chip. The two harnesses' tier
 *  ladders don't line up: Claude has a dedicated `max` tier above `xhigh`
 *  (statusLine `.effort.level`, surfaced via `s.effort`), while Codex tops
 *  out AT `xhigh` (no `max`) — so the "rainbow" top-tier treatment (borrowed
 *  from .ultrathink-text) lands on a different level per harness, and
 *  Claude's `xhigh` (one below its ceiling) reads as red rather than
 *  rainbow. Everything below that is shared: amber → yellow → gray.
 *  Exported for RailTokenConfig's live preview. */
export function effortClass(effort: string, isCodex: boolean): string {
  const level = effort.toLowerCase();
  if (isCodex) {
    switch (level) {
      case 'xhigh':
        return 'meta-effort meta-effort-rainbow';
      case 'high':
        return 'meta-effort meta-effort-amber';
      case 'medium':
        return 'meta-effort meta-effort-yellow';
      case 'low':
      case 'minimal':
      default:
        return 'meta-effort meta-effort-gray';
    }
  }
  switch (level) {
    case 'max':
      return 'meta-effort meta-effort-rainbow';
    case 'xhigh':
      return 'meta-effort meta-effort-red';
    case 'high':
      return 'meta-effort meta-effort-amber';
    case 'medium':
      return 'meta-effort meta-effort-yellow';
    case 'low':
    default:
      return 'meta-effort meta-effort-gray';
  }
}

/** Available meta fields for a row's right-hand slot, gated by data
 *  presence (same as ever) then reordered/filtered to the operator's
 *  configured `tokens` order (see lib/railTokenPrefs.ts, Settings → Rail
 *  tokens). Terminal rows ignore `tokens` entirely — they only ever have
 *  the one `cwd` field and no configurator entry for it. */
function paneMetaFields(
  s: Session,
  isTerminal: boolean,
  isCodex: boolean,
  tokens: RailToken[],
): MetaField[] {
  if (isTerminal) {
    return s.cwd ? [{ key: 'cwd', text: basename(s.cwd), className: 'meta-cwd' }] : [];
  }
  const fields: MetaField[] = [];
  if (s.model) fields.push({ key: 'model', text: formatModel(s.model), className: 'meta-model' });
  // Effort is a third rotating dimension: Claude reports it natively
  // (s.effort, from the statusLine's `.effort.level`); Codex has no dedicated
  // field so it stays parsed out of the model id suffix. Absent entirely for
  // models/harnesses that don't report a tier, so it simply doesn't join the
  // rotation there.
  const effort = s.effort ?? (s.model ? parseEffort(s.model) : null);
  if (effort) fields.push({ key: 'effort', text: effort, className: effortClass(effort, isCodex) });
  if (s.ctxPct != null) {
    fields.push({ key: 'ctx', text: `ctx:${Math.round(s.ctxPct)}%`, className: 'meta-ctx' });
  }
  if (isCodex && s.usagePct != null) {
    fields.push({
      key: 'usage',
      text: `${formatUsageWindow(s.usageWindowMin)}:${Math.round(s.usagePct)}%`,
      className: 'meta-usage',
    });
  }
  return orderMetaFields(fields, tokens);
}

function PaneRow({
  s,
  selected,
  onSelect,
  hotkey,
  workingOverrideId,
  hasRunningSubagents,
  cmdHeld,
  metaTick,
  railTokens,
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
  /** See SessionRailProps.cmdHeld — while true, the right-hand meta slot shows
   *  the tmux pane name (s.tmuxName) instead of cycling model/context. */
  cmdHeld?: boolean;
  /** Shared cycle phase (see paneMetaFields) — one counter for the whole rail,
   *  ticking every 10s, so every row's meta slot swaps in lockstep. */
  metaTick: number;
  /** Operator-configured meta-slot rotation + order (Settings → Rail tokens,
   *  see lib/railTokenPrefs.ts) — owned/loaded by SessionRail (the only
   *  consumer) and threaded down here for the paneMetaFields call. */
  railTokens: RailToken[];
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
  // ⌘-held right slot shows the session id; clicking it copies + flashes "Copied!".
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
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

  // Right-hand meta slot: tmux pane name while ⌘ is held (overrides the
  // cycle), else the current phase of the shared model/context(/usage) cycle.
  // The text TRANSITION is rendered by slot-text's <SlotText> (CSS text-roll,
  // see styles.css .session-row-meta) — ONE persistent SlotText instance
  // spans every state (no per-field `key`, unlike the old crossfade), so its
  // internal effect sees `text` change and plays the roll instead of a
  // React remount (which would skip the animation — see slot-text/react's
  // firstTextEffectRef, only animates on update, not on mount).
  const paneName = s.tmuxName;
  const showPaneName = Boolean(cmdHeld && paneName);
  const metaFields = paneMetaFields(s, isTerminal, isCodex, railTokens);
  const activeField = metaFields.length > 0 ? metaFields[metaTick % metaFields.length] : null;
  const slotOpts = { direction: 'up' as const, skipUnchanged: true, duration: 300 };

  const copyId = (e: React.MouseEvent) => {
    e.stopPropagation(); // copy the id, don't select the row
    const id = paneName ?? '';
    if (!id) return;
    void navigator.clipboard
      ?.writeText(id)
      .then(() => {
        setCopied(true);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  };

  // Right-hand meta slot. Priority: a just-copied "Copied!" flash → the ⌘-held
  // (clickable, copyable) session id → the rotating model/effort/ctx cycle.
  let rightSlot: React.ReactNode = null;
  if (copied) {
    rightSlot = (
      <span className="session-row-meta session-row-meta-copy" data-copied="true" title="Copied!">
        <SlotText text="Copied!" className="session-row-meta-pane" options={slotOpts} />
      </span>
    );
  } else if (showPaneName) {
    rightSlot = (
      <button
        type="button"
        className="session-row-meta session-row-meta-copy"
        title={`Copy session id: ${paneName}`}
        aria-label={`Copy session id ${paneName}`}
        onClick={copyId}
      >
        <SlotText text={paneName ?? ''} className="session-row-meta-pane" options={slotOpts} />
      </button>
    );
  } else if (activeField) {
    rightSlot = (
      <span className="session-row-meta" title={activeField.text}>
        <SlotText text={activeField.text} className={activeField.className} options={slotOpts} />
      </span>
    );
  }

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
        {/* Single right-hand meta slot, same real estate for every row kind —
            cycles model ⟷ context (⟷ Codex usage) every 10s (see metaTick /
            paneMetaFields), or shows the tmux pane name while ⌘ is held
            (overrides the cycle; the standalone "N <pane-name>" sub-label
            that used to sit above each window's panes is gone — this is
            the one place that name shows now). */}
        {rightSlot}
      </div>
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
  cmdHeld,
}: SessionRailProps) {
  // Shared cycle phase for every row's right-hand meta slot — see
  // useMetaCyclePhase / paneMetaFields.
  const metaTick = useMetaCyclePhase();

  // Operator-configured meta-slot token order (Settings → Rail tokens, see
  // lib/railTokenPrefs.ts). SessionRail is the only consumer, so it owns the
  // load + live-update listener directly (mirrors the cosmos-prefs pattern
  // in App.tsx, just scoped to the component that actually renders the
  // affected UI instead of threaded through App.tsx).
  const [railTokens, setRailTokens] = useState<RailToken[]>(loadRailTokens);
  useEffect(() => {
    const onPrefs = (e: Event) => {
      const d = (e as CustomEvent<{ railTokens?: RailToken[] }>).detail;
      if (d?.railTokens) setRailTokens(d.railTokens);
    };
    window.addEventListener('cockpit:railtokenprefs', onPrefs);
    return () => window.removeEventListener('cockpit:railtokenprefs', onPrefs);
  }, []);

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
                          cmdHeld={cmdHeld}
                          metaTick={metaTick}
                          railTokens={railTokens}
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
