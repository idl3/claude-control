/**
 * lib/sessions.js — SessionRegistry
 *
 * Periodically reconciles tmux windows with Claude transcript files found under
 * projectsRoot. Emits 'change' when the session list changes. Never reads a
 * transcript file in full — only the tail (≤64 KB) of the newest *.jsonl per
 * project directory.
 */

import { EventEmitter } from 'node:events';

import { parseTuiStatus, prettyModel } from './tui.js';
import { adapterFor, adapterById, ADAPTERS } from './agents/index.js';

// A pane is a Claude Code session when its process title is the Claude version
// (e.g. "2.1.162") — shells report zsh/bash/etc. A linked transcript also counts.
function isClaudeCmd(cmd) {
  return /^\d+\.\d+(\.\d+)?$/.test(String(cmd || '').trim());
}

const REFRESH_INTERVAL_MS = 4000;
const CTX_POLL_INTERVAL_MS = 12000; // TUI ctx%/model capture — slower than refresh

/**
 * Encode an absolute cwd the way Claude Code names its transcript project
 * directories: every '/' and '.' becomes '-'. This is derived from the cwd the
 * session was LAUNCHED in (== the tmux pane's current path), so it is immune to
 * a mid-session `cd` that would change the cwd recorded inside the transcript.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function encodeCwd(cwd) {
  return cwd.replace(/[/.]/g, '-');
}

/**
 * Is the cwd recorded inside a transcript consistent with a tmux window's cwd?
 * True when unknown (null), equal, or a descendant directory (the session
 * launched in winCwd and later cd'd deeper). Guards against encodeCwd collisions.
 *
 * @param {string|null} recCwd  cwd recorded in the transcript tail
 * @param {string} winCwd       tmux pane current path
 * @returns {boolean}
 */
export function isCwdConsistent(recCwd, winCwd) {
  if (!recCwd) return true;
  return recCwd === winCwd || recCwd.startsWith(winCwd.replace(/\/$/, '') + '/');
}

// Re-export so test/push-pending.test.js can import from '../lib/sessions.js'
// unchanged, while the canonical implementation lives in lib/pending.js.
export { detectTranscriptPending } from './pending.js';

// ---------------------------------------------------------------------------
// SessionRegistry
// ---------------------------------------------------------------------------

