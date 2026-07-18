/**
 * lib/subagents.js — watch a session's sub-agent (Task/Agent) transcripts.
 *
 * Claude Code writes each sub-agent's conversation to a sibling of the parent
 * transcript:
 *   <project>/<sessionId>.jsonl                     ← parent
 *   <project>/<sessionId>/subagents/agent-<id>.jsonl ← sub-agent transcript
 *   <project>/<sessionId>/subagents/agent-<id>.meta.json
 *       { agentType, description, toolUseId }         ← links to the parent's
 *                                                       Task tool-call
 *
 * This watcher discovers those files (lazily — polled when the parent transcript
 * grows, which is exactly when sub-agents spawn), tails each one with the same
 * bounded TranscriptTailer the main transcript uses, and emits a 'change' event
 * carrying the full sub-agent entry whenever it appears or grows. The server
 * relays each entry to subscribed clients as a `subagent` frame.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { TranscriptTailer } from './transcript.js';
import { parseCodexSubagentNotificationRecord } from './codex.js';

const META_RE = /^agent-(.+)\.meta\.json$/;
// Legacy mtime-only threshold, kept for hasActiveSubAgents()'s backward-compat
// contract (its own dedicated tests pin this default). SubAgentsWatcher's
// _statusFor() and computeSubAgentActivity() no longer use this — they are
// canonical-first (spawn↔completion pairing), with the much more generous
// FALLBACK_IDLE_MS below as their soft mtime fallback.
const RUNNING_WINDOW_MS = 45_000;
// A file written within this window is treated as actively-running, overriding a
// (possibly premature, e.g. background-launch-ack) doneByParent flag.
const ACTIVE_WINDOW_MS = 20_000;
// Canonical-first fallback: when no spawn↔completion pairing signal is known
// (agent predates the scan window, meta hasn't arrived yet, nested/depth≥2
// agent, etc.) a quiet file is still treated as running until this much more
// generous window elapses. This is what fixes the original bug — a genuinely
// running-but-idle sub-agent (inference pause, long tool call) must not
// flicker to "done" just because its transcript went quiet for a bit.
const FALLBACK_IDLE_MS = 600_000;

const SUBAGENT_JSONL_RE = /^agent-.+\.jsonl$/;
const SUBAGENT_TAIL_BYTES = 256 * 1024;
const SUBAGENT_MODEL_TAIL_BYTES = 64 * 1024;
const SUBAGENT_POLL_MS = 5_000;
const SUBAGENT_SWEEP_MS = 30_000;
const MAX_LIVE_FOLLOWERS = 32;
const MAX_DETAILED_AGENTS = 40;
const MAX_CONCURRENT_LOADS = 4;
// Bounded seed for computeSubAgentActivity()'s incremental parent-transcript
// scan: on first touch of a transcript we read only the last ~4 MB rather than
// the whole file, so a long-lived session doesn't cost a multi-MB parse just to
// answer "is a sub-agent running right now".
const ACTIVITY_TAIL_SEED_BYTES = 4 * 1024 * 1024;
const ACTIVITY_SCAN_CACHE_MAX_KEYS = 256;

/**
 * Cheap probe: does this parent transcript have a sub-agent that's actively
 * running RIGHT NOW? True when any agent-*.jsonl in its subagents dir was written
 * within `windowMs` (live sub-agents append every few seconds). Used by the
 * session poll to light the rail's "cloning" state for EVERY window — not just
 * the one a client subscribed to (the SubAgentsWatcher is subscription-scoped).
 * readdir + a stat per file; no tailing, no buffering. Returns false on any
 * error / missing dir (the common no-sub-agents case, fast ENOENT).
 *
 * @param {string} transcriptPath  absolute path to the PARENT transcript (.jsonl)
 * @param {number} [windowMs]
 * @returns {boolean}
 */
