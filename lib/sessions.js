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
import { parsePanePrompt } from './prompt.js';
import { assignTranscripts, parseEtime, fingerprintScore, shouldRebind } from './match.js';
import { pinKey } from './pins.js';
import { readPaneRegistry, gcPaneRegistry } from './pane-registry.js';

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
const THINKING_POLL_INTERVAL_MS = 2000; // bottom-5-line capture for the live "thinking" flag

// Self-heal: minimum number of refresh() cycles between consecutive rebinds for
// the same pane. Prevents rapid-fire flapping when borderline scores oscillate.
const SELFHEAL_DEBOUNCE_CYCLES = 5;

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
    recentText: null,
  };

  // Transcript-derived pending: detect an AskUserQuestion that is open in the
  // tail (no matching tool_result) even when no tailer is subscribed. Notifies
  // for ANY session, not just the one a client is watching.
  const pending = detectTranscriptPending(lines);
  base.transcriptPending = pending.transcriptPending;
  base.pendingToolUseId = pending.pendingToolUseId;
  base.pendingQuestion = pending.pendingQuestion;

  // Walk from end collecting the newest cwd/sessionId/timestamp/model/title,
  // and the most recent assistant message texts for the content-fingerprint tiebreak.
  // ai-title is re-emitted throughout the file so the tail usually carries it;
  // custom-title (a user /rename) is written when renamed, so it appears late.
  const recentSnippets = [];
  const MAX_RECENT_SNIPPETS = 3;
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
    // Collect recent assistant text for content-fingerprint tiebreak. Walk
    // text content blocks from the most recent assistant messages backwards.
    if (recentSnippets.length < MAX_RECENT_SNIPPETS && rec.type === 'assistant') {
      const content = rec.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
            recentSnippets.push(block.text.slice(0, 500));
            break; // one text block per message is enough
          }
        }
      }
    }
    if (base.cwd && base.sessionId && base.model && (base.customTitle || base.aiTitle) &&
        recentSnippets.length >= MAX_RECENT_SNIPPETS) {
      break; // everything found
    }
  }
  if (recentSnippets.length > 0) base.recentText = recentSnippets.join(' ');
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

/**
 * List recent transcripts across all project dirs for the manual-pin picker.
 * Takes the newest .jsonl per project dir (bounded), tail-parses each for a
 * title/cwd/sessionId, and returns the most recently active `limit`.
 *
 * @param {{ projectsRoot: string, limit?: number }} opts
 * @returns {Promise<Array<{transcriptPath,title,sessionId,cwd,lastActivity,mtime}>>}
 */
