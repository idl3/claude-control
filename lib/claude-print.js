// lib/claude-print.js — Claude Code print-mode bridge transport.
//
// Keeps tmux as the visible session/pane pin while moving composer submission
// over a structured local socket to a bridge process that owns `claude -p`.

import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { parseRecord } from './transcript.js';

const CONNECT_TIMEOUT_MS = 10_000;
const MAX_MESSAGES = 4000;

function safeTargetName(target) {
  return String(target || 'session').replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

function lineOf(obj) {
  return `${JSON.stringify(obj)}\n`;
}

function textBlock(text) {
  return { kind: 'text', text: String(text ?? '') };
}

function normalizeClaudePrintEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'user' || event.type === 'assistant') {
    return parseRecord(JSON.stringify(event));
  }
  return null;
}

function eventSessionInfo(event) {
  if (!event || typeof event !== 'object') return null;
  const sessionId =
    typeof event.session_id === 'string' ? event.session_id :
      typeof event.sessionId === 'string' ? event.sessionId :
        null;
  const transcriptPath =
    typeof event.transcript_path === 'string' ? event.transcript_path :
      typeof event.transcriptPath === 'string' ? event.transcriptPath :
        typeof event.cwd_transcript_path === 'string' ? event.cwd_transcript_path :
          null;
  const model =
    typeof event.model === 'string' ? event.model :
      typeof event.message?.model === 'string' ? event.message.model :
        typeof event.data?.model === 'string' ? event.data.model :
          null;
  return sessionId || transcriptPath || model
    ? { sessionId, transcriptPath, model }
    : null;
}

export function buildBridgeCommand({
  nodeBin = process.execPath,
  bridgePath,
  socketPath,
  cwd,
  claudeBin,
  name,
  permissionMode = 'acceptEdits',
  quote,
} = {}) {
  if (!bridgePath) throw new Error('bridgePath is required');
  if (!socketPath) throw new Error('socketPath is required');
  if (!cwd) throw new Error('cwd is required');
  if (!claudeBin) throw new Error('claudeBin is required');
  const q = quote ?? ((s) => `'${String(s).replace(/'/g, `'\\''`)}'`);
  const args = [
    q(nodeBin),
    q(bridgePath),
    '--socket', q(socketPath),
    '--cwd', q(cwd),
    '--bin', q(claudeBin),
    '--permission-mode', q(permissionMode),
  ];
  if (name) args.push('--name', q(name));
  return args.join(' ');
}

export class ClaudePrintClient extends EventEmitter {
  constructor({ target, socketPath, cwd }) {
    super();
    this.target = target;
    this.socketPath = socketPath;
    this.cwd = cwd;
    this.server = null;
    this.socket = null;
    this.buffer = '';
    this.messages = [];
    this.sessionId = null;
    this.transcriptPath = null;
    this.model = null;
    this.ready = false;
    this.active = false;
    this.createdAt = Date.now();
    this._pendingConnect = null;
    this._resolveConnect = null;
    this._rejectConnect = null;
    this._lastAssistantDuringTurn = false;
  }

  async listen() {
    await fs.mkdir(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await fs.rm(this.socketPath, { force: true }).catch(() => {});
    this.server = net.createServer((socket) => this._attach(socket));
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server?.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.server?.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.socketPath);
    });
    this.server.unref?.();
    await fs.chmod(this.socketPath, 0o600).catch(() => {});
  }

  async waitForBridge(timeoutMs = CONNECT_TIMEOUT_MS) {
    if (this.ready && this.socket) return this;
    if (!this._pendingConnect) {
      this._pendingConnect = new Promise((resolve, reject) => {
        this._resolveConnect = resolve;
        this._rejectConnect = reject;
      });
    }
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out waiting for Claude print bridge ${this.socketPath}`)),
        timeoutMs,
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([this._pendingConnect, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  submit(text) {
    if (!this.socket || this.socket.destroyed) throw new Error('Claude print bridge is not connected');
    this._lastAssistantDuringTurn = false;
    this.socket.write(lineOf({ type: 'submit', text: String(text ?? '') }));
  }

  cancel() {
    if (!this.socket || this.socket.destroyed) throw new Error('Claude print bridge is not connected');
    this.socket.write(lineOf({ type: 'cancel' }));
  }

  close() {
    try { this.socket?.destroy(); } catch {}
    try { this.server?.close(); } catch {}
    this.socket = null;
    this.server = null;
    fs.rm(this.socketPath, { force: true }).catch(() => {});
  }

  threadInfo() {
    return {
      sessionId: this.sessionId,
      transcriptPath: this.transcriptPath,
      socketPath: this.socketPath,
      cwd: this.cwd,
      model: this.model,
    };
  }

  _attach(socket) {
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    this.socket = socket;
    socket.unref?.();
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this.emit('error', err));
    socket.on('close', () => {
      this.ready = false;
      this.active = false;
      this.emit('status', 'idle');
      this.emit('close');
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        this.emit('error', new Error(`invalid Claude print bridge JSON: ${err.message}`));
        continue;
      }
      this._onMessage(msg);
    }
  }

  _onMessage(msg) {
    if (msg.type === 'ready') {
      this.ready = true;
      if (this._resolveConnect) this._resolveConnect(this);
      this._pendingConnect = null;
      this._resolveConnect = null;
      this._rejectConnect = null;
      return;
    }

    if (msg.type === 'status') {
      this.active = msg.status === 'active';
      this.emit('status', this.active ? 'active' : 'idle');
      return;
    }

    if (msg.type === 'error') {
      this.emit('error', new Error(String(msg.error || 'Claude print bridge error')));
      return;
    }

    if (msg.type === 'event') {
      this._onClaudeEvent(msg.event);
    }
  }

  _onClaudeEvent(event) {
    const info = eventSessionInfo(event);
    if (info) {
      if (info.sessionId) this.sessionId = info.sessionId;
      if (info.transcriptPath) this.transcriptPath = info.transcriptPath;
      if (info.model) this.model = info.model;
      this.emit('thread', this.threadInfo());
    }

    const normalized = normalizeClaudePrintEvent(event);
    if (normalized) {
      if (normalized.role === 'assistant') this._lastAssistantDuringTurn = true;
      this._appendMessage(normalized);
      return;
    }

    if (event?.type === 'result') {
      if (event.session_id && !this.sessionId) this.sessionId = event.session_id;
      if (event.transcript_path && !this.transcriptPath) this.transcriptPath = event.transcript_path;
      this.emit('thread', this.threadInfo());
      const result = typeof event.result === 'string' ? event.result : '';
      if (result.trim() && !this._lastAssistantDuringTurn) {
        this._appendMessage({
          uuid: event.uuid || `claude-print-result-${Date.now()}`,
          role: 'assistant',
          ts: event.timestamp || Date.now(),
          blocks: [textBlock(result)],
          rawType: 'claude_print_result',
        });
      }
    }
  }

  _appendMessage(msg) {
    this.messages.push(msg);
    if (this.messages.length > MAX_MESSAGES) {
      this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    }
    this.emit('messages', [msg]);
  }
}