export function hasActiveSubAgents(transcriptPath, windowMs = RUNNING_WINDOW_MS) {
  if (!transcriptPath) return false;
  const dir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false; // no subagents dir → none running
  }
  const cutoff = Date.now() - windowMs;
  for (const name of entries) {
    if (!SUBAGENT_JSONL_RE.test(name)) continue;
    try {
      if (fs.statSync(path.join(dir, name)).mtimeMs >= cutoff) return true;
    } catch {
      // file vanished between readdir and stat — skip
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Canonical spawn↔completion scanning — pure, harness-agnostic folds.
//
// Both scanners fold NEW transcript text into an accumulator Set-bag so the
// same parsing rules drive both an LRU-cached incremental probe
// (computeSubAgentActivity, run for EVERY session on every poll) and a
// per-session watcher's own incremental scan (SubAgentsWatcher, used for the
// subscribed session's detail panel) without duplicating logic.
// ---------------------------------------------------------------------------

/**
 * Terminal `<task-notification>` `<status>` values — only these complete an
 * async agent. A background agent emits a `<task-notification>` EACH TIME it
 * STOPS, carrying a `<status>`; observed live values include `completed`,
 * `failed`, `killed` (terminal) and `running`, `in_progress`, `...` (progress
 * pings that must NOT be treated as completion). Anything unknown is treated as
 * non-terminal — safer to under-complete (agent lingers "running" until it
 * genuinely goes quiet past FALLBACK_IDLE_MS) than to falsely mark it done.
 */
const TERMINAL_TASK_STATUSES = new Set([
  'completed', 'complete', 'finished', 'done',
  'failed', 'error', 'errored',
  'killed', 'cancelled', 'canceled',
  'timed_out', 'timeout',
]);

/**
 * Fold a chunk of a Claude PARENT transcript (`<session>.jsonl`) into the
 * spawn↔completion accumulator. Record shapes that matter:
 *
 *  - a user record with a `tool_result` content block: SYNC completion
 *    (authoritative done) UNLESS `toolUseResult.isAsync === true`, in which
 *    case it's only the async launch-ack — NOT completion.
 *  - a user record whose `message.content` is a STRING containing
 *    `<task-notification>...<status>…</status>...`: async STOP, but ONLY when
 *    the status is TERMINAL (see TERMINAL_TASK_STATUSES) — a
 *    `<status>running</status>` ping must not complete the agent. A background
 *    agent emits one EACH TIME it stops and REUSES its agentId across resumes,
 *    so this is not a permanent completion: we record the LATEST terminal
 *    timestamp per agentId (`completedAtByAgentId`) and callers treat the agent
 *    as done only while its own transcript has NOT been appended to since that
 *    timestamp (fresh bytes after it = resumed/running).
 *
 * Completion is therefore reconciled against activity by TIMESTAMP, not a
 * monotonic Set — which is what makes a re-resumed agent read running again.
 *
 * @param {string} text  newly-read transcript bytes (one or more JSONL lines)
 * @param {{completedToolUseIds:Set<string>, completedAgentIds:Set<string>, asyncLaunchedToolUseIds:Set<string>, completedAtByAgentId?:Map<string,number>}} acc
 * @returns {typeof acc}
 */
export function scanClaudeParentChunk(text, acc) {
  if (!text) return acc;
  // agentId → latest terminal-notification timestamp (ms). Lazily created so any
  // pre-existing acc literal still works.
  const completedAt = acc.completedAtByAgentId ?? (acc.completedAtByAgentId = new Map());
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed);
      if (rec?.type !== 'user' || !rec.message) continue;
      const content = rec.message.content;
      if (typeof content === 'string') {
        if (!content.includes('<task-notification>')) continue;
        const status = /<status>([^<]*)<\/status>/.exec(content)?.[1]?.trim().toLowerCase();
        if (!status || !TERMINAL_TASK_STATUSES.has(status)) continue; // progress ping — not done
        const taskId = /<task-id>([^<]+)<\/task-id>/.exec(content)?.[1];
        const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(content)?.[1];
        if (taskId) {
          acc.completedAgentIds.add(taskId);
          const ts = Date.parse(rec.timestamp);
          if (Number.isFinite(ts)) completedAt.set(taskId, Math.max(completedAt.get(taskId) ?? 0, ts));
        }
        if (toolUseId) acc.completedToolUseIds.add(toolUseId);
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type !== 'tool_result' || !block.tool_use_id) continue;
        if (rec.toolUseResult?.isAsync === true) {
          acc.asyncLaunchedToolUseIds.add(block.tool_use_id);
        } else {
          acc.completedToolUseIds.add(block.tool_use_id);
        }
      }
    } catch {
      // malformed line — skip, never let one bad record break the scan
    }
  }
  return acc;
}

/**
 * Fold a chunk of a Codex PARENT rollout (`<rollout>.jsonl`) into the
 * spawn↔completion accumulator. Codex persists the full sub-agent lifecycle
 * as `response_item` records in the parent — no separate "running"
 * notification is emitted at spawn time, so spawnedAgentIds is populated from
 * the `spawn_agent` tool's `function_call_output` (the only place the real
 * agent_id — a UUID — is surfaced).
 *
 * @param {string} text  newly-read rollout bytes (one or more JSONL lines)
 * @param {{spawnedAgentIds:Set<string>, doneAgentIds:Set<string>}} acc
 * @returns {typeof acc}
 */
export function scanCodexRolloutChunk(text, acc) {
  if (!text) return acc;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed);
      if (rec?.type === 'response_item') {
        const p = rec.payload || {};
        if (p.type === 'function_call_output') {
          try {
            const out = JSON.parse(p.output);
            if (out && typeof out.agent_id === 'string' && out.agent_id) {
              acc.spawnedAgentIds.add(out.agent_id);
            }
          } catch { /* not a spawn_agent output — ignore */ }
        } else if (p.type === 'function_call' && p.name === 'close_agent') {
          try {
            const args = JSON.parse(p.arguments);
            if (args && typeof args.target === 'string' && args.target) {
              acc.doneAgentIds.add(args.target);
            }
          } catch { /* malformed arguments — ignore */ }
        }
      }
    } catch {
      // malformed line — parseCodexSubagentNotificationRecord below does its
      // own independent parse/try-catch regardless.
    }
    const update = parseCodexSubagentNotificationRecord(line);
    if (update?.status === 'done' && update.agentId) acc.doneAgentIds.add(update.agentId);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// computeSubAgentActivity — harness-agnostic, canonical-first "is a sub-agent
// running right now" probe. Used by the session poll for EVERY window (not
// just the one a client subscribed to), for BOTH Claude and Codex.
// ---------------------------------------------------------------------------

/**
 * Per-transcript incremental scan state, keyed by `<kind>:<transcriptPath>`.
 * @type {Map<string, {cursorBytes:number, acc:object}>}
 */
const _activityScanCache = new Map();

function _readByteRange(filePath, start, end) {
  const len = end - start;
  if (len <= 0) return '';
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Read the bytes NEW since the last call for `cacheKey`, folding them into a
 * cached accumulator via `foldFn`. Handles first-touch (seeds from a bounded
 * tail, not the whole file) and file shrink/rotation (reset + reseed). Never
 * throws — a missing/unreadable file returns null so the caller can treat it
 * as "nothing running".
 *
 * @param {string} cacheKey
 * @param {string} filePath
 * @param {() => object} makeAcc
 * @param {(text: string, acc: object) => void} foldFn
 * @returns {object|null} the accumulator, or null if the file is unreadable
 */
function _scanIncremental(cacheKey, filePath, makeAcc, foldFn) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    _activityScanCache.delete(cacheKey);
    return null;
  }
  const size = stat.size;
  let state = _activityScanCache.get(cacheKey);
  if (state && size < state.cursorBytes) state = null; // shrank/rotated — reseed

  if (!state) {
    const start = Math.max(0, size - ACTIVITY_TAIL_SEED_BYTES);
    state = { cursorBytes: size, acc: makeAcc() };
    foldFn(_readByteRange(filePath, start, size), state.acc);
  } else if (size > state.cursorBytes) {
    foldFn(_readByteRange(filePath, state.cursorBytes, size), state.acc);
    state.cursorBytes = size;
  }

  _rememberMapEntry(_activityScanCache, cacheKey, state, ACTIVITY_SCAN_CACHE_MAX_KEYS);
  return state.acc;
}

