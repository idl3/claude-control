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
import { watch as fsWatch } from 'node:fs';
import path from 'node:path';
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { parseTuiStatus, prettyModel } from './tui.js';
import { parsePanePrompt, isSystemPrompt } from './prompt.js';
import { assignTranscripts, parseEtime, fingerprintScore, shouldRebind } from './match.js';
import { pinKey } from './pins.js';
import { readPaneRegistry, gcPaneRegistry } from './pane-registry.js';
import {
  matchesProcess as codexMatchesProcess,
  processMatchKind as codexProcessMatchKind,
  buildTranscriptIndex as buildCodexIndex,
  readCodexTranscriptRecord,
  parseTuiStatus as parseCodexTuiStatus,
  parseCodexPrompt,
  findOpenRollout,
  readRolloutMeta,
} from './codex.js';
import { hasActiveSubAgents } from './subagents.js';
import { normalizeRoots } from './projects-roots.js';

const execFile = promisify(_execFile);

// Matches Claude Code's executable basename (e.g. /Users/x/.local/bin/claude).
const CLAUDE_COMM_RE = /(^|\/)claude$/;
// Matches Codex CLI executable basename.
const CODEX_COMM_RE = /(^|\/)codex$/;
const CLAUDE_ARG_RE = /(^|[\s/])claude(?:\s|$)/;
// A Claude session id is a UUID (8-4-4-4-12 hex). Used to pull the resumed
// session's id out of a process's argv (bare, or embedded in a jsonl path).
const RESUME_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Extract the resumed session's UUID from a Claude process's argv string.
 *
 * A pane launched to resume a session carries the target in its args. Observed
 * real forms (claude-code 2.x, from `ps -o args=`):
 *   claude --resume <uuid>
 *   claude -r <uuid>
 *   claude --resume=<uuid>
 *   claude --resume /abs/path/<uuid>.jsonl      (daemon / bg-pty-host form)
 *   claude --resume <branch-or-custom-label>    (NOT a uuid → no id)
 *   claude --continue                           (most-recent, no id)
 *   claude                                      (fresh session, no id)
 *
 * Returning the uuid lets the matcher bind the pane straight to <uuid>.jsonl,
 * bypassing the mtime-based temporal guard that would otherwise reject a
 * resumed-but-idle transcript (old mtime). Returns null when:
 *   - no --resume/-r flag is present (fresh / --continue / -c),
 *   - the resume value carries no uuid (interactive picker or a custom label), or
 *   - --fork-session is present: a forked resume writes a NEW session id, so the
 *     value names the PARENT, not this pane's live transcript — let the normal
 *     recency matcher bind the freshly-created fork instead.
 *
 * @param {string|null|undefined} args  full argv string (from `ps -o args=`)
 * @returns {string|null} lowercased session UUID, or null
 */
export function resumeSessionIdFromArgs(args) {
  const s = String(args || '');
  if (!s) return null;
  if (/(?:^|\s)--fork-session(?:[\s=]|$)/.test(s)) return null;
  const m = /(?:^|\s)(?:--resume|-r)[=\s]+(\S+)/.exec(s);
  if (!m) return null;
  // The value may be a bare uuid, a path to <uuid>.jsonl, or a non-uuid label.
  // Pull the uuid from wherever it sits; a label yields none → normal matcher.
  const u = RESUME_UUID_RE.exec(m[1]);
  return u ? u[0].toLowerCase() : null;
}
const LOCAL_WS_RE = /\bws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|::1):\d+\b/;

function isCodexAppServerArgs(args) {
  const s = String(args || '');
  return /\bapp-server\b/.test(s) && /(?:^|\s)--listen(?:[=\s]|$)/.test(s);
}

function codexAppServerEndpointFromArgs(args) {
  const m = LOCAL_WS_RE.exec(String(args || ''));
  return m ? m[0] : null;
}

// A pane is a Claude Code session when its process title is the Claude version
// (e.g. "2.1.162") — shells report zsh/bash/etc. A linked transcript also counts.
function isClaudeCmd(cmd) {
  return /^\d+\.\d+(\.\d+)?$/.test(String(cmd || '').trim());
}

const TAIL_BYTES = 64 * 1024; // 64 KB initial tail read
const MAX_TAIL_BYTES = 1024 * 1024; // 1 MB ceiling — ensures a single oversized AskUserQuestion record is never split at the front
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

// macOS TCC "Operation not permitted" — a pane that can't read protected dirs
// (~/Documents etc.) because the launchd service lacks Full Disk Access.
const PERM_DENIED_RE = /\boperation not permitted\b/i;

/** True when a pane capture shows the macOS Full-Disk-Access denial. */
export function paneHasPermIssue(capture) {
  return PERM_DENIED_RE.test(String(capture || ''));
}

// A pane is scraped (capture-pane) by the 2 s thinking poll only while it's
// "live"; idle backgrounded panes are skipped to cut needless tmux execs. A pane
// stays live for this long after its transcript last changed.
const ACTIVE_SCRAPE_WINDOW_MS = 20_000;

