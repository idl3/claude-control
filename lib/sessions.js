/**
 * lib/sessions.js — SessionRegistry
 *
 * Periodically reconciles tmux windows with Claude transcript files found under
 * projectsRoot. Emits 'change' when the session list changes. Never reads a
 * transcript file in full — only the tail (≤64 KB) of the newest *.jsonl per
 * project directory.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

import { parseTuiStatus, prettyModel } from './tui.js';

// A pane is a Claude Code session when its process title is the Claude version
// (e.g. "2.1.162") — shells report zsh/bash/etc. A linked transcript also counts.
function isClaudeCmd(cmd) {
  return /^\d+\.\d+(\.\d+)?$/.test(String(cmd || '').trim());
}

const TAIL_BYTES = 64 * 1024; // 64 KB max tail read
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

const PENDING_QUESTION_MAX = 140; // truncate the surfaced question text

/**
 * Walk a set of JSONL tail lines and decide whether an AskUserQuestion is still
 * OPEN — i.e. an assistant `tool_use` block named "AskUserQuestion" exists whose
 * id has NO matching `tool_result` (tool_use_id) later in the tail. Pure and
 * unit-testable in isolation (see test/push-pending.test.js).
 *
 * @param {string[]} lines  Complete JSONL lines (partial first line tolerated).
 * @returns {{ transcriptPending: boolean, pendingToolUseId: string|null, pendingQuestion: string|null }}
 */
export function detectTranscriptPending(lines) {
  /** @type {Map<string, string|null>} open AskUserQuestion id -> first question text */
  const open = new Map();
  const resolved = new Set();

  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;

    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (
        rec.type === 'assistant' &&
        block.type === 'tool_use' &&
        block.name === 'AskUserQuestion' &&
        typeof block.id === 'string'
      ) {
        const q = block.input?.questions?.[0]?.question;
        open.set(block.id, typeof q === 'string' ? q : null);
      } else if (
        rec.type === 'user' &&
        block.type === 'tool_result' &&
        typeof block.tool_use_id === 'string'
      ) {
        resolved.add(block.tool_use_id);
      }
    }
  }

  // Newest still-open AskUserQuestion (Map preserves insertion order).
  let pendingToolUseId = null;
  let pendingQuestion = null;
  for (const [id, question] of open) {
    if (resolved.has(id)) continue;
    pendingToolUseId = id;
    pendingQuestion = question;
  }

  if (pendingQuestion && pendingQuestion.length > PENDING_QUESTION_MAX) {
    pendingQuestion = pendingQuestion.slice(0, PENDING_QUESTION_MAX);
  }

  return {
    transcriptPending: pendingToolUseId !== null,
    pendingToolUseId,
    pendingQuestion,
  };
}

// ---------------------------------------------------------------------------
// Tiny tail-read helper
// ---------------------------------------------------------------------------

/**
 * Read the last `maxBytes` of a file and return its contents as a Buffer.
 * Never throws — returns null on any error.
 *
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {Promise<Buffer|null>}
 */
