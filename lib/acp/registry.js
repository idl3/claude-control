/**
 * ACP session source. Holds live AcpRuntime instances and publishes
 * Session-shaped rows into SessionRegistry.setAcpSessions.
 */
import { EventEmitter } from 'node:events';
import { makeAcpId } from './ids.js';
import { AcpRuntime } from './runtime.js';
import { mergeNormalized } from './mapper.js';
import { buildGrokSpawn, grokAuthMethodId } from './adapters/grok.js';
import { buildCodexAcpSpawn } from './adapters/codex.js';
import { buildClaudeAcpSpawn } from './adapters/claude.js';
import { writeMeta, writeHistory, readHistory, listMetas, removeSession } from './store.js';

const MAX_LIVE = 8;

export class AcpRegistry extends EventEmitter {
  /**
   * @param {{
   *   sessionRegistry: { setAcpSessions: Function, setThinking?: Function, setPending?: Function },
   *   skipPermissions?: boolean,
   *   grokBin?: string,
   *   codexAcpBin?: string,
   *   claudeAcpBin?: string,
   *   createRuntime?: (opts: object) => AcpRuntime,
   *   dataDir?: string | null,
   * }} opts
   */
  constructor(opts) {
    super();
    this._sessionRegistry = opts.sessionRegistry;
    this._skipPermissions = !!opts.skipPermissions;
    this._grokBin = opts.grokBin;
    this._codexAcpBin = opts.codexAcpBin;
    this._claudeAcpBin = opts.claudeAcpBin;
    this._dataDir = opts.dataDir || null;
    this._createRuntime = opts.createRuntime || ((o) => new AcpRuntime(o));
    /** @type {Map<string, { row: object, runtime: AcpRuntime, messages: object[], pending: object|null }>} */
    this._entries = new Map();
  }

  get(id) {
    return this._entries.get(id) || null;
  }

  rows() {
    return [...this._entries.values()].map((e) => e.row);
  }

  publish() {
    this._sessionRegistry.setAcpSessions(this.rows());
  }

  /**
   * @param {{
   *   kind: 'grok'|'codex'|'claude',
   *   cwd: string,
   *   name?: string,
   *   prompt?: string,
   *   model?: string | null,
   *   skipPermissions?: boolean,
   *   resumeSessionId?: string | null,
   * }} opts
   */
  async create(opts) {
    const kind = opts.kind === 'codex' || opts.kind === 'claude' ? opts.kind : 'grok';
    if (this._liveCount() >= MAX_LIVE) {
      throw new Error(`ACP live-session cap (${MAX_LIVE}) reached — disconnect one first`);
    }
    const skip = opts.skipPermissions ?? this._skipPermissions;
    const spawn = kind === 'codex'
      ? buildCodexAcpSpawn({ binaryPath: this._codexAcpBin, skipPermissions: skip })
      : kind === 'claude'
        ? buildClaudeAcpSpawn({ binaryPath: this._claudeAcpBin, model: opts.model, skipPermissions: skip })
        : buildGrokSpawn({ binaryPath: this._grokBin, model: opts.model, skipPermissions: skip });
    const runtime = this._createRuntime({
      command: spawn.command,
      args: spawn.args,
      cwd: opts.cwd,
      env: spawn.env,
      skipPermissions: skip,
      authMethodId: kind === 'grok' ? grokAuthMethodId() : null,
      initialModeId: spawn.initialModeId || null,
    });
    const id = makeAcpId(kind);
    const name = opts.name || `acp-${id.slice(-8)}`;
    const now = new Date().toISOString();
    const entry = {
      runtime,
      messages: [],
      pending: null,
      skipPermissions: skip,
      row: {
        id,
        kind,
        transport: 'acp',
        pending: false,
        name,
        title: name,
        sessionName: name,
        sessionId: null,
        cwd: opts.cwd,
        lastActivity: now,
        lastActivityMs: Date.now(),
        thinking: false,
        model: opts.model || null,
      },
    };
    this._bindRuntime(id, entry);
    this._entries.set(id, entry);
    try {
      await runtime.start({ resumeSessionId: opts.resumeSessionId || null });
      entry.row.sessionId = runtime.sessionId;
      await this._persist(entry);
      this.publish();
      if (opts.prompt) {
        await this.prompt(id, opts.prompt);
      }
      return entry.row;
    } catch (err) {
      await runtime.shutdown().catch(() => {});
      this._entries.delete(id);
      this.publish();
      throw err;
    }
  }

  /** Rehydrate disconnected rows from disk (no live process until next prompt). */
  async restore() {
    if (!this._dataDir) return;
    const metas = await listMetas(this._dataDir);
    for (const meta of metas) {
      if (!meta?.id || this._entries.has(meta.id)) continue;
      const messages = await readHistory(this._dataDir, meta.id).catch(() => []);
      const entry = {
        runtime: null,
        messages,
        pending: null,
        disconnected: true,
        row: {
          id: meta.id,
          kind: meta.kind || 'grok',
          transport: 'acp',
          pending: false,
          name: meta.name || meta.id,
          title: meta.name || meta.id,
          sessionName: meta.name || meta.id,
          sessionId: meta.sessionId || null,
          cwd: meta.cwd,
          lastActivity: meta.lastActivity || null,
          lastActivityMs: meta.lastActivityMs || null,
          thinking: false,
          model: meta.model || null,
        },
        skipPermissions: !!meta.skipPermissions,
      };
      this._entries.set(meta.id, entry);
    }
    this.publish();
  }

  async prompt(id, text) {
    const entry = this._entries.get(id);
    if (!entry) throw new Error('unknown ACP session');
    const run = (entry.chain || Promise.resolve()).catch(() => {});
    const next = run.then(() => this._promptLocked(entry, text));
    entry.chain = next.catch(() => {});
    return next;
  }

