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

const META_RE = /^agent-(.+)\.meta\.json$/;
// A sub-agent whose transcript hasn't grown in this long is treated as finished,
// even if we never saw the parent's tool_result (e.g. it predates the parent's
// bounded message buffer). Live sub-agents append every few seconds (each token
// or tool result updates the file), so a quiet file past ACTIVE_WINDOW_MS (20 s)
// is almost certainly done. 45 s is generous enough to absorb a brief inference
// pause without mis-classifying a still-running agent, while clearing finished
// agents ~13× faster than the previous 600 s fallback.
// doneByParent always wins when available (authoritative, instant).
const RUNNING_WINDOW_MS = 45_000;
// A file written within this window is treated as actively-running, overriding a
// (possibly premature, e.g. background-launch-ack) doneByParent flag.
const ACTIVE_WINDOW_MS = 20_000;

const SUBAGENT_JSONL_RE = /^agent-.+\.jsonl$/;

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
// Agent definition front-matter cache + discovery
// ---------------------------------------------------------------------------

/** @type {Map<string, {description?: string, tools?: string, model?: string, [k: string]: string|undefined}|null>} */
const _defCache = new Map();

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
        _defCache.set(agentType, fm);
        return fm;
      }
    }
  }

  _defCache.set(agentType, null); // negative cache
  return null;
}

// ---------------------------------------------------------------------------
// Agent listing — mirrors lib/skills.js `listSkills` pattern
// ---------------------------------------------------------------------------

/** 30-second TTL for the agent list cache. */
const AGENTS_CACHE_TTL_MS = 30_000;

/**
 * Per-cwd cache so different sessions each get their own merged agent list.
 * Key: cwd string (or '' for the process-cwd-only list).
 * @type {Map<string, { agents: AgentEntry[], ts: number }>}
 */
const _agentsCache = new Map();

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
    return hit.agents;
  }

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
  _agentsCache.set(cacheKey, { agents, ts: now });
  return agents;
}

/**
 * Bust the in-process agents cache. Used in tests.
 */
export function _bustAgentsCache() {
  _agentsCache.clear();
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

  _entry(a) {
    return {
      agentId: a.agentId,
      toolUseId: null,
      agentType: 'codex',
      description: a.agentPath,
      status: a.status,
      messages: a.messages.slice(),
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
    /** @type {Map<string, {agentId, toolUseId, agentType, description, status, tailer}>} */
    this._agents = new Map(); // keyed by agentId
    this._stopped = false;
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

    // Meta-late upgrade: for already-tracked agents whose meta fields are still
    // null, check if the .meta.json has since arrived and populate the fields.
    // This is important for markDone (needs toolUseId) and display (agentType).
    for (const agent of this._agents.values()) {
      if (agent.toolUseId !== null && agent.agentType !== null) continue; // already populated
      const metaPath = path.join(this._dir, `agent-${agent.agentId}.meta.json`);
      let meta;
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) || {};
      } catch {
        continue; // still not readable — try next poll
      }
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
      if (upgraded) this.emit('change', this._entry(agent));
    }
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
        this.emit('change', this._entry(a));
      }
    }
  }

  stop() {
    this._stopped = true;
    for (const a of this._agents.values()) a.tailer?.stop();
    this._agents.clear();
  }

  // -- internals --

  _track(agentId) {
    const metaPath = path.join(this._dir, `agent-${agentId}.meta.json`);
    const jsonlPath = path.join(this._dir, `agent-${agentId}.jsonl`);
    // Read meta best-effort: if absent or unparseable, default to {} so the
    // agent still appears in snapshot(). poll() upgrades null fields later
    // when .meta.json arrives (common: jsonl written first, meta a beat later).
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) || {};
    } catch {
      // meta not readable yet — proceed with empty meta; poll() will upgrade
    }

    const tailer = new TranscriptTailer(jsonlPath, { maxBuffer: this._maxBuffer });
    const agent = {
      agentId,
      jsonlPath,
      toolUseId: meta.toolUseId ?? null,
      agentType: meta.agentType ?? null,
      description: meta.description ?? null,
      doneByParent: false,
      tailer,
      /** @type {string|null} model extracted from the agent's own transcript */
      model: null,
      createdAtMs: (() => { try { return fs.statSync(jsonlPath).birthtimeMs; } catch { return null; } })(),
    };
    this._agents.set(agentId, agent);

    // Extract model from JSONL records as they arrive. Assistant records carry
    // a top-level `message.model` field. Latest non-empty value wins.
    const _updateModel = () => {
      try {
        const raw = fs.readFileSync(jsonlPath, 'utf8');
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          let rec;
          try { rec = JSON.parse(line); } catch { continue; }
          const m = rec?.message?.model ?? rec?.model ?? null;
          if (m && typeof m === 'string') agent.model = m;
        }
      } catch { /* file may not exist yet */ }
    };
    _updateModel(); // initial read

    tailer.on('append', () => { _updateModel(); this.emit('change', this._entry(agent)); });
    tailer.on('error', () => {}); // best-effort; a missing file just yields no messages
    tailer
      .start()
      .then(() => { _updateModel(); this.emit('change', this._entry(agent)); })
      .catch(() => {});
  }

  /**
   * Status: done if the parent confirmed it (authoritative), otherwise inferred
   * from transcript freshness — a live sub-agent's file is actively appended; a
   * finished one goes static. This keeps historical sub-agents correctly "done"
   * even when their parent tool_result predates the bounded message buffer.
   */
  _statusFor(a) {
    let mtimeMs = null;
    try {
      mtimeMs = fs.statSync(a.jsonlPath).mtimeMs;
    } catch {
      return 'done';
    }
    const age = Date.now() - mtimeMs;
    // Actively being written → RUNNING, even if the parent already emitted a
    // tool_result for this agent. A BACKGROUND agent's launch-ack tool_result
    // lands IMMEDIATELY (setting doneByParent) while the agent keeps writing for
    // minutes — without this override it would wrongly read as done the whole run.
    if (age < ACTIVE_WINDOW_MS) return 'running';
    // Quiet file: the parent's tool_result is now authoritative (foreground agents
    // go quiet exactly at completion → done within ACTIVE_WINDOW). Otherwise fall
    // back to the longer freshness window (covers long mid-inference pauses).
    if (a.doneByParent) return 'done';
    return age < RUNNING_WINDOW_MS ? 'running' : 'done';
  }

  _entry(a) {
    // Resolve nested sub-agents (best-effort). Claude Code places a nested
    // agent's subagents dir at <dir>/<agentId>/subagents/ relative to the
    // parent's subagents dir.
    let nested = [];
    try {
      const nestedDir = path.join(this._dir, a.agentId, 'subagents');
      const entries = fs.readdirSync(nestedDir);
      for (const name of entries) {
        const m = META_RE.exec(name);
        if (!m) continue;
        const nestedAgentId = m[1];
        const nestedMeta = (() => {
          try {
            return JSON.parse(fs.readFileSync(path.join(nestedDir, name), 'utf8')) || {};
          } catch { return {}; }
        })();
        nested.push({
          agentId: nestedAgentId,
          agentType: nestedMeta.agentType ?? null,
          model: null,
        });
      }
    } catch { /* no nested sub-agents */ }

    return {
      agentId: a.agentId,
      toolUseId: a.toolUseId,
      agentType: a.agentType,
      description: a.description,
      status: this._statusFor(a),
      messages: a.tailer ? a.tailer.getMessages() : [],
      createdAt: a.createdAtMs ?? null,
      model: a.model ?? null,
      def: a.agentType ? _lookupAgentDef(a.agentType) : null,
      nested,
    };
  }
}