async function readTail(filePath, maxBytes) {
  let fh;
  try {
    fh = await fs.open(filePath, 'r');
    const stat = await fh.stat();
    const size = stat.size;
    if (size === 0) return Buffer.alloc(0);
    const readSize = Math.min(size, maxBytes);
    const offset = size - readSize;
    const buf = Buffer.allocUnsafe(readSize);
    const { bytesRead } = await fh.read(buf, 0, readSize, offset);
    return buf.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/**
 * Parse the tail buffer of a JSONL file and return the last record that has a
 * truthy `.cwd` field, plus basic metadata.
 *
 * @param {string} filePath  Absolute path of the .jsonl file
 * @param {number} mtime     mtime (ms since epoch) of the file
 * @returns {Promise<{cwd:string, sessionId:string|null, lastActivity:string|null, transcriptPath:string, mtime:number}|null>}
 */
async function extractTailRecord(filePath, mtime) {
  const buf = await readTail(filePath, TAIL_BYTES);
  if (!buf) return null;

  const text = buf.toString('utf8');
  // Split on newlines; the first segment may be a partial line (the tail read
  // can start part-way through a line), so we never trust it — we only walk
  // complete lines from the end.
  const lines = text.split('\n');

  const base = {
    cwd: null,
    sessionId: null,
    lastActivity: null,
    model: null,
    aiTitle: null,
    customTitle: null,
    transcriptPath: filePath,
    mtime,
    transcriptPending: false,
    pendingToolUseId: null,
    pendingQuestion: null,
  };

  // Transcript-derived pending: detect an AskUserQuestion that is open in the
  // tail (no matching tool_result) even when no tailer is subscribed. Notifies
  // for ANY session, not just the one a client is watching.
  const pending = detectTranscriptPending(lines);
  base.transcriptPending = pending.transcriptPending;
  base.pendingToolUseId = pending.pendingToolUseId;
  base.pendingQuestion = pending.pendingQuestion;

  // Walk from end collecting the newest cwd/sessionId/timestamp/model/title.
  // ai-title is re-emitted throughout the file so the tail usually carries it;
  // custom-title (a user /rename) is written when renamed, so it appears late.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
    if (base.lastActivity === null && typeof rec.timestamp === 'string') base.lastActivity = rec.timestamp;
    if (base.sessionId === null && typeof rec.sessionId === 'string') base.sessionId = rec.sessionId;
    if (base.customTitle === null && rec.type === 'custom-title' && rec.customTitle) base.customTitle = rec.customTitle;
    if (base.aiTitle === null && rec.type === 'ai-title' && rec.aiTitle) base.aiTitle = rec.aiTitle;
    if (base.model === null && rec.type === 'assistant' && typeof rec.message?.model === 'string') base.model = rec.message.model;
    if (base.cwd === null && typeof rec.cwd === 'string' && rec.cwd) base.cwd = rec.cwd;
    if (base.cwd && base.sessionId && base.model && (base.customTitle || base.aiTitle)) {
      break; // everything found
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// findNewestJsonl — returns { path, mtime } or null
// ---------------------------------------------------------------------------

/**
 * Given a directory, find the *.jsonl file with the newest mtime.
 *
 * @param {string} dir
 * @returns {Promise<{filePath:string, mtime:number}|null>}
 */
async function findNewestJsonl(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }

  let newest = null;

  await Promise.all(
    entries
      .filter((e) => e.endsWith('.jsonl'))
      .map(async (e) => {
        const full = path.join(dir, e);
        let st;
        try { st = await fs.stat(full); } catch { return; }
        const mtime = st.mtimeMs;
        if (!newest || mtime > newest.mtime) {
          newest = { filePath: full, mtime };
        }
      }),
  );

  return newest;
}

// ---------------------------------------------------------------------------
// SessionRegistry
// ---------------------------------------------------------------------------

export class SessionRegistry extends EventEmitter {
  /**
   * @param {{ projectsRoot: string, tmux: object, debounceMs?: number }} opts
   */
  constructor({ projectsRoot, tmux, debounceMs = 1000 } = {}) {
    super();
    this._projectsRoot = projectsRoot;
    this._tmux = tmux;
    this._debounceMs = debounceMs;

    /** @type {Session[]} */
    this._sessions = [];
    /** @type {string|null} — last JSON snapshot for change detection */
    this._lastEmitted = null;
    /** @type {Map<string, boolean>} id -> pending flag */
    this._pendingMap = new Map();
    /** @type {Map<string, {ctxPct:number|null, model:string|null}>} windowId -> TUI status */
    this._ctxMap = new Map();
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

    // Only surface Claude sessions; skip plain shell panes.
    this._sessions = sessions.filter((s) => isClaudeCmd(s.cmd) || s.transcriptPath);
    this._maybeEmit();
    return this._sessions;
  }

  /**
   * Capture each Claude pane's TUI status line and parse model + context %.
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
          const { ctxPct, model } = parseTuiStatus(cap);
          this._ctxMap.set(s.windowId, { ctxPct, model });
          // Merge into the live session object without a full rebuild.
          if (ctxPct !== null) s.ctxPct = ctxPct;
          if (model) s.model = model;
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
   * Scan all immediate subdirectories of projectsRoot. For each, find the
   * newest *.jsonl and extract the last record that carries a .cwd field.
   * Returns a Map keyed by cwd (keeping the newest mtime entry per cwd).
   *
   * @returns {Promise<Map<string, {cwd:string, sessionId:string|null, lastActivity:string|null, transcriptPath:string, mtime:number}>>}
   */
  async _buildTranscriptIndex() {
    /** @type {{byDir: Map<string, object>, byCwd: Map<string, object>}} */
    const index = { byDir: new Map(), byCwd: new Map() };

    let projectEntries;
    try {
      const entries = await fs.readdir(this._projectsRoot, { withFileTypes: true });
      projectEntries = entries
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, dir: path.join(this._projectsRoot, e.name) }));
    } catch {
      return index;
    }

    await Promise.all(
      projectEntries.map(async ({ name, dir }) => {
        const newest = await findNewestJsonl(dir);
        if (!newest) return;

        const rec = await extractTailRecord(newest.filePath, newest.mtime);
        if (!rec) return;

        // Primary key: the project directory name (Claude Code's cwd encoding).
        const byDirExisting = index.byDir.get(name);
        if (!byDirExisting || newest.mtime > byDirExisting.mtime) {
          index.byDir.set(name, rec);
        }

        // Secondary key: the exact cwd recorded inside the transcript, when present.
        if (rec.cwd) {
          const byCwdExisting = index.byCwd.get(rec.cwd);
          if (!byCwdExisting || newest.mtime > byCwdExisting.mtime) {
            index.byCwd.set(rec.cwd, rec);
          }
        }
      }),
    );

    return index;
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