  async _promptLocked(entry, text) {
    const needsReconnect = !entry.runtime
      || entry.runtime.status === 'exited'
      || entry.runtime.status === 'errored';
    if (needsReconnect) {
      if (entry.runtime) await entry.runtime.shutdown().catch(() => {});
      entry.runtime = null;
      await this._reconnect(entry);
    }
    entry.row.thinking = true;
    this._sessionRegistry.setThinking?.(entry.row.id, true);
    this.publish();
    try {
      const result = await entry.runtime.prompt(text);
      await this._persist(entry);
      return result;
    } finally {
      entry.row.thinking = false;
      entry.row.lastActivity = new Date().toISOString();
      entry.row.lastActivityMs = Date.now();
      this._sessionRegistry.setThinking?.(entry.row.id, false);
      this.publish();
    }
  }

  async cancel(id) {
    const entry = this._entries.get(id);
    if (!entry?.runtime) return { cancelled: false, reason: 'no session' };
    const result = await entry.runtime.cancel();
    entry.row.thinking = false;
    this._sessionRegistry.setThinking?.(id, false);
    this.publish();
    return result;
  }

  async disconnect(id, { forget = false } = {}) {
    const entry = this._entries.get(id);
    if (!entry) return;
    if (entry.runtime) await entry.runtime.shutdown().catch(() => {});
    entry.pending = null;
    entry.row.pending = false;
    this._sessionRegistry.setPending?.(id, false);
    if (forget) {
      this._entries.delete(id);
      if (this._dataDir) await removeSession(this._dataDir, id).catch(() => {});
    } else {
      entry.runtime = null;
      entry.disconnected = true;
      await this._persist(entry);
    }
    this.publish();
  }

  async _reconnect(entry) {
    const kind = entry.row.kind === 'codex' ? 'codex' : 'grok';
    const skip = entry.skipPermissions ?? this._skipPermissions;
    const spawn = kind === 'codex'
      ? buildCodexAcpSpawn({ binaryPath: this._codexAcpBin, skipPermissions: skip })
      : buildGrokSpawn({ binaryPath: this._grokBin, model: entry.row.model, skipPermissions: skip });
    const runtime = this._createRuntime({
      command: spawn.command,
      args: spawn.args,
      cwd: entry.row.cwd,
      env: spawn.env,
      skipPermissions: skip,
      authMethodId: kind === 'grok' ? grokAuthMethodId() : null,
    });
    entry.runtime = runtime;
    entry.disconnected = false;
    entry.pending = null;
    entry.row.pending = false;
    this._sessionRegistry.setPending?.(entry.row.id, false);
    this._bindRuntime(entry.row.id, entry);
    await runtime.start({ resumeSessionId: entry.row.sessionId || null });
    entry.row.sessionId = runtime.sessionId;
  }

  async _persist(entry) {
    if (!this._dataDir) return;
    const row = entry.row;
    await writeMeta(this._dataDir, row.id, {
      id: row.id,
      kind: row.kind,
      name: row.name,
      sessionId: row.sessionId,
      cwd: row.cwd,
      model: row.model,
      lastActivity: row.lastActivity,
      lastActivityMs: row.lastActivityMs,
      skipPermissions: !!entry.skipPermissions,
    });
    await writeHistory(this._dataDir, row.id, entry.messages);
  }

  async shutdownAll() {
    const ids = [...this._entries.keys()];
    await Promise.all(ids.map((id) => this.disconnect(id).catch(() => {})));
  }

  tailerFor(id) {
    const entry = this._entries.get(id);
    if (!entry) return null;
    const ee = new EventEmitter();
    const onAppend = (msgs) => ee.emit('append', msgs);
    const onPending = (pending) => ee.emit('pending', pending);
    this.on(`append:${id}`, onAppend);
    this.on(`pending:${id}`, onPending);
    return {
      filePath: null,
      getMessages: () => entry.messages,
      getPending: () => entry.pending,
      start: async () => {},
      stop: () => {
        this.off(`append:${id}`, onAppend);
        this.off(`pending:${id}`, onPending);
      },
      on: ee.on.bind(ee),
      off: ee.off.bind(ee),
    };
  }

  _liveCount() {
    return [...this._entries.values()].filter((e) => e.runtime && e.runtime.status !== 'exited').length;
  }

  _bindRuntime(id, entry) {
    if (!entry.runtime) return;
    entry.runtime.on('append', (msgs) => {
      entry.messages = mergeNormalized(entry.messages, msgs);
      entry.row.lastActivity = new Date().toISOString();
      entry.row.lastActivityMs = Date.now();
      this.emit(`append:${id}`, msgs);
      this.emit('append', id, msgs);
    });
    entry.runtime.on('permission', (p) => {
      const pending = permissionToPending(p);
      entry.pending = pending;
      entry.row.pending = !!pending;
      this._sessionRegistry.setPending?.(id, !!pending);
      this.emit(`pending:${id}`, pending);
    });
    entry.runtime.on('exit', () => {
      entry.row.thinking = false;
      this.publish();
    });
  }
}

function permissionToPending(p) {
  const params = p?.params || {};
  const tool = params.toolCall || {};
  const options = Array.isArray(params.options) ? params.options : [];
  return {
    toolUseId: p.requestId,
    ts: new Date().toISOString(),
    questions: [{
      question: tool.title || params.title || 'Allow this action?',
      header: 'Permission',
      multiSelect: false,
      options: options.map((o) => ({
        label: o.name || o.optionId,
        description: o.kind || '',
        optionId: o.optionId,
      })),
    }],
  };
}