/**
 * Should the 2 s thinking poll scrape this pane? True when:
 *  - it carries a live flag (thinking/compacting/pending/errored) — keep polling
 *    until it settles/clears, OR
 *  - it has no transcript to gate on (can't tell; scrape to be safe), OR
 *  - its transcript changed recently — via fs.watch (`activeUntilMs`) or the 4 s
 *    tail read (`lastActivityMs`) as a backstop.
 * Otherwise it's idle → skip the capture.
 *
 * @param {{thinking?:boolean,compacting?:boolean,pending?:boolean,errored?:boolean,transcriptPath?:string|null,lastActivityMs?:number|null}} s
 * @param {number} activeUntilMs  fs.watch-fed "active until" timestamp for this transcript (0 if none)
 * @param {number} now
 * @param {number} windowMs
 * @returns {boolean}
 */
export function shouldScrapePane(s, activeUntilMs, now, windowMs = ACTIVE_SCRAPE_WINDOW_MS) {
  if (s.thinking || s.compacting || s.pending || s.errored) return true;
  if (!s.transcriptPath) return true;
  if (activeUntilMs && now < activeUntilMs) return true;
  if (s.lastActivityMs && now - s.lastActivityMs < windowMs) return true;
  return false;
}

function codexRecordToCandidate(rec) {
  return {
    transcriptPath: rec.transcriptPath,
    cwd: rec.cwd,
    projectDir: null, // triggers isCwdConsistent scope fallback in match.js
    birthtimeMs: rec.mtime,
    mtimeMs: rec.mtime,
    lastActivityMs: rec.lastActivityMs ?? rec.mtime,
    customTitle: rec.customTitle,
    aiTitle: rec.aiTitle,
    recentText: null,
    // Pass through for later session assembly
    sessionId: rec.sessionId,
    lastActivity: rec.lastActivity,
    model: rec.model,
    transcriptPending: rec.transcriptPending,
    pendingToolUseId: rec.pendingToolUseId,
    pendingQuestion: rec.pendingQuestion,
    agentType: rec.agentType,
    usagePct: rec.usagePct ?? null,
    usageWindowMin: rec.usageWindowMin ?? null,
    mtime: rec.mtime,
  };
}

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
export async function extractTailRecord(filePath, mtime, birthtime = null) {
  let buf = await readTail(filePath, TAIL_BYTES);
  if (!buf) return null;

  // If the file is larger than TAIL_BYTES, the read started mid-file, so the
  // first line of the buffer is almost certainly partial (truncated at the
  // front). A single large AskUserQuestion record (>64 KB) can have its
  // opening `{"type":"assistant"...tool_use...` in that discarded partial
  // line, causing detectTranscriptPending to miss the open question entirely.
  // Re-reading up to MAX_TAIL_BYTES guarantees any single record ≤ 1 MB is
  // captured whole at the front of the buffer.
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > TAIL_BYTES) {
      const larger = await readTail(filePath, Math.min(stat.size, MAX_TAIL_BYTES));
      if (larger) buf = larger;
    }
  } catch {
    // stat failed — proceed with the initial 64 KB buffer
  }

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

// ---------------------------------------------------------------------------
// Fork-lineage resolution — follow a superseded transcript to its live fork
// ---------------------------------------------------------------------------
//
// `claude --resume` / `--fork-session` starts a NEW sessionId writing a NEW
// jsonl in the same project dir that copies the ancestor's records (uuids
// preserved) and continues from its leaf. The ancestor file stops growing, so
// a pane binding pinned to it freezes while the live pane moves on. A jsonl
// that contains the recorded transcript's last message-chain uuid is a strict
// descendant (it copied the entire recorded history) — rebinding to it follows
// the fork. An ancestor that keeps appending after being forked grows a new
// leaf the fork does not contain, so live divergent siblings are never stolen.

const FORK_SCAN_MAX_CANDIDATES = 8;
const FORK_SCAN_MAX_HOPS = 5;
// A fork copies its history when the session starts; once a candidate is older
// than this, a "does not contain uuid" verdict is permanent and cacheable.
const FORK_VERDICT_SETTLE_MS = 60_000;
/** @type {Map<string, boolean>} `${candidatePath}\0${uuid}` -> contains verdict */
const forkVerdictCache = new Map();

/** Exported FOR TESTS ONLY — clears the fork containment verdict cache. */
export function _resetForkCacheForTest() {
  forkVerdictCache.clear();
}

