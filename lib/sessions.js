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
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { parseTuiStatus, prettyModel } from './tui.js';
import { assignTranscripts, parseEtime } from './match.js';

const execFile = promisify(_execFile);

// Matches Claude Code's executable basename (e.g. /Users/x/.local/bin/claude).
const CLAUDE_COMM_RE = /(^|\/)claude$/;

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
 * @param {string} filePath     Absolute path of the .jsonl file
 * @param {number} mtime        mtime (ms since epoch) of the file
 * @param {number} [birthtime]  birthtime (ms since epoch) of the file
 * @returns {Promise<object|null>}
 */
async function extractTailRecord(filePath, mtime, birthtime = null) {
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
    lastActivityMs: null,
    model: null,
    aiTitle: null,
    customTitle: null,
    transcriptPath: filePath,
    mtime,
    birthtimeMs: birthtime,
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
    if (base.lastActivity === null && typeof rec.timestamp === 'string') {
      base.lastActivity = rec.timestamp;
      const t = Date.parse(rec.timestamp);
      base.lastActivityMs = Number.isNaN(t) ? null : t;
    }
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
// findRecentJsonl — newest-mtime *.jsonl files in a dir (top K)
// ---------------------------------------------------------------------------

/**
 * Given a directory, return its `k` *.jsonl files with the newest mtime, each
 * with `birthtimeMs`. We need more than one because multiple Claude sessions can
 * share a directory — each needs its own transcript candidate.
 *
 * @param {string} dir
 * @param {number} k
 * @returns {Promise<Array<{filePath:string, mtime:number, birthtimeMs:number}>>}
 */
async function findRecentJsonl(dir, k) {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const stats = await Promise.all(
    entries
      .filter((e) => e.endsWith('.jsonl'))
      .map(async (e) => {
        const full = path.join(dir, e);
        try {
          const st = await fs.stat(full);
          return { filePath: full, mtime: st.mtimeMs, birthtimeMs: st.birthtimeMs };
        } catch {
          return null;
        }
      }),
  );

  return stats
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, Math.max(1, k));
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
    /** @type {Map<string, {ctxPct:number|null, model:string|null}>} target -> TUI status */
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
    const allPanes = await this._listWindows();

    // Grouped tmux sessions (e.g. a `_mobile` mirror of session `0`) expose the
    // SAME underlying pane under multiple session names — identical
    // (window_id, pane_index). Collapse those so the UI shows each real pane
    // once (keeping the first, which is the primary session by tmux ordering).
    const seenPanes = new Set();
    const panes = allPanes.filter((p) => {
      const key = `${p.windowId}.${p.paneIndex}`;
      if (seenPanes.has(key)) return false;
      seenPanes.add(key);
      return true;
    });

    // Only Claude panes have transcripts to match (shells don't). Gather
    // candidate transcripts + process start times, then bind 1:1 so two
    // same-cwd sessions never share (or swap) a transcript.
    const claudePanes = panes.filter((p) => isClaudeCmd(p.cmd));
    const [candidates, procStart] = await Promise.all([
      this._buildCandidates(claudePanes),
      this._buildProcStart(claudePanes),
    ]);
    const assignment = assignTranscripts(
      claudePanes.map((p) => ({
        target: p.target,
        windowName: p.windowName,
        cwd: p.cwd,
        procStartMs: procStart.get(p.target) ?? null,
      })),
      candidates,
    );

    const sessions = panes.map((win) => {
      const transcript = isClaudeCmd(win.cmd)
        ? assignment.get(win.target) ?? null
        : null;
      const id = win.target;
      // Pending = subscribed-tailer pending (live modal) OR transcript-derived
      // pending (works for ANY session, even unsubscribed ones, for push).
      const pending =
        (this._pendingMap.get(id) ?? false) || !!transcript?.transcriptPending;
      const title = transcript?.customTitle || transcript?.aiTitle || null;
      const ctx = this._ctxMap.get(win.target) || {};

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

    // Only surface Claude sessions; skip plain shell panes. (assignTranscripts
    // already guarantees 1:1, so no post-hoc collision dedup is needed.)
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
          this._ctxMap.set(s.target, { ctxPct, model });
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
   * Build the transcript candidate pool for the given Claude panes. A session's
   * transcript lives in the project dir `encodeCwd(launchCwd)`, where launchCwd
   * is the pane's current path. For each such dir we read the newest few
   * transcripts (enough for every pane sharing that dir) so the matcher has a
   * real choice when sessions collide on a directory. Tail-only reads (≤64 KB).
   *
   * @param {import('./tmux.js').Window[]} claudePanes
   * @returns {Promise<object[]>} candidate records (see extractTailRecord)
   */
  async _buildCandidates(claudePanes) {
    // dir name -> how many panes launched there (so we fetch enough candidates).
    const dirCounts = new Map();
    for (const p of claudePanes) {
      const dir = encodeCwd(p.cwd);
      dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }

    const candidates = [];
    await Promise.all(
      [...dirCounts.entries()].map(async ([name, count]) => {
        const dir = path.join(this._projectsRoot, name);
        // A small buffer beyond the pane count tolerates resume/compaction
        // spawning a fresh file mid-session.
        const recent = await findRecentJsonl(dir, count + 2);
        const recs = await Promise.all(
          recent.map((r) =>
            extractTailRecord(r.filePath, r.mtime, r.birthtimeMs),
          ),
        );
        for (const rec of recs) if (rec) candidates.push(rec);
      }),
    );

    return candidates;
  }

  /**
   * Resolve each Claude pane's claude-process start time (ms epoch) for the
   * start-time matching pass. One `ps` snapshot, then walk the process tree from
   * each pane's shell pid to its `claude` descendant. Best-effort: panes whose
   * proc can't be found map to null and fall through to other match passes.
   *
   * @param {import('./tmux.js').Window[]} claudePanes
   * @returns {Promise<Map<string, number|null>>} target -> startMs
   */
  async _buildProcStart(claudePanes) {
    const out = new Map();
    if (claudePanes.length === 0) return out;

    let rows;
    try {
      const { stdout } = await execFile(
        'ps',
        ['-axo', 'pid=,ppid=,etime=,comm='],
        { timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
      );
      rows = stdout.split('\n');
    } catch {
      return out; // ps unavailable — every pane falls back to null
    }

    /** @type {Map<number, number[]>} ppid -> child pids */
    const children = new Map();
    /** @type {Map<number, {etime:string, comm:string}>} */
    const info = new Map();
    for (const line of rows) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      info.set(pid, { etime: m[3], comm: m[4] });
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
    }

    const now = Date.now();
    const findClaudeStart = (rootPid) => {
      // BFS for a descendant whose command basename is `claude`.
      const queue = [rootPid];
      const seen = new Set();
      while (queue.length) {
        const pid = queue.shift();
        if (seen.has(pid)) continue;
        seen.add(pid);
        const meta = info.get(pid);
        if (meta && CLAUDE_COMM_RE.test(meta.comm)) {
          const sec = parseEtime(meta.etime);
          return sec == null ? null : now - sec * 1000;
        }
        for (const c of children.get(pid) ?? []) queue.push(c);
      }
      return null;
    };

    for (const p of claudePanes) {
      out.set(p.target, p.panePid ? findClaudeStart(p.panePid) : null);
    }
    return out;
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
