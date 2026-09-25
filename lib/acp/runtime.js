/**
 * ACP session runtime: handshake, session/new|load, prompt, cancel, hosts.
 */
import { EventEmitter } from 'node:events';
import { spawnAcpProcess } from './jsonrpc.js';
import { createFsHost } from './hosts/fs.js';
import { createTerminalHost } from './hosts/terminal.js';
import { createPermissionHost } from './hosts/permission.js';
import { AcpMapper, userMessage } from './mapper.js';

const PROTOCOL_VERSION = 1;

export class AcpRuntime extends EventEmitter {
  /**
   * @param {{
   *   command: string,
   *   args?: string[],
   *   cwd: string,
   *   env?: NodeJS.ProcessEnv,
   *   skipPermissions?: boolean,
   *   extraRoots?: string[],
   *   authMethodId?: string | null,
   *   initialModeId?: string | null,
   *   clientInfo?: { name: string, version: string },
   * }} opts
   */
  constructor(opts) {
    super();
    this.cwd = opts.cwd;
    this._spawn = {
      command: opts.command,
      args: opts.args || [],
      cwd: opts.cwd,
      env: opts.env,
    };
    this._authMethodId = opts.authMethodId ?? null;
    this._initialModeId = opts.initialModeId ?? null;
    this._clientInfo = opts.clientInfo || { name: 'claude-control', version: '0' };
    this.rpc = null;
    this.sessionId = null;
    this.handshake = null;
    this.status = 'idle';
    this.mapper = new AcpMapper();
    this.fsHost = createFsHost({
      getCwd: () => this.cwd,
      extraRoots: opts.extraRoots || [],
    });
    this.terminalHost = createTerminalHost({ getCwd: () => this.cwd });
    this.permissionHost = createPermissionHost({ skipPermissions: !!opts.skipPermissions });
    this.permissionHost.setOnPending((p) => this.emit('permission', p));
  }

  async start({ resumeSessionId = null } = {}) {
    this.status = 'starting';
    this.rpc = spawnAcpProcess(this._spawn);
    this.rpc.on('stderr', (s) => this.emit('stderr', s));
    this.rpc.on('exit', (info) => {
      this.status = 'exited';
      this.terminalHost.shutdownAll();
      this.emit('exit', info);
    });
    this.rpc.on('notification', ({ method, params }) => {
      if (method === 'session/update') {
        const msgs = this.mapper.applyUpdate(params);
        if (msgs.length) this.emit('append', msgs);
        this.emit('update', params);
      } else {
        this.emit('notification', { method, params });
      }
    });
    this.rpc.setRequestHandler((method, params) => this._dispatch(method, params));

    this.handshake = await this.rpc.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: this._clientInfo,
    });
    this.emit('handshake', this.handshake);

    const authMethods = this.handshake?.authMethods;
    const methodId = this._authMethodId
      || (Array.isArray(authMethods) && authMethods[0]?.id)
      || null;
    if (methodId && methodId !== 'none') {
      await this.rpc.request('authenticate', { methodId });
    }

    const canLoad = !!this.handshake?.agentCapabilities?.loadSession;
    if (resumeSessionId && canLoad) {
      try {
        await this.rpc.request('session/load', {
          sessionId: resumeSessionId,
          cwd: this.cwd,
          mcpServers: [],
        });
        this.sessionId = resumeSessionId;
        this.status = 'idle';
        this.emit('session_ready', { sessionId: this.sessionId, resumed: true });
        return;
      } catch (err) {
        this.emit('stderr', `session/load failed (${err.message}); starting fresh\n`);
      }
    }

    const created = await this.rpc.request('session/new', {
      cwd: this.cwd,
      mcpServers: [],
    });
    if (!created?.sessionId) throw new Error('session/new did not return sessionId');
    this.sessionId = created.sessionId;
    if (this._initialModeId) {
      // ACP permission modes (e.g. claude-agent-acp 'bypassPermissions') are
      // set per session, not via spawn args. Best-effort: an agent without
      // modes just stays in its default and asks.
      try {
        await this.rpc.request('session/set_mode', { sessionId: this.sessionId, modeId: this._initialModeId });
      } catch (err) {
        this.emit('stderr', `session/set_mode ${this._initialModeId} failed (${err.message}); staying in default mode\n`);
      }
    }
    this.status = 'idle';
    this.emit('session_ready', { sessionId: this.sessionId, resumed: false });
  }

  async _dispatch(method, params) {
    switch (method) {
      case 'terminal/create':        return this.terminalHost.create(params);
      case 'terminal/output':        return this.terminalHost.output(params);
      case 'terminal/wait_for_exit': return this.terminalHost.waitForExit(params);
      case 'terminal/kill':          return this.terminalHost.kill(params);
      case 'terminal/release':       return this.terminalHost.release(params);
      case 'fs/read_text_file':      return this.fsHost.readTextFile(params);
      case 'fs/write_text_file':     return this.fsHost.writeTextFile(params);
      case 'session/request_permission':
        return this.permissionHost.requestPermission(params);
      default: {
        const err = new Error(`Method not found: ${method}`);
        err.rpc = { code: -32601, message: err.message };
        throw err;
      }
    }
  }

  /**
   * @param {string|unknown[]} textOrBlocks
   */
  async prompt(textOrBlocks) {
    if (!this.sessionId) throw new Error('session not ready');
    const prompt = Array.isArray(textOrBlocks)
      ? textOrBlocks
      : [{ type: 'text', text: String(textOrBlocks) }];
    const text = Array.isArray(textOrBlocks)
      ? textOrBlocks.map((b) => (b?.type === 'text' ? b.text : '')).join('')
      : String(textOrBlocks);
    const user = userMessage(text);
    this.emit('append', [user]);
    this.status = 'running';
    this.emit('status', { status: 'running' });
    try {
      const result = await this.rpc.request('session/prompt', {
        sessionId: this.sessionId,
        prompt,
      });
      this.mapper.flush();
      this.status = 'idle';
      this.emit('status', { status: 'idle' });
      this.emit('prompt_result', result);
      return result;
    } catch (err) {
      this.status = 'errored';
      this.emit('status', { status: 'errored', error: err.message });
      throw err;
    }
  }

  async cancel() {
    if (!this.sessionId || !this.rpc) return { cancelled: false, reason: 'no session' };
    try {
      this.rpc.notify('session/cancel', { sessionId: this.sessionId });
      return { cancelled: true };
    } catch (err) {
      return { cancelled: false, error: err.message };
    }
  }

  async shutdown() {
    this.permissionHost.cancelAll();
    this.terminalHost.shutdownAll();
    if (this.rpc) await this.rpc.close();
  }
}