/**
 * Last user/assistant record uuid in a transcript's tail — the message-chain
 * leaf a fork copies. Null when the tail has no chain records (e.g. Codex
 * rollouts, which use a different schema — resolution then no-ops).
 *
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
export async function lastChainUuid(filePath) {
  const buf = await readTail(filePath, TAIL_BYTES);
  if (!buf) return null;
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if ((rec?.type === 'user' || rec?.type === 'assistant') && typeof rec.uuid === 'string') {
      return rec.uuid;
    }
  }
  return null;
}

async function candidateContainsUuid(filePath, uuid, birthtimeMs) {
  const key = `${filePath}\0${uuid}`;
  const cached = forkVerdictCache.get(key);
  if (cached !== undefined) return cached;
  let verdict;
  try {
    // ponytail: whole-file read per (file, uuid), verdict cached; stream if transcripts outgrow memory
    verdict = (await fs.readFile(filePath, 'utf8')).includes(uuid);
  } catch {
    return false; // unreadable now — retry next refresh, don't cache
  }
  const settled = verdict || Date.now() - (birthtimeMs ?? 0) > FORK_VERDICT_SETTLE_MS;
  if (settled) {
    if (forkVerdictCache.size > 500) forkVerdictCache.clear();
    forkVerdictCache.set(key, verdict);
  }
  return verdict;
}

/**
 * Resolve a transcript path to its newest fork descendant in the same project
 * dir (or itself when it has none). Bounded hops guard against cycles.
 *
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function resolveForkDescendant(filePath) {
  let current = filePath;
  for (let hop = 0; hop < FORK_SCAN_MAX_HOPS; hop++) {
    const leaf = await lastChainUuid(current);
    if (!leaf) return current;
    const recent = await findRecentJsonl(path.dirname(current), FORK_SCAN_MAX_CANDIDATES);
    let next = null;
    for (const cand of recent) { // newest mtime first
      if (cand.filePath === current) continue;
      if (await candidateContainsUuid(cand.filePath, leaf, cand.birthtimeMs)) {
        next = cand.filePath;
        break;
      }
    }
    if (!next) return current;
    current = next;
  }
  return current;
}

/**
 * List recent transcripts across all project dirs for the manual-pin picker.
 * Takes the newest .jsonl per project dir (bounded), tail-parses each for a
 * title/cwd/sessionId, and returns the most recently active `limit`.
 *
 * @param {{ projectsRoot?: string, projectsRoots?: string[], limit?: number }} opts
 * @returns {Promise<Array<{transcriptPath,title,sessionId,cwd,lastActivity,mtime}>>}
 */
