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
// bounded message buffer). Live sub-agents append continuously.
const RUNNING_WINDOW_MS = 45_000;

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
      const m = META_RE.exec(name);
      if (!m) continue;
      const agentId = m[1];
      if (this._agents.has(agentId)) continue;
      this._track(agentId);
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
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) || {};
    } catch {
      return; // meta not readable yet — a later poll retries
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
    if (a.doneByParent) return 'done';
    try {
      const mtimeMs = fs.statSync(a.jsonlPath).mtimeMs;
      return Date.now() - mtimeMs < RUNNING_WINDOW_MS ? 'running' : 'done';
    } catch {
      return 'done';
    }
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
