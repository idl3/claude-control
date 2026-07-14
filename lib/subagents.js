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
const SUBAGENT_TAIL_BYTES = 256 * 1024;
const SUBAGENT_MODEL_TAIL_BYTES = 64 * 1024;
const SUBAGENT_POLL_MS = 5_000;
const SUBAGENT_SWEEP_MS = 30_000;
const MAX_LIVE_FOLLOWERS = 32;
const MAX_DETAILED_AGENTS = 40;
const MAX_CONCURRENT_LOADS = 4;

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

    // Meta-late upgrade: for already-tracked agents whose meta fields are still
    // null, check if the .meta.json has since arrived and populate the fields.
    // This is important for markDone (needs toolUseId) and display (agentType).
    for (const agent of this._agents.values()) {
      if (previouslyTracked.has(agent.agentId)) this._refreshStat(agent);
      // Nested agents can appear after their parent was first discovered. Only
      // probe actively-followed parents so large historical sessions stay cheap.
      if (agent.tailer && this._refreshNested(agent)) this.emit('change', this._entry(agent));
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
      if (upgraded) this.emit('change', this._entry(agent));
    }

    this._reconcileFollowers();
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
        this.emit('change', this._entry(a));
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
    };
    this._refreshStat(agent);
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
      this.emit('change', this._entry(agent));
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
      this.emit('change', this._entry(agent));
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
    const entry = this._entry(agent);
    this.emit('change', entry);
    return entry;
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
   * Status: done if the parent confirmed it (authoritative), otherwise inferred
   * from transcript freshness — a live sub-agent's file is actively appended; a
   * finished one goes static. This keeps historical sub-agents correctly "done"
   * even when their parent tool_result predates the bounded message buffer.
   */
  _statusFor(a) {
    const mtimeMs = a.mtimeMs ?? 0;
    if (!mtimeMs) return 'done';
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