export async function listRecentTranscripts({ projectsRoot, projectsRoots, limit = 60 }) {
  const roots = normalizeRoots(projectsRoots, projectsRoot);
  const dirs = [];
  for (const root of roots) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const e of entries) if (e.isDirectory()) dirs.push(path.join(root, e.name));
    } catch {
      /* unreadable root — skip */
    }
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
   * @param {{ projectsRoot: string, projectsRoots?: string[], codexSessionsRoot?: string, tmux: object, debounceMs?: number }} opts
   */
  constructor({ projectsRoot, projectsRoots, codexSessionsRoot, tmux, debounceMs = 1000 } = {}) {
    super();
    this._projectsRoots = normalizeRoots(projectsRoots, projectsRoot);
    this._codexSessionsRoot = codexSessionsRoot;
    this._tmux = tmux;
    this._debounceMs = debounceMs;

    /** @type {Record<string,string>} pin key (windowId.paneIndex) -> transcript path */
    this._pins = {};
    /** @type {Session[]} */
    this._sessions = [];
    /** @type {Session[]} — remote (olam) rows, owned by lib/olam-sessions.js */
    this._remoteSessions = [];
    /** @type {string|null} — last JSON snapshot for change detection */
    this._lastEmitted = null;
    /** @type {Map<string, boolean>} id -> pending flag */
    this._pendingMap = new Map();
    /** @type {Map<string, {ctxPct:number|null, model:string|null}>} target -> TUI status */
    this._ctxMap = new Map();
    /** @type {Map<string, boolean>} target -> actively-generating flag */
    this._thinkingMap = new Map();
    /** @type {Map<string, boolean>} target -> compacting-conversation flag */
    this._compactingMap = new Map();
    /** @type {Map<string, boolean>} target -> API-error/stall flag */
    this._erroredMap = new Map();
    /** @type {Map<string, boolean>} target -> macOS TCC "operation not permitted" */
    this._permIssueMap = new Map();
    /** @type {Map<string, number>} transcriptPath -> "scrape until" ts (fs.watch-fed) */
    this._activeUntil = new Map();
    /** @type {Map<string, import('node:fs').FSWatcher>} transcriptPath -> watcher */
    this._transcriptWatchers = new Map();
    /** @type {Map<string, boolean>} target -> has a sub-agent actively running */
    this._subAgentActiveMap = new Map();
    /** @type {Map<string, {pending:boolean, question:string|null}>} target -> pane-derived prompt */
    this._panePromptMap = new Map();
    /** @type {Map<string, {transcriptPath:string, sessionId?:string|null}>} target -> exact Codex rollout hint */
    this._transcriptHintMap = new Map();
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

    // Re-entrancy guards: skip a tick if the previous one is still in flight.
    // Each flag is owned exclusively by its worker; reset in finally() so a
    // rejected shellout cannot wedge the flag permanently.
    /** @type {boolean} */
    this._refreshing = false;
    /** @type {boolean} */
    this._pollingCtx = false;
    /** @type {boolean} */
    this._pollingThinking = false;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** @returns {Session[]} */
  getSessions() {
    return this._sessions;
  }

  /**
   * Replace the remote (olam) session rows. Local tmux discovery is untouched:
   * remote rows are concatenated after the tmux-derived set on every refresh
   * and on every call here. Rows are Session-shaped with kind:'remote' and
   * transport:'olam' (docs/plans/cockpit-olam-remote-sessions).
   *
   * @param {Session[]} rows
   */
  setRemoteSessions(rows) {
    this._remoteSessions = Array.isArray(rows) ? rows : [];
    this._sessions = this._sessions
      .filter((s) => s.kind !== 'remote')
      .concat(this._remoteSessions);
    this._maybeEmit();
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
    this._pendingMap.set(id, !!pending);
    if (!session) return;
    const panePrompt = this._panePromptMap.get(id) ?? null;
    const was = session.pending;
    session.pending = !!pending || !!panePrompt?.pending;
    if (was !== session.pending) {
      this._maybeEmit();
    }
  }

  /**
   * Set a structured prompt surfaced by a non-transcript transport such as
   * Codex app-server. Pane-scraped Claude prompts still flow through _pollThinking().
   *
   * @param {string} id
   * @param {{question?: string|null}|null} prompt
   */
  setPrompt(id, prompt) {
    const rec = { pending: !!prompt, question: prompt?.question ?? null };
    if (rec.pending) this._panePromptMap.set(id, rec);
    else this._panePromptMap.delete(id);

    const session = this._sessions.find((s) => s.id === id);
    if (!session) return;
    const wasPending = session.pending;
    const wasQuestion = session.pendingQuestion ?? null;
    session.pending = (this._pendingMap.get(id) ?? false) || rec.pending;
    session.pendingQuestion = rec.question;
    if (wasPending !== session.pending || wasQuestion !== session.pendingQuestion) {
      this._maybeEmit();
    }
  }

  /**
   * Set active-generation state from a structured transport.
   *
   * @param {string} id
   * @param {boolean} thinking
   */
  setThinking(id, thinking) {
    const session = this._sessions.find((s) => s.id === id);
    const next = !!thinking;
    this._thinkingMap.set(id, next);
    if (!session) return;
    const was = session.thinking;
    session.thinking = next;
    if (was !== next) {
      this._maybeEmit();
    }
  }

  /**
   * Bind a pane target to an exact transcript path discovered from a structured
   * transport (currently Codex app-server's thread.path). This is authoritative
   * for that target and avoids cwd/time ambiguity.
   *
   * @param {string} id
   * @param {{transcriptPath?: string|null, sessionId?: string|null}|null} hint
   */
  setTranscriptHint(id, hint) {
    if (!hint?.transcriptPath) this._transcriptHintMap.delete(id);
    else this._transcriptHintMap.set(id, {
      transcriptPath: hint.transcriptPath,
      sessionId: hint.sessionId ?? null,
    });
    this.refresh().catch(() => {});
  }

  /**
   * Rescan tmux windows and project directories. Returns the new session list.
   *
   * @returns {Promise<Session[]>}
   */
  async refresh() {
    if (this._refreshing) return;
    this._refreshing = true;
    try {
      return await this._doRefresh();
    } finally {
      this._refreshing = false;
    }
  }

  /** @private — the actual refresh body; called only when not already in flight. */
  async _doRefresh() {
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

    // Classify every pane by its process subtree (a `claude` or `codex` descendant)
    // and get its start time in one ps snapshot. Falls back to the cmd heuristic
    // only when ps is unavailable.
    const paneProc = await this._buildPaneProc(panes);
    const isClaudePane = (p) => {
      if (p.ccAgent === 'claude') return true;
      const info = paneProc.get(p.target);
      return info ? info.isClaude : isClaudeCmd(p.cmd);
    };
    const paneKind = (p) => {
      if (p.ccAgent === 'claude') return 'claude';
      if (p.ccAgent === 'codex') return 'codex';
      const info = paneProc.get(p.target);
      if (info?.kind) return info.kind;
      if (isClaudeCmd(p.cmd)) return 'claude';
      if (codexMatchesProcess(p.cmd)) return 'codex';
      return 'terminal';
    };
    const claudePanes = panes.filter(isClaudePane);

    // The exact pane→transcript map authored by the SessionStart hook. This is
    // the deterministic binding; everything below is fallback for panes with no
    // hook record (sessions started before the hook was installed).
    const paneReg = await readPaneRegistry();
    gcPaneRegistry().catch(() => {}); // prunes only pins whose transcript is gone

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
      const hint = this._transcriptHintMap.get(p.target) || reg;
      if (!hint) continue;
      const rec = await this._recordForPath(hint.transcriptPath);
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
        // Resume-id (from `claude --resume <uuid>` args) — binds a resumed-but-
        // idle transcript directly by session id, bypassing the mtime temporal
        // guard that would otherwise reject its stale mtime (resume-idle fix).
        resumeSessionId: paneProc.get(p.target)?.resumeSessionId ?? null,
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

    // ── Codex pane → transcript matching ────────────────────────────────────
    // Discover Codex session transcripts and match them to Codex panes.
    // The Claude assignment above is computed first and left untouched;
    // codex results are merged in after.
    //
    // Binding strategy (authoritative → heuristic):
    //   1. lsof: the live codex process holds its rollout file OPEN — lsof on
    //      its pid gives the exact path. Zero-ambiguity; self-heals on resume.
    //   2. cwd + mtime heuristic (assignTranscripts): fallback for panes whose
    //      pid is unknown or whose lsof call failed.
    const codexPanes = panes.filter((p) => paneKind(p) === 'codex');
    if (codexPanes.length > 0) {
      // --- Phase 1: exact binding via RPC hints, pane registry, then lsof -------
      const exactByTarget = new Map();
      const exactPaths = new Set();
      const appServerTargets = new Set();
      await Promise.all(
        codexPanes.map(async (p) => {
          try {
            const procInfo = paneProc.get(p.target);
            if (procInfo?.appServer || procInfo?.appServerEndpoint) appServerTargets.add(p.target);

            const runtimeHint = this._transcriptHintMap.get(p.target);
            if (runtimeHint?.transcriptPath) {
              const rec = await readCodexTranscriptRecord(runtimeHint.transcriptPath);
              if (rec && isCwdConsistent(rec.cwd, p.cwd)) {
                exactByTarget.set(p.target, codexRecordToCandidate({
                  ...rec,
                  sessionId: rec.sessionId ?? runtimeHint.sessionId ?? null,
                }));
                exactPaths.add(rec.transcriptPath);
                return;
              }
            }

            const reg = p.paneId ? paneReg.get(p.paneId) : null;
            const codexPid = procInfo?.pid ?? null;
            if (appServerTargets.has(p.target)) {
              // App-server processes may hold multiple rollout files for
              // multiple RPC threads. Only runtime/pane-registry hints are
              // authoritative enough to bind one back to this tmux pane.
              if (reg?.transcriptPath) {
                const rec = await readCodexTranscriptRecord(reg.transcriptPath);
                if (rec && isCwdConsistent(rec.cwd, p.cwd)) {
                  exactByTarget.set(p.target, codexRecordToCandidate({
                    ...rec,
                    sessionId: rec.sessionId ?? reg.sessionId ?? null,
                  }));
                  exactPaths.add(rec.transcriptPath);
                }
              }
              return;
            }
            if (!codexPid) {
              if (reg?.transcriptPath) {
                const rec = await readCodexTranscriptRecord(reg.transcriptPath);
                if (rec && isCwdConsistent(rec.cwd, p.cwd)) {
                  exactByTarget.set(p.target, codexRecordToCandidate({
                    ...rec,
                    sessionId: rec.sessionId ?? reg.sessionId ?? null,
                  }));
                  exactPaths.add(rec.transcriptPath);
                }
              }
              return;
            }
            const rolloutPath = await findOpenRollout(codexPid);
            if (!rolloutPath || exactPaths.has(rolloutPath)) {
              if (reg?.transcriptPath) {
                const rec = await readCodexTranscriptRecord(reg.transcriptPath);
                if (rec && isCwdConsistent(rec.cwd, p.cwd)) {
                  exactByTarget.set(p.target, codexRecordToCandidate({
                    ...rec,
                    sessionId: rec.sessionId ?? reg.sessionId ?? null,
                  }));
                  exactPaths.add(rec.transcriptPath);
                }
              }
              return;
            }
            const rec = await readCodexTranscriptRecord(rolloutPath);
            if (!rec) return;
            if (!isCwdConsistent(rec.cwd, p.cwd)) {
              return;
            }
            exactByTarget.set(p.target, codexRecordToCandidate(rec));
            exactPaths.add(rec.transcriptPath);
          } catch {
            // exact lookup failed; heuristic fallback below can still bind it
          }
        }),
      );

      // --- Phase 2: heuristic fallback for unresolved panes ------------------
      const unresolved = codexPanes.filter((p) =>
        !exactByTarget.has(p.target) && !appServerTargets.has(p.target),
      );
      if (unresolved.length > 0) {
        const codexIndex = await buildCodexIndex({ codexSessionsRoot: this._codexSessionsRoot });
        const codexCandidates = [];
        // Use every active rollout, not only the newest per cwd. Legacy TUI and
        // RPC app-server panes often share one cwd; collapsing by cwd can leave
        // the older still-live pane with no fallback candidate.
        for (const rec of codexIndex.byPath.values()) {
          if (!exactPaths.has(rec.transcriptPath)) {
            codexCandidates.push(codexRecordToCandidate(rec));
          }
        }
        const codexPaneInputs = unresolved.map((p) => ({
          target: p.target,
          windowName: p.windowName,
          cwd: p.cwd,
          projectDir: null,
          procStartMs: paneProc.get(p.target)?.startMs ?? null,
          capturedText: this._paneTextCache.get(p.target) ?? null,
        }));
        const codexAssignment = assignTranscripts(codexPaneInputs, codexCandidates);
        for (const [t, rec] of codexAssignment) assignment.set(t, rec);
      }
      for (const [t, rec] of exactByTarget) assignment.set(t, rec);
    }
    // ── End Codex matching ───────────────────────────────────────────────────

    const sessions = panes.map((win) => {
      const isClaude = isClaudePane(win);
      const kind = paneKind(win);
      const hasTranscript = kind === 'claude' || kind === 'codex';
      const transcript = hasTranscript ? assignment.get(win.target) ?? null : null;
      const isPinned = pinnedByTarget.has(win.target);
      const id = win.target;
      // Pending = subscribed-tailer pending (live modal) OR transcript-derived
      // pending OR pane-derived prompt (a numbered picker on screen — catches
      // questions even when the transcript isn't matched). Works for ANY session.
      const panePrompt = this._panePromptMap.get(id) ?? null;
      const pending =
        (this._pendingMap.get(id) ?? false) ||
        !!transcript?.transcriptPending ||
        !!panePrompt?.pending;
      const title = transcript?.customTitle || transcript?.aiTitle || null;
      // Read the polled TUI status (model/ctx) for Claude AND Codex. Codex's
      // _pollCtx populates _ctxMap with its model (ctxPct stays null — Codex's
      // TUI has no context %). Without this, the assembly would discard the
      // polled codex model and the rail would show no model for codex rows.
      const ctx = isClaude || kind === 'codex' ? this._ctxMap.get(win.target) || {} : {};

      const procInfo = paneProc.get(win.target);
      const codexAppServer = kind === 'codex' && (!!procInfo?.appServer || !!procInfo?.appServerEndpoint);
      const transport = kind === 'claude'
        ? (win.ccTransport || 'tmux')
        : kind === 'codex'
          ? (codexAppServer ? 'rpc' : (win.ccTransport || 'tmux'))
          : null;
      const endpoint = kind === 'codex'
        ? (win.ccEndpoint || procInfo?.appServerEndpoint || null)
        : (win.ccEndpoint || null);

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
        kind,
        transport,
        endpoint,
        ccShell: !!win.ccShell, // a composer >_ sister shell pane

        model: ctx.model || prettyModel(transcript?.model) || null,
        ctxPct: ctx.ctxPct ?? null,
        thinking: (isClaude || kind === 'codex') ? this._thinkingMap.get(win.target) ?? false : false,
        compacting: (isClaude || kind === 'codex') ? this._compactingMap.get(win.target) ?? false : false,
        errored: (isClaude || kind === 'codex') ? this._erroredMap.get(win.target) ?? false : false,
        permIssue: this._permIssueMap.get(win.target) ?? false,
        subAgentActive: isClaude ? this._subAgentActiveMap.get(win.target) ?? false : false,
        usagePct: transcript?.usagePct ?? null,
        usageWindowMin: transcript?.usageWindowMin ?? null,
      };
    });

    // Surface EVERY pane: Claude sessions AND plain terminals (each pane is a row;
    // terminals render a live interactive terminal instead of a transcript).
    this._sessions = sessions.concat(this._remoteSessions);
    this._syncTranscriptWatchers();
    this._maybeEmit();
    return this._sessions;
  }

  /**
   * Keep one fs.watch per live transcript so a change instantly marks that pane
   * "active" (scrape-worthy) for the next thinking poll — replacing blanket 2 s
   * scraping of idle panes. Best-effort: a watch that fails to attach just means
   * that pane falls back to the lastActivityMs backstop in shouldScrapePane.
   */
  _syncTranscriptWatchers() {
    const wanted = new Set();
    for (const s of this._sessions) {
      if (s.transcriptPath) wanted.add(s.transcriptPath);
    }
    // Add watchers for new transcripts; seed them active so a freshly-appeared
    // session is scraped right away, then settles into the gated cadence.
    for (const p of wanted) {
      if (this._transcriptWatchers.has(p)) continue;
      try {
        const w = fsWatch(p, { persistent: false }, () => {
          this._activeUntil.set(p, Date.now() + ACTIVE_SCRAPE_WINDOW_MS);
        });
        w.on('error', () => {}); // ignore — backstop covers it
        this._transcriptWatchers.set(p, w);
        this._activeUntil.set(p, Date.now() + ACTIVE_SCRAPE_WINDOW_MS);
      } catch {
        /* unwatchable (gone / FD limit) — lastActivityMs backstop handles it */
      }
    }
    // Drop watchers for transcripts no longer present.
    for (const [p, w] of this._transcriptWatchers) {
      if (wanted.has(p)) continue;
      try { w.close(); } catch { /* ignore */ }
      this._transcriptWatchers.delete(p);
      this._activeUntil.delete(p);
    }
  }

  /**
   * Capture each Claude pane's TUI status line and parse model + context %.
   * Throttled (separate from the 4 s refresh) and best-effort — capture-pane is
   * cheap but we keep it off the hot path per the resource doctrine.
   */
  async _pollCtx() {
    if (this._pollingCtx) return;
    this._pollingCtx = true;
    try {
    const sessions = this._sessions;
    await Promise.all(
      sessions.map(async (s) => {
        if (!this._tmux.isValidTarget(s.target)) return;
        try {
          if (s.transport === 'print') return;
          const cap = await this._tmux.capturePane(s.target, 8);
          // Codex panes use the codex header/footer parser (the Claude tui.js
          // parser doesn't match codex's "model:"/footer formats). Codex has no
          // ctx% in its TUI, so ctxPct stays null for codex (no faked value).
          const { ctxPct, model } =
            s.kind === 'codex' ? parseCodexTuiStatus(cap) : parseTuiStatus(cap);
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
    } finally {
      this._pollingCtx = false;
    }
  }

  /**
   * Fast, cheap poll for the live "thinking" flag. Captures only the bottom ~5
   * lines of each Claude pane and updates ONLY the thinking flag — the
   * model/ctx values are left to the slower _pollCtx(). Best-effort.
   */
  async _pollThinking() {
    if (this._pollingThinking) return;
    this._pollingThinking = true;
    try {
    const sessions = this._sessions;
    await Promise.all(
      sessions.map(async (s) => {
        if (!this._tmux.isValidTarget(s.target)) return;
        try {
          if (s.transport === 'print') return;
          // Skip idle backgrounded panes — only scrape while the pane is live
          // (flagged) or its transcript changed recently. Cuts capture-pane execs
          // for sleeping sessions; active/pending/errored panes keep updating.
          const activeUntil = s.transcriptPath ? this._activeUntil.get(s.transcriptPath) ?? 0 : 0;
          if (!shouldScrapePane(s, activeUntil, Date.now(), ACTIVE_SCRAPE_WINDOW_MS)) return;
          // Capture the VISIBLE pane only (no scrollback). One capture feeds the
          // working line ("esc to interrupt"), the TUI question picker
          // (parsePanePrompt), and the codex prompt parse. Scrollback MUST be
          // excluded: a `-S -N` window pulls in an already-answered picker frozen
          // in history (still showing its ❯ cursor + "esc to cancel" footer),
          // which re-fires the prompt after it was answered and lets stray
          // numbered prose look like a live menu. The live picker is always on
          // the visible screen, so visible-only is both sufficient and accurate.
          const cap = await this._tmux.capturePane(s.target, 26, false, false, { visibleOnly: true });
          const { thinking, compacting, errored } = parseTuiStatus(cap);
          this._erroredMap.set(s.target, errored);
          s.errored = errored;
          // macOS TCC denial: a pane spawned by the launchd service (no Full Disk
          // Access) gets "Operation not permitted" reading ~/Documents etc. Flag
          // it so the UI can point the user at the FDA fix instead of looking
          // silently broken. Works for any pane kind (shells hit it too).
          const permIssue = paneHasPermIssue(cap);
          this._permIssueMap.set(s.target, permIssue);
          s.permIssue = permIssue;
          this._thinkingMap.set(s.target, thinking);
          this._compactingMap.set(s.target, compacting);
          // Cache raw capture text for the content-fingerprint tiebreak in
          // the next refresh() — cheap: already captured here.
          this._paneTextCache.set(s.target, cap);
          s.thinking = thinking;
          s.compacting = compacting;

          // Sub-agent activity (Claude only) — scan the session's subagents dir so
          // the rail's "cloning" state lights for EVERY window, not just the one a
          // client subscribed to (the SubAgentsWatcher is subscription-scoped).
          if (s.kind === 'claude') {
            const subActive = hasActiveSubAgents(s.transcriptPath);
            this._subAgentActiveMap.set(s.target, subActive);
            s.subAgentActive = subActive;
          }

          // Pane-derived question detection (Claude panes only): an on-screen
          // numbered picker means a question is waiting — even if the transcript
          // isn't matched. This is why some sessions wrongly read as "sleeping".
          if (s.kind === 'claude') {
            // Only a RECOGNIZED system prompt (permission/trust/plan) counts from
            // the scrape; custom agent/skill pickers don't light the ASK badge.
            // Real AskUserQuestion still flows via the transcript (_pendingMap).
            const parsed = parsePanePrompt(cap);
            const prompt = isSystemPrompt(parsed) ? parsed : null;
            const rec = { pending: !!prompt, question: prompt?.question ?? null };
            this._panePromptMap.set(s.target, rec);
            const merged =
              (this._pendingMap.get(s.target) ?? false) || rec.pending || s.pending;
            s.pending = merged;
            if (rec.pending && !s.pendingQuestion) s.pendingQuestion = rec.question;
          } else if (s.kind === 'codex') {
            // Pane-derived question detection for Codex panes: parseCodexPrompt
            // detects approval modals and planning questions on screen. Feeds the
            // same _panePromptMap so refresh() can surface the ASK sidebar icon.
            const prompt = parseCodexPrompt(cap);
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
    } finally {
      this._pollingThinking = false;
    }
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
    for (const w of this._transcriptWatchers.values()) {
      try { w.close(); } catch { /* ignore */ }
    }
    this._transcriptWatchers.clear();
    this._activeUntil.clear();
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
      // A resume/fork supersedes the recorded jsonl with a new one the
      // SessionStart hook may never see (daemon-spawned forks have no
      // $TMUX_PANE) — follow the lineage so the binding tracks the live file.
      const resolved = await resolveForkDescendant(filePath);
      const st = await fs.stat(resolved);
      return await extractTailRecord(resolved, st.mtimeMs, st.birthtimeMs);
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
      [...dirCounts.entries()].map(async ([name, count]) =>
        Promise.all(
          this._projectsRoots.map(async (root) => {
            const dir = path.join(root, name);
            // A small buffer beyond the pane count tolerates resume/compaction
            // spawning a fresh file mid-session.
            const recent = await findRecentJsonl(dir, count + 2);
            const recs = await Promise.all(
              recent.map((r) => extractTailRecord(r.filePath, r.mtime, r.birthtimeMs)),
            );
            // Tag each candidate with the project-dir slug it was found in, so the
            // matcher scopes it to panes whose cwd produces the SAME slug. The slug
            // is root-independent, so same-slug candidates from different roots
            // compete for the pane by recency / resume-id / fingerprint.
            for (const rec of recs) if (rec) candidates.push({ ...rec, projectDir: name });
          }),
        ),
      ),
    );

    return candidates;
  }

  /**
   * Classify each pane and resolve its agent-process start time in ONE `ps`
   * snapshot. A pane is a Claude session iff its process subtree (from the pane
   * shell pid) contains a `claude` descendant — far more reliable than the
   * `pane_current_command` version-regex, which flips to `node`/`git` while
   * Claude runs a tool. The same walk yields the agent start time (ms epoch)
   * for the start-time matching fallback.
   *
   * Best-effort: if `ps` is unavailable every pane maps to {isClaude:false,
   * startMs:null} and callers fall back to the cmd heuristic / other passes.
   *
   * @param {import('./tmux.js').Window[]} allPanes
   * @returns {Promise<Map<string, {isClaude: boolean, isCodex: boolean, kind: string|null, startMs: number|null, resumeSessionId?: string|null, appServer?: boolean, appServerEndpoint?: string|null}>>} target -> info
   */
  async _buildPaneProc(allPanes) {
    const out = new Map();
    if (allPanes.length === 0) return out;

    let rows;
    try {
      const { stdout } = await execFile(
        'ps',
        ['-axo', 'pid=,ppid=,etime=,comm=,args='],
        { timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
      );
      rows = stdout.split('\n');
    } catch {
      return out; // ps unavailable — callers fall back
    }

    /** @type {Map<number, number[]>} ppid -> child pids */
    const children = new Map();
    /** @type {Map<number, {etime:string, comm:string, args:string}>} */
    const info = new Map();
    for (const line of rows) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      info.set(pid, { etime: m[3], comm: m[4], args: m[5] || '' });
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
    }

    const now = Date.now();
    // BFS from the pane shell pid for a `claude` or `codex` descendant; return its start + pid.
    const findClaude = (rootPid) => {
      const queue = [rootPid];
      const seen = new Set();
      let codexFallback = null;
      while (queue.length) {
        const pid = queue.shift();
        if (seen.has(pid)) continue;
        seen.add(pid);
        const meta = info.get(pid);
        if (meta && (CLAUDE_COMM_RE.test(meta.comm) || CLAUDE_ARG_RE.test(meta.args))) {
          const sec = parseEtime(meta.etime);
          return { isClaude: true, isCodex: false, kind: 'claude', startMs: sec == null ? null : now - sec * 1000, pid, resumeSessionId: resumeSessionIdFromArgs(meta.args) };
        }
        const codexKind = meta
          ? (CODEX_COMM_RE.test(meta.comm) ? 'direct' : codexProcessMatchKind(meta.args))
          : null;
        if (codexKind) {
          const sec = parseEtime(meta.etime);
          const appServerEndpoint = codexAppServerEndpointFromArgs(meta.args);
          const codexInfo = {
            isClaude: false,
            isCodex: true,
            kind: 'codex',
            startMs: sec == null ? null : now - sec * 1000,
            pid,
            appServer: isCodexAppServerArgs(meta.args) || !!appServerEndpoint,
            appServerEndpoint,
          };
          // npm/nvm installs launch Codex as `node .../bin/codex`, which then
          // spawns the native Codex child. The native child holds the rollout
          // file open, so prefer it for lsof-based transcript binding while
          // keeping the wrapper as a fallback when no child is visible yet.
          if (codexKind === 'direct') return codexInfo;
          if (!codexFallback) codexFallback = codexInfo;
        }
        for (const c of children.get(pid) ?? []) queue.push(c);
      }
      return codexFallback || { isClaude: false, isCodex: false, kind: null, startMs: null, pid: null, appServer: false, appServerEndpoint: null };
    };

    for (const p of allPanes) {
      out.set(p.target, p.panePid ? findClaude(p.panePid) : { isClaude: false, isCodex: false, kind: null, startMs: null, pid: null, appServer: false, appServerEndpoint: null });
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