/**
 * Harness-agnostic "does this session have a running sub-agent, and how
 * many?" probe, driven by canonical spawn↔completion signals (mtime is used
 * only as a generous fallback — see FALLBACK_IDLE_MS). Safe to call for every
 * session on every poll (incremental + LRU-cached per transcript).
 *
 * @param {{kind: 'claude'|'codex'|'claudex'|string, transcriptPath: string|null}} args
 * @returns {{active: boolean, count: number, runningIds: string[]}}
 */
export function computeSubAgentActivity({ kind, transcriptPath }) {
  const none = { active: false, count: 0, runningIds: [] };
  if (!transcriptPath) return none;

  if (kind === 'codex') {
    const acc = _scanIncremental(
      `codex:${transcriptPath}`,
      transcriptPath,
      () => ({ spawnedAgentIds: new Set(), doneAgentIds: new Set() }),
      scanCodexRolloutChunk,
    );
    if (!acc) return none;
    const runningIds = [...acc.spawnedAgentIds].filter((id) => !acc.doneAgentIds.has(id));
    return { active: runningIds.length > 0, count: runningIds.length, runningIds };
  }

  // claudex writes an ordinary claude-format transcript (same binary, only the
  // upstream ANTHROPIC_BASE_URL differs) — the claude-shaped scan below applies
  // unchanged. The cache key stays prefixed 'claude:' regardless (scoped by the
  // session's own unique transcriptPath, so a claude and a claudex session never
  // collide).
  if (kind === 'claude' || kind === 'claudex') {
    const acc = _scanIncremental(
      `claude:${transcriptPath}`,
      transcriptPath,
      () => ({ completedToolUseIds: new Set(), completedAgentIds: new Set(), asyncLaunchedToolUseIds: new Set() }),
      scanClaudeParentChunk,
    );
    if (!acc) return none;

    const dir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return none; // no subagents dir → none running
    }

    const now = Date.now();
    const runningIds = [];
    for (const name of entries) {
      if (!SUBAGENT_JSONL_RE.test(name)) continue;
      const agentId = name.slice('agent-'.length, -'.jsonl'.length);
      if (!agentId) continue;

      // Stat first (cheap) and drop the common case — a long-finished historical
      // agent whose file has been quiet far beyond the fallback window — BEFORE
      // the per-agent meta.json read. A long-lived session accumulates hundreds
      // of these; paying an fs.readFileSync for every one on every poll would be
      // needless hot-path I/O. The membership test is a pure conjunction, so
      // reordering the skips can't change the result.
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(path.join(dir, name)).mtimeMs;
      } catch {
        continue; // vanished between readdir and stat
      }
      const age = now - mtimeMs;
      if (age >= FALLBACK_IDLE_MS) continue; // quiet beyond fallback → done

      // Async STOP (a terminal <task-notification>) is per-stop, not permanent:
      // a background agent reuses its agentId across resumes. It is done ONLY
      // while its own transcript has NOT been appended to since that notification
      // — a write AFTER it means the agent resumed and is running again. The
      // FALLBACK_IDLE_MS guard above still retires a truly-abandoned one. No meta
      // read needed on this branch.
      if (acc.completedAgentIds.has(agentId)) {
        const completedAt = acc.completedAtByAgentId?.get(agentId) ?? 0;
        // Wrote after the terminal notification ⇒ resumed/running. With no
        // parseable notification timestamp, fall back to freshness so completion
        // can still clear (fail-open to "fresh = running").
        const resumedSince = completedAt > 0 ? mtimeMs > completedAt : age < ACTIVE_WINDOW_MS;
        if (resumedSince) runningIds.push(agentId);
        continue;
      }

      // Not async-completed: pay the meta read to resolve the SYNC tool_result
      // completion (keyed by toolUseId). Sync/foreground agents don't resume, so
      // this stays authoritative + instant.
      let toolUseId = null;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, `agent-${agentId}.meta.json`), 'utf8'));
        toolUseId = meta?.toolUseId ?? null;
      } catch { /* meta absent/unreadable — toolUseId null; agentId signals already applied */ }
      if (toolUseId && acc.completedToolUseIds.has(toolUseId)) continue;

      runningIds.push(agentId);
    }

    return { active: runningIds.length > 0, count: runningIds.length, runningIds };
  }

  return none;
}

// ---------------------------------------------------------------------------
// Agent definition front-matter cache + discovery
// ---------------------------------------------------------------------------

/** @type {Map<string, {description?: string, tools?: string, model?: string, [k: string]: string|undefined}|null>} */
const _defCache = new Map();
const DEF_CACHE_MAX_KEYS = 256;

function _rememberMapEntry(map, key, value, maxKeys) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maxKeys) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function _rememberAgentDef(agentType, value) {
  _rememberMapEntry(_defCache, agentType, value, DEF_CACHE_MAX_KEYS);
}

/**
 * Parse YAML-style front-matter from a markdown file (lines between the first
 * pair of `---` delimiters). Supports scalar string values only — no arrays,
 * no nested objects. JSON array values (e.g. `tools: ["Read","Write"]`) are
 * returned as the raw string so callers can display them as-is.
 *
 * @param {string} content
 * @returns {Record<string, string>|null}
 */