export async function listRecentTranscripts({ projectsRoot, limit = 60 }) {
  let dirs;
  try {
    const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(projectsRoot, e.name));
  } catch {
    return [];
  }

  const out = [];
  await Promise.all(
    dirs.map(async (dir) => {
      const recent = await findRecentJsonl(dir, 1);
      if (!recent.length) return;
      const r = recent[0];
      const rec = await extractTailRecord(r.filePath, r.mtime, r.birthtimeMs);
      if (!rec) return;
      out.push({
        transcriptPath: rec.transcriptPath,
        title: rec.customTitle || rec.aiTitle || null,
        sessionId: rec.sessionId,
        cwd: rec.cwd,
        lastActivity: rec.lastActivity,
        mtime: r.mtime,
      });
    }),
  );

  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
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

    /** @type {Record<string,string>} pin key (windowId.paneIndex) -> transcript path */
    this._pins = {};
    /** @type {Session[]} */
    this._sessions = [];
    /** @type {string|null} — last JSON snapshot for change detection */
    this._lastEmitted = null;
    /** @type {Map<string, boolean>} id -> pending flag */
    this._pendingMap = new Map();
    /** @type {Map<string, {ctxPct:number|null, model:string|null}>} target -> TUI status */
    this._ctxMap = new Map();
    /** @type {Map<string, boolean>} target -> actively-generating flag */
    this._thinkingMap = new Map();
    /** @type {Map<string, {pending:boolean, question:string|null}>} target -> pane-derived prompt */
    this._panePromptMap = new Map();
    /** @type {Map<string, string>} target -> most-recent captured pane text (for fingerprint tiebreak) */
    this._paneTextCache = new Map();
    /** @type {number} monotonically-incrementing refresh() cycle counter */
    this._refreshCycle = 0;
    /** @type {Map<string, number>} target -> refresh cycle on which it was last self-healed */
    this._healLastCycle = new Map();
    /** @type {ReturnType<setInterval>|null} */
    this._interval = null;
    /** @type {ReturnType<setInterval>|null} */
    this._ctxInterval = null;
    /** @type {ReturnType<setInterval>|null} */
    this._thinkingInterval = null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** @returns {Session[]} */
  getSessions() {
    return this._sessions;
  }

  /**
   * Replace the manual pin map (windowId.paneIndex -> transcript path) and
   * re-reconcile so the change shows immediately.
   * @param {Record<string,string>} pins
   */
  setPins(pins) {
    this._pins = pins || {};
    this.refresh().catch(() => {});
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

    // Classify every pane by its process subtree (a `claude` descendant) and get
    // its claude start time in one ps snapshot. Falls back to the cmd heuristic
    // only when ps is unavailable.
    const paneProc = await this._buildPaneProc(panes);
    const isClaudePane = (p) => {
      const info = paneProc.get(p.target);
      return info ? info.isClaude : isClaudeCmd(p.cmd);
    };
    const claudePanes = panes.filter(isClaudePane);

    // The exact pane→transcript map authored by the SessionStart hook. This is
    // the deterministic binding; everything below is fallback for panes with no
    // hook record (sessions started before the hook was installed).
    const paneReg = await readPaneRegistry();
    gcPaneRegistry(new Set(panes.map((p) => p.paneId).filter(Boolean))).catch(() => {});

    // Manual pins win first: a pinned pane is force-bound to its transcript and
    // that transcript is removed from the auto-matcher pool. Pins are keyed by
    // the stable windowId.paneIndex (the target renumbers; the window id doesn't).
    const pinnedByTarget = new Map();
    const pinnedPaths = new Set();
    for (const p of claudePanes) {
      const pinned = this._pins[pinKey(p.windowId, p.paneIndex)];
      if (!pinned) continue;
      const rec = await this._recordForPath(pinned);
      if (rec) {
        pinnedByTarget.set(p.target, rec);
        pinnedPaths.add(rec.transcriptPath);
      }
    }

    // Hook-bound: a pane whose %N is in the registry binds to that EXACT
    // transcript — no guessing. Pinned panes keep their pin.
    const hookByTarget = new Map();
    for (const p of claudePanes) {
      if (pinnedByTarget.has(p.target)) continue;
      const reg = p.paneId ? paneReg.get(p.paneId) : null;
      if (!reg) continue;
      const rec = await this._recordForPath(reg.transcriptPath);
      if (rec) {
        hookByTarget.set(p.target, rec);
        pinnedPaths.add(rec.transcriptPath); // exclude from the auto-matcher pool
      }
    }

    // Auto-match the rest with the deterministic timing matcher (pinned + hook
    // panes and their transcripts excluded so nothing double-binds).
    const autoPanes = claudePanes.filter(
      (p) => !pinnedByTarget.has(p.target) && !hookByTarget.has(p.target),
    );
    const candidatesRaw = await this._buildCandidates(autoPanes);
    const candidates = candidatesRaw.filter((c) => !pinnedPaths.has(c.transcriptPath));
    const assignment = assignTranscripts(
      autoPanes.map((p) => ({
        target: p.target,
        windowName: p.windowName,
        cwd: p.cwd,
        projectDir: encodeCwd(p.cwd), // scope candidates to this pane's own slug dir
        procStartMs: paneProc.get(p.target)?.startMs ?? null,
        // Cached from the last _pollThinking() run — used by the content-fingerprint
        // tiebreak when timing signals cannot distinguish same-cwd candidates.
        capturedText: this._paneTextCache.get(p.target) ?? null,
      })),
      candidates,
    );
    for (const [target, rec] of pinnedByTarget) assignment.set(target, rec);
    for (const [target, rec] of hookByTarget) assignment.set(target, rec);

    // ── Self-heal pass (PLE-44) ───────────────────────────────────────────────
    // Re-verify each MATCHER-bound pane (not pinned, not registry-hooked) against
    // all candidates to catch drift that wasn't caught at initial binding time.
    // Registry-pinned panes are authoritative and are NEVER re-evaluated here.
    this._refreshCycle++;
    for (const p of autoPanes) {
      const target = p.target;
      const currentRec = assignment.get(target);
      if (!currentRec) continue; // unmatched — nothing to heal

      // Debounce: skip panes re-bound too recently to avoid flapping.
      const lastHeal = this._healLastCycle.get(target) ?? -Infinity;
      if (this._refreshCycle - lastHeal < SELFHEAL_DEBOUNCE_CYCLES) continue;

      const paneText = this._paneTextCache.get(target) ?? null;
      if (!paneText) continue; // no captured text yet — cannot score

      const currentScore = fingerprintScore(paneText, currentRec.recentText ?? null);

      // Find the best OTHER candidate in the same pool.
      let bestOtherRec = null;
      let bestOtherScore = 0;
      for (const c of candidates) {
        if (c.transcriptPath === currentRec.transcriptPath) continue;
        const s = fingerprintScore(paneText, c.recentText ?? null);
        if (s > bestOtherScore) {
          bestOtherScore = s;
          bestOtherRec = c;
        }
      }

      if (!bestOtherRec) continue; // no alternative — nothing to heal to
      if (!shouldRebind(currentScore, bestOtherScore)) continue;

      // Re-bind.
      const oldPath = currentRec.transcriptPath;
      assignment.set(target, bestOtherRec);
      this._healLastCycle.set(target, this._refreshCycle);
      console.log(
        `[pane-selfheal] re-bound ${target}: ${oldPath} (score ${currentScore}) → ` +
        `${bestOtherRec.transcriptPath} (score ${bestOtherScore})`,
      );
    }
    // ── End self-heal ─────────────────────────────────────────────────────────

    const sessions = panes.map((win) => {
      const isClaude = isClaudePane(win);
      const transcript = isClaude ? assignment.get(win.target) ?? null : null;
      const isPinned = pinnedByTarget.has(win.target);
      const id = win.target;
      // Pending = subscribed-tailer pending (live modal) OR transcript-derived
      // pending OR pane-derived prompt (a numbered picker on screen — catches
      // questions even when the transcript isn't matched). Works for ANY session.
      const panePrompt = isClaude ? this._panePromptMap.get(id) : null;
      const pending =
        (this._pendingMap.get(id) ?? false) ||
        !!transcript?.transcriptPending ||
        !!panePrompt?.pending;
      const title = transcript?.customTitle || transcript?.aiTitle || null;
      const ctx = isClaude ? this._ctxMap.get(win.target) || {} : {};

      return {
        id,
        sessionId: transcript?.sessionId ?? null,
        // Best label: live TUI/transcript title > tmux window name > target.
        name: title || win.windowName || win.target,
        title,
        tmuxName: win.windowName,
        target: win.target,
        paneId: win.paneId, // stable tmux %N (survives renumber / grouped mirrors)
        sessionName: win.sessionName,
        windowIndex: win.windowIndex,
        paneIndex: win.paneIndex,
        windowId: win.windowId,
        active: win.active,
        cwd: win.cwd,
        transcriptPath: transcript?.transcriptPath ?? null,
        pinned: isPinned,
        lastActivity: transcript?.lastActivity ?? null,
        lastActivityMs: transcript?.lastActivityMs ?? null,
        pending,
        pendingQuestion: transcript?.pendingQuestion ?? panePrompt?.question ?? null,
        cmd: win.cmd,
        isClaude,
        kind: isClaude ? 'claude' : 'terminal',
        ccShell: !!win.ccShell, // a composer >_ sister shell pane

        model: ctx.model || prettyModel(transcript?.model) || null,
        ctxPct: ctx.ctxPct ?? null,
        thinking: isClaude ? this._thinkingMap.get(win.target) ?? false : false,
      };
    });

    // Surface EVERY pane: Claude sessions AND plain terminals (each pane is a row;
    // terminals render a live interactive terminal instead of a transcript).
    this._sessions = sessions;
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

  /**
   * Fast, cheap poll for the live "thinking" flag. Captures only the bottom ~5
   * lines of each Claude pane and updates ONLY the thinking flag — the
   * model/ctx values are left to the slower _pollCtx(). Best-effort.
   */
  async _pollThinking() {
    const sessions = this._sessions;
    await Promise.all(
      sessions.map(async (s) => {
        if (!this._tmux.isValidTarget(s.target)) return;
        try {
          // Capture enough of the bottom to catch BOTH the working line ("esc to
          // interrupt", which can sit several rows above the input box) AND a TUI
          // question picker (parsePanePrompt scans ~18 bottom rows). One capture
          // feeds both — keeping activity detection robust without extra execs.
          const cap = await this._tmux.capturePane(s.target, 26);
          const { thinking } = parseTuiStatus(cap);
          this._thinkingMap.set(s.target, thinking);
          // Cache raw capture text for the content-fingerprint tiebreak in
          // the next refresh() — cheap: already captured here.
          this._paneTextCache.set(s.target, cap);
          s.thinking = thinking;

          // Pane-derived question detection (Claude panes only): an on-screen
          // numbered picker means a question is waiting — even if the transcript
          // isn't matched. This is why some sessions wrongly read as "sleeping".
          if (s.kind === 'claude') {
            const prompt = parsePanePrompt(cap);
            const rec = { pending: !!prompt, question: prompt?.question ?? null };
            this._panePromptMap.set(s.target, rec);
            const merged =
              (this._pendingMap.get(s.target) ?? false) || rec.pending || s.pending;
            s.pending = merged;
            if (rec.pending && !s.pendingQuestion) s.pendingQuestion = rec.question;
          }
        } catch {
          // pane gone / capture failed — leave previous value
        }
      }),
    );
    this._maybeEmit();
  }

  /**
   * Start periodic refresh (every 4 s) + a slower ctx poll + a fast thinking
   * poll, and fire each once.
   */
  start() {
    this.refresh()
      .then(() => Promise.all([this._pollCtx(), this._pollThinking()]))
      .catch(() => {});
    this._interval = setInterval(() => {
      this.refresh().catch(() => {});
    }, REFRESH_INTERVAL_MS);
    this._ctxInterval = setInterval(() => {
      this._pollCtx().catch(() => {});
    }, CTX_POLL_INTERVAL_MS);
    this._thinkingInterval = setInterval(() => {
      this._pollThinking().catch(() => {});
    }, THINKING_POLL_INTERVAL_MS);
    if (this._interval.unref) this._interval.unref();
    if (this._ctxInterval.unref) this._ctxInterval.unref();
    if (this._thinkingInterval.unref) this._thinkingInterval.unref();
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
    if (this._thinkingInterval) {
      clearInterval(this._thinkingInterval);
      this._thinkingInterval = null;
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
  /**
   * Build a transcript record for an exact path (for manual pins). Stats the
   * file for mtime/birthtime, then tail-parses it. Null if unreadable.
   * @param {string} filePath
   * @returns {Promise<object|null>}
   */
  async _recordForPath(filePath) {
    try {
      const st = await fs.stat(filePath);
      return await extractTailRecord(filePath, st.mtimeMs, st.birthtimeMs);
    } catch {
      return null;
    }
  }

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
        // Tag each candidate with the project-dir slug it was found in, so the
        // matcher scopes it to panes whose cwd produces the SAME slug (prevents a
        // parent-dir pane stealing a child worktree's transcript).
        for (const rec of recs) if (rec) candidates.push({ ...rec, projectDir: name });
      }),
    );

    return candidates;
  }

  /**
   * Classify each pane and resolve its claude-process start time in ONE `ps`
   * snapshot. A pane is a Claude session iff its process subtree (from the pane
   * shell pid) contains a `claude` descendant — far more reliable than the
   * `pane_current_command` version-regex, which flips to `node`/`git` while
   * Claude runs a tool. The same walk yields the claude start time (ms epoch)
   * for the start-time matching fallback.
   *
   * Best-effort: if `ps` is unavailable every pane maps to {isClaude:false,
   * startMs:null} and callers fall back to the cmd heuristic / other passes.
   *
   * @param {import('./tmux.js').Window[]} allPanes
   * @returns {Promise<Map<string, {isClaude: boolean, startMs: number|null}>>} target -> info
   */
  async _buildPaneProc(allPanes) {
    const out = new Map();
    if (allPanes.length === 0) return out;

    let rows;
    try {
      const { stdout } = await execFile(
        'ps',
        ['-axo', 'pid=,ppid=,etime=,comm='],
        { timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
      );
      rows = stdout.split('\n');
    } catch {
      return out; // ps unavailable — callers fall back
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
    // BFS from the pane shell pid for a `claude` descendant; return its start.
    const findClaude = (rootPid) => {
      const queue = [rootPid];
      const seen = new Set();
      while (queue.length) {
        const pid = queue.shift();
        if (seen.has(pid)) continue;
        seen.add(pid);
        const meta = info.get(pid);
        if (meta && CLAUDE_COMM_RE.test(meta.comm)) {
          const sec = parseEtime(meta.etime);
          return { isClaude: true, startMs: sec == null ? null : now - sec * 1000 };
        }
        for (const c of children.get(pid) ?? []) queue.push(c);
      }
      return { isClaude: false, startMs: null };
    };

    for (const p of allPanes) {
      out.set(p.target, p.panePid ? findClaude(p.panePid) : { isClaude: false, startMs: null });
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
