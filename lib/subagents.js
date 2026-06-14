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
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { TranscriptTailer } from './transcript.js';

const META_RE = /^agent-(.+)\.meta\.json$/;

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
   * its toolUseId). Idempotent.
   * @param {string} toolUseId
   */
  markDone(toolUseId) {
    for (const a of this._agents.values()) {
      if (a.toolUseId === toolUseId && a.status !== 'done') {
        a.status = 'done';
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
      toolUseId: meta.toolUseId ?? null,
      agentType: meta.agentType ?? null,
      description: meta.description ?? null,
      status: 'running',
      tailer,
    };
    this._agents.set(agentId, agent);

    tailer.on('append', () => this.emit('change', this._entry(agent)));
    tailer.on('error', () => {}); // best-effort; a missing file just yields no messages
    tailer
      .start()
      .then(() => this.emit('change', this._entry(agent)))
      .catch(() => {});
  }

  _entry(a) {
    return {
      agentId: a.agentId,
      toolUseId: a.toolUseId,
      agentType: a.agentType,
      description: a.description,
      status: a.status,
      messages: a.tailer ? a.tailer.getMessages() : [],
    };
  }
}