function _parseFrontMatter(content) {
  const lines = content.split('\n');
  if (lines[0].trim() !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;
  /** @type {Record<string, string>} */
  const result = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (key) result[key] = val;
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Collect all directories to scan for agent `.md` files.
 * Order: ~/.claude/agents, ~/.claude/plugins/cache (recursive), <cwd>/.claude/agents.
 */
function _agentSearchRoots() {
  const home = os.homedir();
  const roots = [path.join(home, '.claude', 'agents')];

  // Recursively discover `agents/` directories under the plugin cache.
  const pluginCache = path.join(home, '.claude', 'plugins', 'cache');
  try {
    const walk = (/** @type {string} */ dir, /** @type {number} */ depth) => {
      if (depth > 8) return; // guard against unexpectedly deep trees
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const sub = path.join(dir, e.name);
        if (e.name === 'agents') {
          roots.push(sub);
        } else {
          walk(sub, depth + 1);
        }
      }
    };
    walk(pluginCache, 0);
  } catch { /* plugin cache absent */ }

  // Project-local agents dir (relative to server cwd).
  const localAgents = path.join(process.cwd(), '.claude', 'agents');
  if (!roots.includes(localAgents)) roots.push(localAgents);

  return roots;
}

/**
 * Look up an agent definition by agentType. Returns the parsed front-matter
 * object, or null if not found. Results are cached so disk is only scanned once
 * per agentType per process lifetime.
 *
 * @param {string} agentType
 * @returns {Record<string,string>|null}
 */
function _lookupAgentDef(agentType) {
  if (_defCache.has(agentType)) return _defCache.get(agentType) ?? null;

  const roots = _agentSearchRoots();
  for (const dir of roots) {
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const name of files) {
      if (!name.endsWith('.md')) continue;
      const filePath = path.join(dir, name);
      let content;
      try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
      const fm = _parseFrontMatter(content);
      if (!fm) continue;
      // Match by front-matter `name:` field OR by filename (sans .md).
      const byName = fm.name === agentType;
      const byFile = name.slice(0, -3) === agentType;
      if (byName || byFile) {
        _rememberAgentDef(agentType, fm);
        return fm;
      }
    }
  }

  _rememberAgentDef(agentType, null); // negative cache
  return null;
}

// ---------------------------------------------------------------------------
// Agent listing — mirrors lib/skills.js `listSkills` pattern
// ---------------------------------------------------------------------------

/** 30-second TTL for the agent list cache. */
const AGENTS_CACHE_TTL_MS = 30_000;
const AGENTS_CACHE_MAX_KEYS = 128;

/**
 * Per-cwd cache so different sessions each get their own merged agent list.
 * Key: cwd string (or '' for the process-cwd-only list).
 * @type {Map<string, { agents: AgentEntry[], ts: number }>}
 */
const _agentsCache = new Map();

function _pruneExpiredAgentsCache(now) {
  for (const [key, value] of _agentsCache) {
    if (now - value.ts >= AGENTS_CACHE_TTL_MS) _agentsCache.delete(key);
  }
}

/**
 * @typedef {{ name: string, description: string, source: 'user' | 'project' | 'plugin' }} AgentEntry
 */

/**
 * Discover all available agent definitions for a given session cwd.
 * Merges roots from `_agentSearchRoots()` (user + plugin + process.cwd agents)
 * plus the session-specific cwd agents dir when provided.
 *
 * Priority (highest → lowest): project > user > plugin.
 * Implemented by processing roots in order plugin → user → project and
 * overwriting on name clash (later entry wins), which yields project-last = wins.
 *
 * Results are cached per-cwd for AGENTS_CACHE_TTL_MS.
 *
 * @param {string|null} [cwd]  the session's working directory; null = no project agents
 * @returns {AgentEntry[]}
 */
export function listAgents(cwd) {
  const cacheKey = cwd ?? '';
  const now = Date.now();
  const hit = _agentsCache.get(cacheKey);
  if (hit && now - hit.ts < AGENTS_CACHE_TTL_MS) {
    _rememberMapEntry(_agentsCache, cacheKey, hit, AGENTS_CACHE_MAX_KEYS);
    return hit.agents;
  }
  _pruneExpiredAgentsCache(now);

  const home = os.homedir();
  const pluginCacheRoot = path.join(home, '.claude', 'plugins', 'cache');

  // Collect roots from _agentSearchRoots() (includes user + plugin cache + process.cwd agents).
  const baseRoots = _agentSearchRoots();

  // Also include the session-specific cwd agents dir when it differs from process.cwd().
  const cwdAgentsDir = cwd ? path.join(cwd, '.claude', 'agents') : null;
  const allRoots = cwdAgentsDir && !baseRoots.includes(cwdAgentsDir)
    ? [...baseRoots, cwdAgentsDir]
    : baseRoots;

  /**
   * Classify a root by source priority.
   * Plugin roots live under ~/.claude/plugins/cache.
   * The user root is ~/.claude/agents.
   * Everything else is treated as project (cwd-local).
   *
   * We process in order: plugin → user → project so that when names clash
   * the last write wins, giving project > user > plugin precedence.
   */
  const classifyRoot = (/** @type {string} */ dir) => {
    if (dir.startsWith(pluginCacheRoot + path.sep) || dir === pluginCacheRoot) return 'plugin';
    if (dir === path.join(home, '.claude', 'agents')) return 'user';
    return 'project';
  };

  // Sort roots: plugin first, then user, then project (so project overwrites on clash).
  const priority = { plugin: 0, user: 1, project: 2 };
  const sortedRoots = [...allRoots].sort((a, b) => priority[classifyRoot(a)] - priority[classifyRoot(b)]);

  /** @type {Map<string, AgentEntry>} */
  const byName = new Map();

  for (const dir of sortedRoots) {
    const source = classifyRoot(dir);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const filename of files) {
      if (!filename.endsWith('.md')) continue;
      const filePath = path.join(dir, filename);
      let content;
      try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
      const fm = _parseFrontMatter(content);
      const name = fm?.name?.trim() || filename.slice(0, -3); // sans .md
      const description = fm?.description ?? '';
      // Overwrite unconditionally — sortedRoots ordering ensures project wins last.
      byName.set(name, { name, description, source });
    }
  }

  const agents = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  _rememberMapEntry(_agentsCache, cacheKey, { agents, ts: now }, AGENTS_CACHE_MAX_KEYS);
  return agents;
}