export class SessionRegistry extends EventEmitter {
  /**
   * @param {{ projectsRoot: string, codexSessionsRoot?: string, tmux: object, debounceMs?: number, adapters?: import('./agents/adapter.js').AgentAdapter[] }} opts
   */
  constructor({ projectsRoot, codexSessionsRoot, tmux, debounceMs = 1000, adapters } = {}) {
    super();
    this._projectsRoot = projectsRoot;
    this._codexSessionsRoot = codexSessionsRoot;
    this._tmux = tmux;
    this._debounceMs = debounceMs;
    /** @type {import('./agents/adapter.js').AgentAdapter[]} */
    this._adapters = adapters ?? ADAPTERS;

    /** @type {Session[]} */
    this._sessions = [];
    /** @type {string|null} — last JSON snapshot for change detection */
    this._lastEmitted = null;
    /** @type {Map<string, boolean>} id -> pending flag */
    this._pendingMap = new Map();
    /** @type {Map<string, {ctxPct:number|null, model:string|null}>} windowId -> TUI status */
    this._ctxMap = new Map();
    /**
     * Native Codex pending shape per session id, set by _pollCtx.
     * @type {Map<string, object>}
     */
    this._codexPending = new Map();
    /**
     * Last-emitted codexPending toolUseId per session id, for edge-detection.
     * @type {Map<string, string|null>}
     */
    this._lastCodexPendingId = new Map();
    /** @type {ReturnType<setInterval>|null} */
    this._interval = null;
    /** @type {ReturnType<setInterval>|null} */
    this._ctxInterval = null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** @returns {Session[]} */
  getSessions() {
    return this._sessions;
  }

  /**
   * Set the pending flag for a session (called by server when tailer fires
   * 'pending'). Emits 'change' if the flag actually flipped.
   *
   * @param {string} id
   * @param {boolean} pending
   */
  setPending(id, pending) {
    const session = this._sessions.find((s) => s.id === id);
    if (!session) return;
    const was = session.pending;
    session.pending = !!pending;
    this._pendingMap.set(id, !!pending);
    if (was !== session.pending) {
      this._maybeEmit();
    }
  }

  /**
   * Return the stored native Codex pending shape for a session, or null.
   *
   * @param {string} id
   * @returns {object|null}
   */
  getCodexPending(id) {
    return this._codexPending.get(id) ?? null;
  }

  /**
   * Clear the stored native Codex pending shape for a session and flip the
   * rail pending flag off (called after a successful answer is sent).
   *
   * @param {string} id
   */
  clearCodexPending(id) {
    this._codexPending.delete(id);
    this._lastCodexPendingId.delete(id);
    this.setPending(id, false);
  }

  /**
   * Rescan tmux windows and project directories. Returns the new session list.
   *
   * @returns {Promise<Session[]>}
   */
  async refresh() {
    const [allWindows, transcriptIndex] = await Promise.all([
      this._listWindows(),
      this._buildTranscriptIndex(),
    ]);

    // Grouped tmux sessions (e.g. a `_mobile` mirror of session `0`) expose the
    // SAME underlying window under multiple session names — identical window_id.
    // Collapse those so the UI shows each real window once (keeping the first,
    // which is the primary session by tmux's list ordering).
    const seenWindowIds = new Set();
    const windows = allWindows.filter((w) => {
      if (seenWindowIds.has(w.windowId)) return false;
      seenWindowIds.add(w.windowId);
      return true;
    });

    const sessions = windows.map((win) => {
      // Primary match: directory-name encoding (survives mid-session `cd`).
      // encodeCwd is lossy ('/' and '.' both -> '-'), so a byDir hit is only
      // trusted when the cwd recorded inside the transcript is consistent with
      // this window's cwd — equal, a descendant (the agent cd'd into a subdir),
      // or absent. An unrelated sibling (e.g. my.lib vs my-lib) is rejected and
      // falls through to the exact-cwd index.
      const byDirHit = transcriptIndex.byDir.get(encodeCwd(win.cwd));
      const transcript =
        (byDirHit && isCwdConsistent(byDirHit.cwd, win.cwd) ? byDirHit : null) ??
        transcriptIndex.byCwd.get(win.cwd) ??
        null;
      const id = win.target;
      // Pending = subscribed-tailer pending (live modal) OR transcript-derived
      // pending (works for ANY session, even unsubscribed ones, for push).
      const pending =
        (this._pendingMap.get(id) ?? false) || !!transcript?.transcriptPending;
      const title = transcript?.customTitle || transcript?.aiTitle || null;
      const ctx = this._ctxMap.get(win.windowId) || {};

      const agentType = transcript?.agentType ?? (isClaudeCmd(win.cmd) ? 'claude' : null);
      return {
        id,
        sessionId: transcript?.sessionId ?? null,
        // Best label: live TUI/transcript title > tmux window name > target.
        name: title || win.windowName || win.target,
        title,
        tmuxName: win.windowName,
        target: win.target,
        sessionName: win.sessionName,
        windowIndex: win.windowIndex,
        paneIndex: win.paneIndex,
        windowId: win.windowId,
        active: win.active,
        cwd: win.cwd,
        transcriptPath: transcript?.transcriptPath ?? null,
        lastActivity: transcript?.lastActivity ?? null,
        pending,
        pendingQuestion: transcript?.pendingQuestion ?? null,
        cmd: win.cmd,
        agentType,
        isClaude: true,
        model: ctx.model || prettyModel(transcript?.model) || null,
        ctxPct: ctx.ctxPct ?? null,
      };
    });

    // Dedup transcript collisions: when multiple tmux windows share a cwd they
    // all match the SAME newest transcript for that dir → the rail shows the
    // same title twice and two sessions tail one file. Keep the transcript on
    // the best (active, else first-seen) session; strip it from the others so
    // they stay distinct, transcript-less live panes (still subscribable).
    const seenTranscript = new Set();
    const byPriority = [...sessions].sort((a, b) =>
      a.active === b.active ? 0 : a.active ? -1 : 1,
    );
    for (const s of byPriority) {
      if (!s.transcriptPath) continue;
      if (seenTranscript.has(s.transcriptPath)) {
        s.transcriptPath = null;
        s.sessionId = null;
        s.lastActivity = null;
        s.title = null;
        s.name = s.tmuxName || s.target;
        // This session no longer owns the transcript, so its transcript-derived
        // pending is bogus; drop it (the owning session keeps the real one).
        s.pending = this._pendingMap.get(s.id) ?? false;
        s.pendingQuestion = null;
      } else {
        seenTranscript.add(s.transcriptPath);
      }
    }

    // Only surface agent sessions; skip plain shell panes.
    // adapterFor returns non-null for any recognised agent cmd; with only Claude
    // registered this is identical to the previous isClaudeCmd guard.
    this._sessions = sessions.filter((s) => adapterFor(s.cmd) || s.transcriptPath);
    this._maybeEmit();
    return this._sessions;
  }

  /**
   * Capture each pane's TUI status line and parse model + context %.
   * For Codex sessions also detects approval modal pending state.
   * Throttled (separate from the 4 s refresh) and best-effort — capture-pane is
   * cheap but we keep it off the hot path per the resource doctrine.
   */
  async _pollCtx() {
    const sessions = this._sessions;
    await Promise.all(
      sessions.map(async (s) => {
        if (!this._tmux.isValidTarget(s.target)) return;
        try {
          const cap = await this._tmux.capturePane(s.target, 8);
          // ctx/model parse — applies to all agent types via tui.js.
          const { ctxPct, model } = parseTuiStatus(cap);
          this._ctxMap.set(s.windowId, { ctxPct, model });
          // Merge into the live session object without a full rebuild.
          if (ctxPct !== null) s.ctxPct = ctxPct;
          if (model) s.model = model;

          // Codex-specific: detect approval modal pending from the capture.
          if (s.agentType === 'codex') {
            const adapter = adapterById('codex');
            if (adapter) {
              const native = adapter.detectPendingFromCapture(cap);
              const wasPending = this._codexPending.has(s.id);
              if (native.transcriptPending) {
                this._codexPending.set(s.id, native);
              } else {
                this._codexPending.delete(s.id);
              }
              this.setPending(s.id, !!native.transcriptPending);

              // Edge-detect: only emit 'codexPending' when the modal content
              // actually changed (prevents spamming subscribers on every poll).
              const newId = native.transcriptPending
                ? `codex:${native.pendingKind}:${(native.options || []).map((o) => `${o.n}:${o.label}`).join('|')}`
                : null;
              const lastId = this._lastCodexPendingId.get(s.id) ?? null;
              if (newId !== lastId) {
                this._lastCodexPendingId.set(s.id, newId);
                this.emit('codexPending', s.id, native.transcriptPending ? native : null);
              }
            }
          }
        } catch {
          // pane gone / capture failed — leave previous values
        }
      }),
    );
    this._maybeEmit();
  }

  /** Start periodic refresh (every 4 s) + a slower ctx poll, and fire both once. */
  start() {
    this.refresh().then(() => this._pollCtx()).catch(() => {});
    this._interval = setInterval(() => {
      this.refresh().catch(() => {});
    }, REFRESH_INTERVAL_MS);
    this._ctxInterval = setInterval(() => {
      this._pollCtx().catch(() => {});
    }, CTX_POLL_INTERVAL_MS);
    if (this._interval.unref) this._interval.unref();
    if (this._ctxInterval.unref) this._ctxInterval.unref();
  }

  /** Stop periodic refresh. */
  stop() {
    if (this._interval !== null) {
      clearInterval(this._interval);
      this._interval = null;
    }
    if (this._ctxInterval) {
      clearInterval(this._ctxInterval);
      this._ctxInterval = null;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Safely call tmux.listWindows(), falling back to [] on any error.
   *
   * @returns {Promise<import('./tmux.js').Window[]>}
   */
  async _listWindows() {
    try {
      return await this._tmux.listWindows();
    } catch {
      return [];
    }
  }

  /**
   * Iterate all registered adapters, call each adapter's `buildTranscriptIndex`,
   * and merge the per-adapter {byCwd, byDir} results into one index (newest
   * mtime wins per key). With only ClaudeAdapter registered the result is
   * byte-identical to the previous single-adapter implementation.
   *
   * @returns {Promise<import('./agents/adapter.js').TranscriptIndex>}
   */
  async _buildTranscriptIndex() {
    /** @type {import('./agents/adapter.js').TranscriptIndex} */
    const merged = { byDir: new Map(), byCwd: new Map() };

    const roots = { projectsRoot: this._projectsRoot, codexSessionsRoot: this._codexSessionsRoot };
    const perAdapter = await Promise.all(
      this._adapters.map((adapter) => adapter.buildTranscriptIndex(roots)),
    );

    for (const { byDir, byCwd } of perAdapter) {
      if (byDir) {
        for (const [key, rec] of byDir) {
          const existing = merged.byDir.get(key);
          if (!existing || rec.mtime > existing.mtime) merged.byDir.set(key, rec);
        }
      }
      for (const [key, rec] of byCwd) {
        const existing = merged.byCwd.get(key);
        if (!existing || rec.mtime > existing.mtime) merged.byCwd.set(key, rec);
      }
    }

    return merged;
  }

  /**
   * Emit 'change' only when the serialized sessions differ from the last
   * emission.
   */
  _maybeEmit() {
    const serialized = JSON.stringify(this._sessions);
    if (serialized !== this._lastEmitted) {
      this._lastEmitted = serialized;
      this.emit('change', this._sessions);
    }
  }
}