export class ClaudePrintManager extends EventEmitter {
  constructor({ socketDir = path.join(os.homedir(), '.claude-control', 'claude-print') } = {}) {
    super();
    this.socketDir = socketDir;
    this.clients = new Map();
  }

  endpointFor(target) {
    return path.join(this.socketDir, `${safeTargetName(target)}.sock`);
  }

  async attach({ target, socketPath = this.endpointFor(target), cwd }) {
    const existing = this.clients.get(target);
    if (existing) existing.close();
    const client = new ClaudePrintClient({ target, socketPath, cwd });
    this._bind(client);
    await client.listen();
    this.clients.set(target, client);
    return client;
  }

  get(target) {
    return this.clients.get(target) || null;
  }

  has(target) {
    return this.clients.has(target);
  }

  messages(target) {
    return this.get(target)?.messages ?? [];
  }

  prompt() {
    return null;
  }

  threadInfo(target) {
    return this.get(target)?.threadInfo() ?? null;
  }

  submit(target, text) {
    const client = this.get(target);
    if (!client) throw new Error('Claude print bridge is not attached');
    return client.submit(text);
  }

  cancel(target) {
    const client = this.get(target);
    if (!client) throw new Error('Claude print bridge is not attached');
    return client.cancel();
  }

  sweep(validTargets, { graceMs = 30_000 } = {}) {
    const valid = new Set(validTargets || []);
    const now = Date.now();
    for (const [target, client] of this.clients) {
      if (valid.has(target)) continue;
      if (now - client.createdAt < graceMs) continue;
      client.close();
      this.clients.delete(target);
    }
  }

  _bind(client) {
    client.on('messages', (messages) => this.emit('messages', client.target, messages));
    client.on('thread', (thread) => this.emit('thread', client.target, thread));
    client.on('status', (status) => this.emit('status', client.target, status));
    client.on('error', (err) => this.emit('error', client.target, err));
    client.on('close', () => this.emit('close', client.target));
  }
}