/**
 * Bust the in-process agents cache. Used in tests.
 */
export function _bustAgentsCache() {
  _agentsCache.clear();
  _defCache.clear();
}

export function _agentsCacheSizeForTest() {
  return _agentsCache.size;
}

export class CodexSubAgentsWatcher extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, {agentId:string, agentPath:string, status:'running'|'done', state:string, result:string|null, error:string|null, rawStatus:any, messages:any[], createdAtMs:number, updatedAtMs:number}>} */
    this._agents = new Map();
    this._stopped = false;
  }

  snapshot() {
    return [...this._agents.values()].map((a) => this._entry(a));
  }

  poll() {
    // Codex sub-agent notifications arrive inline via transcript/RPC events.
  }

  async load(agentId) {
    const agent = this._agents.get(agentId);
    return agent ? this._entry(agent) : null;
  }

  markDone() {
    // Completion is driven by Codex notification status, not parent tool_result ids.
  }

  ingest(update) {
    if (this._stopped || !update?.agentId) return null;
    const now = Date.now();
    const prev = this._agents.get(update.agentId);
    const status = update.status === 'done' ? 'done' : 'running';
    const state = update.state || status;
    const text =
      update.error ? `Codex sub-agent ${state}: ${update.error}` :
      update.result ? String(update.result) :
      state === 'running' ? 'Codex sub-agent running…' :
      `Codex sub-agent ${state}`;
    const message = {
      uuid: `codex-subagent-${update.agentId}-${now}`,
      role: 'assistant',
      ts: update.ts ?? now,
      blocks: [{ kind: update.error ? 'text' : 'text', text }],
      rawType: 'codex_subagent_notification',
    };
    const next = {
      agentId: update.agentId,
      agentPath: update.agentPath,
      status,
      state,
      result: update.result ?? null,
      error: update.error ?? null,
      rawStatus: update.rawStatus ?? null,
      messages: prev ? [...prev.messages, message].slice(-200) : [message],
      createdAtMs: prev?.createdAtMs ?? now,
      updatedAtMs: now,
    };
    this._agents.set(update.agentId, next);
    const entry = this._entry(next);
    this.emit('change', entry);
    return entry;
  }

  stop() {
    this._stopped = true;
    this._agents.clear();
  }

  trim(keepMessages = 40) {
    for (const agent of this._agents.values()) {
      if (agent.messages.length > keepMessages) agent.messages = agent.messages.slice(-keepMessages);
    }
  }

  _entry(a) {
    return {
      agentId: a.agentId,
      toolUseId: null,
      agentType: 'codex',
      description: a.agentPath,
      status: a.status,
      messages: a.messages.slice(),
      messagesLoaded: true,
      createdAt: a.createdAtMs,
      model: null,
      def: null,
      nested: [],
    };
  }
}

export class SubAgentsWatcher extends EventEmitter {
  /**
   * @param {string} transcriptPath  absolute path to the PARENT transcript
   * @param {{ maxBuffer?: number }} [opts]
   */
  constructor(transcriptPath, { maxBuffer = 200 } = {}) {
    super();
    // <project>/<sessionId>.jsonl → <project>/<sessionId>/subagents
    this._dir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
    this._maxBuffer = maxBuffer;
    // The PARENT transcript is exactly `transcriptPath` — scanned incrementally
    // for canonical spawn↔completion signals (tool_result / <task-notification>).
    this._parentPath = transcriptPath;
    this._parentCursorBytes = 0;
    this._parentAcc = { completedToolUseIds: new Set(), completedAgentIds: new Set(), asyncLaunchedToolUseIds: new Set() };
    /** @type {Map<string, any>} */
    this._agents = new Map(); // keyed by agentId
    this._stopped = false;
    this._activeLoads = 0;
    this._loadQueue = [];
    this._sweepTimer = setInterval(() => this.poll(), SUBAGENT_SWEEP_MS);
    this._sweepTimer.unref?.();
  }

  /** Current sub-agents (snapshot), each with its buffered messages. */
  snapshot() {
    return [...this._agents.values()].map((a) => this._entry(a));
  }

  /**
   * Rescan the subagents dir for new agent files. Cheap; safe to call often.
   * Call on each parent-transcript append (when sub-agents are spawned) and once
   * at subscribe time.
   *
   * Discovery is keyed on agent-<id>.jsonl (same signal as hasActiveSubAgents)
   * so the rail and the detailed watcher agree. The .meta.json is enrichment
   * only — its absence must not block discovery.
   */
  poll() {
    if (this._stopped) return;
    const previouslyTracked = new Set(this._agents.keys());
    let entries;
    try {
      entries = fs.readdirSync(this._dir);
    } catch {
      return; // dir doesn't exist yet (no sub-agents) — nothing to do
    }
    for (const name of entries) {
      if (!SUBAGENT_JSONL_RE.test(name)) continue;
      // Extract agentId from "agent-<id>.jsonl"
      const agentId = name.slice('agent-'.length, -'.jsonl'.length);
      if (!agentId) continue;
      if (this._agents.has(agentId)) continue;
      this._track(agentId);
    }

    this._refreshCanonical();

    // Meta-late upgrade: for already-tracked agents whose meta fields are still
    // null, check if the .meta.json has since arrived and populate the fields.
    // This is important for markDone (needs toolUseId) and display (agentType).
    for (const agent of this._agents.values()) {
      if (previouslyTracked.has(agent.agentId)) this._refreshStat(agent);
      // Nested agents can appear after their parent was first discovered. Only
      // probe actively-followed parents so large historical sessions stay cheap.
      if (agent.tailer && this._refreshNested(agent)) this._emitChange(agent);
      if (agent.metaLoaded) continue;
      const metaPath = path.join(this._dir, `agent-${agent.agentId}.meta.json`);
      let meta;
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) || {};
      } catch {
        continue; // still not readable — try next poll
      }
      agent.metaLoaded = true;
      // Only upgrade fields that are still null to avoid overwriting valid data.
      let upgraded = false;
      if (agent.toolUseId === null && meta.toolUseId != null) {
        agent.toolUseId = meta.toolUseId;
        upgraded = true;
      }
      if (agent.agentType === null && meta.agentType != null) {
        agent.agentType = meta.agentType;
        upgraded = true;
      }
      if (agent.description === null && meta.description != null) {
        agent.description = meta.description;
        upgraded = true;
      }
      if (upgraded) this._emitChange(agent);
    }

    this._reconcileFollowers();

    // Surface purely time-based status transitions (running→done as a file goes
    // quiet). No append fires for a finished agent, so this poll-driven check is
    // the only path that pushes its 'done' to the client. See _emitChange.
    for (const agent of this._agents.values()) {
      if (this._statusFor(agent) !== agent._emittedStatus) this._emitChange(agent);
    }

    // R10: _agents never shrank on its own — trim() only strips heavy fields,
    // markDone() only flips a flag, full clear only happened on stop(). Prune
    // entries that are both done (canonical _statusFor check, same idiom
    // trim() already uses) AND whose jsonl is gone from disk (so load() has
    // nothing left to serve) — this is a strict superset-safe subset of "dead
    // weight", never touches a done-but-still-loadable historical agent.
    for (const [agentId, agent] of this._agents) {
      if (this._statusFor(agent) !== 'done') continue;
      if (fs.existsSync(agent.jsonlPath)) continue;
      agent.tailer?.stop();
      this._agents.delete(agentId);
    }
  }

  /**
   * Load one historical transcript on demand. Repeated/concurrent requests are
   * coalesced, and only a bounded tail is retained.
   */
  async load(agentId) {
    const agent = this._agents.get(agentId);
    if (!agent || this._stopped) return null;
    agent.lastAccessMs = Date.now();
    if (agent.messagesLoaded) return this._entry(agent);
    if (agent.loadPromise) return agent.loadPromise;

    agent.loadPromise = this._enqueueLoad(() => this._loadSnapshot(agent)).finally(() => {
      agent.loadPromise = null;
    });
    return agent.loadPromise;
  }

  /**
   * Mark a sub-agent finished (the parent transcript produced a tool_result for
   * its toolUseId — the authoritative "done" signal). Idempotent. Accepts a Set
   * or a single id so the server can sweep its whole buffer at subscribe time.
   * @param {string|Set<string>} toolUseIds
   */
  markDone(toolUseIds) {
    const has = (id) =>
      toolUseIds instanceof Set ? toolUseIds.has(id) : toolUseIds === id;
    for (const a of this._agents.values()) {
      if (a.toolUseId && has(a.toolUseId) && !a.doneByParent) {
        a.doneByParent = true;
        this._emitChange(a);
      }
    }
  }

  stop() {
    this._stopped = true;
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
    for (const a of this._agents.values()) a.tailer?.stop();
    for (const queued of this._loadQueue.splice(0)) queued.resolve(null);
    this._agents.clear();
  }

  /** Release completed transcript detail while preserving cheap summaries. */
  trim(keepMessages = 40, keepDetailed = 8) {
    const detailed = [...this._agents.values()]
      .filter((a) => a.messagesLoaded)
      .sort((a, b) => (b.lastAccessMs ?? 0) - (a.lastAccessMs ?? 0));
    for (let i = 0; i < detailed.length; i++) {
      const a = detailed[i];
      if (a.tailer && this._statusFor(a) === 'running') {
        a.tailer.trim(keepMessages);
        continue;
      }
      if (i < keepDetailed) {
        if (a.tailer) a.tailer.trim(keepMessages);
        else if (a.messages.length > keepMessages) a.messages = a.messages.slice(-keepMessages);
        continue;
      }
      this._dropDetail(a);
    }
  }

  // -- internals --

  _track(agentId) {
    const metaPath = path.join(this._dir, `agent-${agentId}.meta.json`);
    const jsonlPath = path.join(this._dir, `agent-${agentId}.jsonl`);
    // Read meta best-effort: if absent or unparseable, default to {} so the
    // agent still appears in snapshot(). poll() upgrades null fields later
    // when .meta.json arrives (common: jsonl written first, meta a beat later).
    let meta = {};
    let metaLoaded = false;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) || {};
      metaLoaded = true;
    } catch {
      // meta not readable yet — proceed with empty meta; poll() will upgrade
    }

    const agent = {
      agentId,
      jsonlPath,
      toolUseId: meta.toolUseId ?? null,
      agentType: meta.agentType ?? null,
      description: meta.description ?? null,
      metaLoaded,
      doneByParent: false,
      canonicalDone: false,
      syncDone: false,
      asyncStopped: false,
      completedAt: 0,
      asyncLaunched: false,
      tailer: null,
      messages: [],
      messagesLoaded: false,
      loadPromise: null,
      lastAccessMs: 0,
      /** @type {string|null} model extracted from the agent's own transcript */
      model: null,
      mtimeMs: 0,
      createdAtMs: null,
      nested: [],
      _emittedStatus: undefined,
    };
    this._refreshStat(agent);
    agent._emittedStatus = this._statusFor(agent);
    this._agents.set(agentId, agent);
  }

  _reconcileFollowers() {
    const live = [...this._agents.values()]
      .filter((a) => this._statusFor(a) === 'running')
      .sort((a, b) => this._mtime(b) - this._mtime(a));
    const shouldFollow = new Set(live.slice(0, MAX_LIVE_FOLLOWERS).map((a) => a.agentId));

    for (const agent of this._agents.values()) {
      if (shouldFollow.has(agent.agentId)) {
        if (!agent.tailer && !agent.loadPromise) this._startFollower(agent);
      } else if (agent.tailer) {
        agent.messages = agent.tailer.getMessages();
        agent.tailer.stop();
        agent.tailer = null;
      }
    }
    this._evictDetails();
  }

  _startFollower(agent) {
    const tailer = new TranscriptTailer(agent.jsonlPath, {
      maxBuffer: this._maxBuffer,
      tailBytes: SUBAGENT_TAIL_BYTES,
      pollMs: SUBAGENT_POLL_MS,
    });
    agent.tailer = tailer;
    agent.lastAccessMs = Date.now();
    tailer.on('append', () => {
      agent.messagesLoaded = true;
      this._refreshStat(agent);
      agent.model = this._readLatestModel(agent.jsonlPath) ?? agent.model;
      this._refreshNested(agent);
      this._emitChange(agent);
    });
    tailer.on('error', () => {});
    tailer.start().then(() => {
      if (this._stopped || agent.tailer !== tailer) {
        tailer.stop();
        return;
      }
      agent.messagesLoaded = true;
      this._refreshStat(agent);
      agent.model = this._readLatestModel(agent.jsonlPath) ?? agent.model;
      this._refreshNested(agent);
      this._emitChange(agent);
    }).catch(() => {});
  }

  async _loadSnapshot(agent) {
    const tailer = new TranscriptTailer(agent.jsonlPath, {
      maxBuffer: this._maxBuffer,
      tailBytes: SUBAGENT_TAIL_BYTES,
      snapshotOnly: true,
      watch: false,
      pollMs: 0,
    });
    tailer.on('error', () => {});
    await tailer.start();
    if (this._stopped) return null;
    agent.messages = tailer.getMessages();
    agent.messagesLoaded = true;
    this._refreshStat(agent);
    agent.model = this._readLatestModel(agent.jsonlPath) ?? agent.model;
    this._refreshNested(agent);
    agent.lastAccessMs = Date.now();
    this._evictDetails(agent.agentId);
    this._emitChange(agent);
    return this._entry(agent);
  }

  _evictDetails(protectAgentId = null) {
    const detailed = [...this._agents.values()]
      .filter((a) => a.messagesLoaded && a.agentId !== protectAgentId && !a.tailer)
      .sort((a, b) => (b.lastAccessMs ?? 0) - (a.lastAccessMs ?? 0));
    const protectedCount = protectAgentId ? 1 : 0;
    for (const agent of detailed.slice(Math.max(0, MAX_DETAILED_AGENTS - protectedCount))) {
      this._dropDetail(agent);
    }
  }

  _dropDetail(agent) {
    agent.tailer?.stop();
    agent.tailer = null;
    agent.messages = [];
    agent.messagesLoaded = false;
  }

  _mtime(agent) {
    return agent.mtimeMs ?? 0;
  }

  _refreshStat(agent) {
    try {
      const stat = fs.statSync(agent.jsonlPath);
      agent.mtimeMs = stat.mtimeMs;
      agent.createdAtMs ??= stat.birthtimeMs;
    } catch {
      agent.mtimeMs = 0;
    }
  }

  /**
   * Scan newly-appended PARENT transcript bytes for canonical spawn↔completion
   * signals (tool_result / <task-notification>) and stamp each tracked agent's
   * canonicalDone/asyncLaunched flags. This is the authoritative signal
   * _statusFor() checks first — mtime freshness is only the fallback.
   */
  _refreshCanonical() {
    const text = this._readNewParentBytes();
    if (text) scanClaudeParentChunk(text, this._parentAcc);
    for (const agent of this._agents.values()) {
      // asyncStopped: a terminal <task-notification> fired (and no later resume
      // cleared it). Per-STOP, not permanent — _statusFor reconciles it against
      // fresh transcript activity. syncDone: a foreground tool_result completion
      // (agents that don't resume) — authoritative + instant.
      const asyncStopped = this._parentAcc.completedAgentIds.has(agent.agentId);
      const syncDone = !asyncStopped
        && !!(agent.toolUseId && this._parentAcc.completedToolUseIds.has(agent.toolUseId));
      agent.asyncStopped = asyncStopped;
      agent.syncDone = syncDone;
      agent.completedAt = this._parentAcc.completedAtByAgentId?.get(agent.agentId) ?? 0;
      agent.canonicalDone = asyncStopped || syncDone; // kept for compat/debug
      agent.asyncLaunched = !!(agent.toolUseId && this._parentAcc.asyncLaunchedToolUseIds.has(agent.toolUseId));
    }
  }

  _readNewParentBytes() {
    let stat;
    try {
      stat = fs.statSync(this._parentPath);
    } catch {
      return '';
    }
    const size = stat.size;
    if (size < this._parentCursorBytes) this._parentCursorBytes = 0; // rotated/shrank — reset cursor (acc keeps prior completions, safe: never un-completes)
    if (size <= this._parentCursorBytes) return '';
    const len = size - this._parentCursorBytes;
    let text = '';
    try {
      const fd = fs.openSync(this._parentPath, 'r');
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, this._parentCursorBytes);
      text = buf.toString('utf8');
      fs.closeSync(fd);
    } catch {
      text = '';
    }
    this._parentCursorBytes = size;
    return text;
  }

  _readLatestModel(jsonlPath) {
    let fd;
    try {
      const stat = fs.statSync(jsonlPath);
      const length = Math.min(stat.size, SUBAGENT_MODEL_TAIL_BYTES);
      if (!length) return null;
      const buf = Buffer.allocUnsafe(length);
      fd = fs.openSync(jsonlPath, 'r');
      fs.readSync(fd, buf, 0, length, stat.size - length);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        let rec;
        try { rec = JSON.parse(lines[i]); } catch { continue; }
        const model = rec?.message?.model ?? rec?.model;
        if (typeof model === 'string' && model) return model;
      }
    } catch { /* best effort */ }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
    return null;
  }

  _readNested(agentId) {
    const nested = [];
    try {
      const nestedDir = path.join(this._dir, agentId, 'subagents');
      for (const name of fs.readdirSync(nestedDir)) {
        const match = META_RE.exec(name);
        if (!match) continue;
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(path.join(nestedDir, name), 'utf8')) || {}; } catch { /* ignore */ }
        nested.push({ agentId: match[1], agentType: meta.agentType ?? null, model: null });
      }
    } catch { /* no nested agents */ }
    return nested;
  }

  _refreshNested(agent) {
    const next = this._readNested(agent.agentId);
    if (JSON.stringify(next) === JSON.stringify(agent.nested)) return false;
    agent.nested = next;
    return true;
  }

  _enqueueLoad(run) {
    return new Promise((resolve, reject) => {
      this._loadQueue.push({ run, resolve, reject });
      this._drainLoads();
    });
  }

  _drainLoads() {
    while (!this._stopped && this._activeLoads < MAX_CONCURRENT_LOADS && this._loadQueue.length) {
      const queued = this._loadQueue.shift();
      this._activeLoads++;
      Promise.resolve()
        .then(queued.run)
        .then(queued.resolve, queued.reject)
        .finally(() => {
          this._activeLoads--;
          this._drainLoads();
        });
    }
  }

  /**
   * Status: canonical-first, resume-aware. A SYNC tool_result completion is
   * authoritative + instant (foreground agents don't resume). An async
   * `<task-notification>` (asyncStopped) is per-STOP: a background agent reuses
   * its agentId across resumes, so a stale terminal notification must NOT beat a
   * transcript that's actively appending — fresh bytes (within ACTIVE_WINDOW_MS)
   * mean it resumed and is running again. Absent any completion signal, fall
   * back to transcript freshness with a generous FALLBACK_IDLE_MS so a
   * running-but-quiet agent (inference pause, long tool call, a spawnDepth-1
   * officer waiting on its own children) never flickers to "done".
   */
  _statusFor(a) {
    const mtimeMs = a.mtimeMs ?? 0;
    const age = mtimeMs ? Date.now() - mtimeMs : Infinity;
    if (a.syncDone) return 'done'; // foreground completion — authoritative, instant
    // Async stop is per-stop, not permanent: a background agent reuses its
    // agentId across resumes, so a terminal <task-notification> only means done
    // while the agent's own transcript has NOT been written since that notif.
    // A write AFTER it ⇒ resumed/running (subject to the generous quiet fallback).
    if (a.asyncStopped) {
      const completedAt = a.completedAt ?? 0;
      const resumedSince = completedAt > 0 ? mtimeMs > completedAt : age < ACTIVE_WINDOW_MS;
      if (resumedSince) return age < FALLBACK_IDLE_MS ? 'running' : 'done';
      return 'done';
    }
    if (!mtimeMs) return 'done';
    // Actively being written → RUNNING, even if a block-based hint already fired.
    // A BACKGROUND agent's launch-ack tool_result lands IMMEDIATELY (setting
    // doneByParent) while the agent keeps writing for minutes.
    if (age < ACTIVE_WINDOW_MS) return 'running';
    // Quiet file, no canonical completion: doneByParent is a legacy block-based
    // hint — only trust it when it's NOT just an async launch-ack ("spawned",
    // not "finished"; the real completion is the later <task-notification>).
    if (a.doneByParent && !a.asyncLaunched) return 'done';
    // Generous mtime fallback: covers agents that predate the scan window, whose
    // meta/toolUseId hasn't arrived yet, resumed agents (cleared from the
    // completed sets), or nested (depth>=2) agents.
    return age < FALLBACK_IDLE_MS ? 'running' : 'done';
  }

  /**
   * Emit a change frame AND remember the status we last told clients. A
   * finishing agent's file goes quiet (no further append ever fires), so the
   * poll-driven sweep below is the ONLY thing that can surface its purely
   * time-based running→done transition to the client. Route ALL emits through
   * here so `_emittedStatus` never goes stale.
   */
  _emitChange(agent) {
    agent._emittedStatus = this._statusFor(agent);
    this.emit('change', this._entry(agent));
  }

  _entry(a) {
    return {
      agentId: a.agentId,
      toolUseId: a.toolUseId,
      agentType: a.agentType,
      description: a.description,
      status: this._statusFor(a),
      messages: a.tailer ? a.tailer.getMessages() : a.messages.slice(),
      messagesLoaded: a.messagesLoaded,
      createdAt: a.createdAtMs ?? null,
      model: a.model ?? null,
      def: a.messagesLoaded && a.agentType ? _lookupAgentDef(a.agentType) : null,
      nested: a.nested,
    };
  }
}
