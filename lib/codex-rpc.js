// lib/codex-rpc.js — experimental Codex app-server JSON-RPC transport.
//
// This keeps tmux as the visible process/session pin while moving actual Codex
// turn submission and approvals onto app-server's structured JSON-RPC channel.

import { EventEmitter } from 'node:events';
import net from 'node:net';
import { WebSocket } from 'ws';
import { parseCodexSubagentNotification } from './codex.js';

const REQUEST_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;
const LOCAL_WS_RE = /\bws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|::1):\d+\b/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function removeNullish(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v != null) out[k] = v;
  }
  return out;
}

function textFromContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part?.type === 'text' ? String(part.text ?? '') : ''))
    .filter(Boolean)
    .join('');
}

function truncate(s, n = 180) {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  return text.length > n ? `${text.slice(0, n - 1)}...` : text;
}

function inputSummary(input) {
  try {
    return truncate(JSON.stringify(input), 120);
  } catch {
    return truncate(String(input), 120);
  }
}

function promptForRequest(req) {
  const p = req.params || {};
  if (req.method === 'item/commandExecution/requestApproval') {
    const command = p.command || '(command unavailable)';
    const options = [
      { key: '1', label: 'Yes, proceed' },
    ];
    if (p.proposedExecpolicyAmendment || p.proposedNetworkPolicyAmendments?.length) {
      options.push({ key: '2', label: "Yes, and don't ask again" });
    } else {
      options.push({ key: '2', label: 'Yes for this session' });
    }
    options.push({ key: '3', label: 'No' });
    return {
      question: `Run command in ${p.cwd || 'the workspace'}?\n${command}${p.reason ? `\nReason: ${p.reason}` : ''}`,
      options,
    };
  }

  if (req.method === 'item/fileChange/requestApproval') {
    const target = p.grantRoot ? ` under ${p.grantRoot}` : '';
    return {
      question: `Allow file changes${target}?${p.reason ? `\nReason: ${p.reason}` : ''}`,
      options: [
        { key: '1', label: 'Yes, proceed' },
        { key: '2', label: 'Yes for this session' },
        { key: '3', label: 'No' },
      ],
    };
  }

  if (req.method === 'item/permissions/requestApproval') {
    return {
      question: `Allow additional permissions in ${p.cwd || 'the workspace'}?${p.reason ? `\nReason: ${p.reason}` : ''}`,
      options: [
        { key: '1', label: 'Yes, for this turn' },
        { key: '2', label: 'Yes, for this session' },
        { key: '3', label: 'No' },
      ],
    };
  }

  if (req.method === 'item/tool/requestUserInput') {
    const q = Array.isArray(p.questions) ? p.questions[0] : null;
    const opts = Array.isArray(q?.options) ? q.options : [];
    return {
      question: q?.question || q?.header || 'Codex is asking for input',
      options: opts.length
        ? opts.map((o, i) => ({ key: String(i + 1), label: o?.label || o?.value || `Option ${i + 1}` }))
        : [{ key: '1', label: 'Continue' }],
    };
  }

  return {
    question: `Codex request: ${req.method}`,
    options: [
      { key: '1', label: 'Continue' },
      { key: '3', label: 'Cancel' },
    ],
  };
}

function responseForPrompt(req, key) {
  const p = req.params || {};
  const denied = key === '3';
  const cancelled = key === 'Escape';
  const session = key === '2';

  if (req.method === 'item/commandExecution/requestApproval') {
    if (cancelled) return { decision: 'cancel' };
    if (denied) return { decision: 'decline' };
    if (session && p.proposedExecpolicyAmendment) {
      return {
        decision: {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: p.proposedExecpolicyAmendment,
          },
        },
      };
    }
    if (session && Array.isArray(p.proposedNetworkPolicyAmendments) && p.proposedNetworkPolicyAmendments[0]) {
      return {
        decision: {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: p.proposedNetworkPolicyAmendments[0],
          },
        },
      };
    }
    return { decision: session ? 'acceptForSession' : 'accept' };
  }

  if (req.method === 'item/fileChange/requestApproval') {
    if (cancelled) return { decision: 'cancel' };
    if (denied) return { decision: 'decline' };
    return { decision: session ? 'acceptForSession' : 'accept' };
  }

  if (req.method === 'item/permissions/requestApproval') {
    if (cancelled || denied) return { permissions: {}, scope: 'turn' };
    return {
      permissions: removeNullish({
        network: p.permissions?.network ?? null,
        fileSystem: p.permissions?.fileSystem ?? null,
      }),
      scope: session ? 'session' : 'turn',
    };
  }

  if (req.method === 'item/tool/requestUserInput') {
    const questions = Array.isArray(p.questions) ? p.questions : [];
    const first = questions[0];
    const options = Array.isArray(first?.options) ? first.options : [];
    const idx = Math.max(0, Number(key) - 1);
    const selected = options[idx];
    const questionId = first?.id || first?.question || 'answer';
    return {
      answers: {
        [questionId]: {
          answers: [String(selected?.label ?? selected?.value ?? selected ?? '')],
        },
      },
    };
  }

  return {};
}

function normalizeServerMessage(msg) {
  if (msg?.id == null || typeof msg.method !== 'string') return null;
  return msg;
}

export async function codexRpcEndpoint() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : null;
      server.close(() => {
        if (!port) reject(new Error('failed to allocate Codex RPC port'));
        else resolve(`ws://127.0.0.1:${port}`);
      });
    });
  });
}

export function parseCodexAppServerEndpoint(text) {
  const m = LOCAL_WS_RE.exec(String(text || ''));
  return m ? m[0] : null;
}

export function isCodexAppServerCapture(text) {
  const s = String(text || '');
  return !!parseCodexAppServerEndpoint(s) ||
    /\bcodex\s+app-server\b/i.test(s) ||
    /\bapp-server\s+--listen\b/i.test(s) ||
    /\breadyz:\s*https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|::1):\d+\/readyz\b/i.test(s) ||
    /\bhealthz:\s*https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|::1):\d+\/healthz\b/i.test(s);
}

const ACTIVE_STATUS_RE = /^(active|running|busy|working|thinking|processing|generating|streaming|executing|in[-_ ]?progress|started|starting)$/i;
const IDLE_STATUS_RE = /^(idle|inactive|sleeping|complete|completed|done|finished|stopped|ready)$/i;

function classifyStatusValue(value) {
  if (value == null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return false;
    if (IDLE_STATUS_RE.test(s)) return false;
    if (ACTIVE_STATUS_RE.test(s)) return true;
    return null;
  }
  if (Array.isArray(value)) {
    let sawIdle = false;
    for (const item of value) {
      const classified = classifyStatusValue(item);
      if (classified === true) return true;
      if (classified === false) sawIdle = true;
    }
    return sawIdle ? false : null;
  }
  if (typeof value === 'object') {
    if (
      value.active === true ||
      value.running === true ||
      value.busy === true ||
      value.working === true ||
      value.thinking === true
    ) {
      return true;
    }
    if (
      value.idle === true ||
      value.sleeping === true ||
      value.done === true ||
      value.complete === true ||
      value.completed === true
    ) {
      return false;
    }

    let sawIdle = false;
    for (const key of ['type', 'status', 'state', 'phase', 'kind', 'name']) {
      if (!(key in value)) continue;
      const classified = classifyStatusValue(value[key]);
      if (classified === true) return true;
      if (classified === false) sawIdle = true;
    }
    return sawIdle ? false : null;
  }
  return null;
}

export function isCodexActiveStatus(status) {
  return classifyStatusValue(status) === true;
}

function recoverableResumeError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('state db missing rollout path for thread') ||
    msg.includes('state db record_discrepancy') ||
    msg.includes('thread not found') ||
    msg.includes('no such thread') ||
    msg.includes('rollout path') ||
    msg.includes('not found')
  );
}

function pathResumeFieldError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('path') && (
    msg.includes('unknown field') ||
    msg.includes('invalid params') ||
    msg.includes('invalid request') ||
    msg.includes('unexpected')
  );
}

export class CodexRpcClient extends EventEmitter {
  constructor({ target, endpoint, cwd, resumeThreadId = null, transcriptPath = null, model = null }) {
    super();
    this.target = target;
    this.endpoint = endpoint;
    this.cwd = cwd;
    this.resumeThreadId = resumeThreadId || null;
    this.transcriptPath = transcriptPath || null;
    // Only applied to a fresh thread/start below — a thread/resume keeps
    // whatever model the resumed thread was already using.
    this.model = model || null;
    this.threadId = null;
    this.threadPath = null;
    this.ws = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.messages = [];
    this.currentPrompt = null;
    this.currentRequest = null;
    this.serverRequests = new Map();
    this._closed = true;
  }

  isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect() {
    const started = Date.now();
    let lastErr = null;
    while (Date.now() - started < CONNECT_TIMEOUT_MS) {
      try {
        await this._connectOnce();
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await sleep(150);
      }
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw lastErr || new Error(`timed out connecting to Codex app-server ${this.endpoint}`);
    }

    await this.request('initialize', {
      clientInfo: {
        name: 'claude-control',
        title: 'claude-control',
        version: '1.2.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });

    const openedThread = await this._openThread();
    this.threadId = openedThread?.thread?.id || this.resumeThreadId || null;
    this.threadPath = openedThread?.thread?.path || this.transcriptPath || null;
    if (!this.threadId) throw new Error('Codex app-server did not return a thread id');
    this.emit('thread', {
      ...openedThread,
      thread: {
        ...(openedThread?.thread || {}),
        id: this.threadId,
        path: this.threadPath,
      },
    });
  }

  async _openThread() {
    const startParams = removeNullish({
      cwd: this.cwd,
      ephemeral: false,
      threadSource: 'user',
      sessionStartSource: 'startup',
      model: this.model,
    });
    const resumeParams = {
      cwd: this.cwd,
    };

    if (this.resumeThreadId || this.transcriptPath) {
      try {
        return await this.request('thread/resume', removeNullish({
          ...resumeParams,
          threadId: this.resumeThreadId || '',
          path: this.transcriptPath,
        }));
      } catch (err) {
        if (this.resumeThreadId && this.transcriptPath && pathResumeFieldError(err)) {
          return this.request('thread/resume', {
            ...resumeParams,
            threadId: this.resumeThreadId,
          });
        }
        if (!recoverableResumeError(err)) throw err;
        if (this.listenerCount('error') > 0) {
          this.emit('error', new Error(`Codex RPC resume failed; starting a fresh thread: ${err.message}`));
        }
      }
    }

    return this.request('thread/start', startParams);
  }

  _connectOnce() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.endpoint);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`timed out connecting to Codex app-server ${this.endpoint}`));
      }, CONNECT_TIMEOUT_MS);
      ws.once('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        this._closed = false;
        this._attachSocket(ws);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  close() {
    try {
      this.ws?.close();
      this.ws?.terminate();
    } catch {
      // best effort
    }
    this._handleClose(this.ws);
  }

  async submit(text, { cwd = this.cwd } = {}) {
    if (!this.threadId) throw new Error('Codex RPC thread is not ready');
    return this.request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: String(text ?? ''), text_elements: [] }],
      cwd,
    });
  }

  threadInfo() {
    return {
      threadId: this.threadId,
      transcriptPath: this.threadPath,
      endpoint: this.endpoint,
      cwd: this.cwd,
    };
  }

  answerPrompt(key) {
    if (!this.currentRequest) throw new Error('no Codex RPC prompt is pending');
    const req = this.currentRequest;
    const result = responseForPrompt(req, key);
    this.emit('raw', {
      source: 'codex-rpc',
      direction: 'out',
      kind: 'prompt-answer',
      method: req.method,
      requestId: req.id,
      summary: `answer ${key}`,
      payload: { id: req.id, result },
    });
    this._send({ id: req.id, result });
    this.serverRequests.delete(req.id);
    this._activateNextRequest();
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++;
    this._send({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
    });
  }

  _attachSocket(ws) {
    ws.on('message', (data) => this._onData(`${data.toString()}\n`));
    ws.on('error', (err) => this.emit('error', err));
    ws.on('close', () => this._handleClose(ws));
  }

  _handleClose(ws = this.ws) {
    if (ws && this.ws && ws !== this.ws) return;
    if (this._closed) return;
    this._closed = true;
    const err = new Error('Codex RPC WebSocket closed');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
    this.ws = null;
    this.buffer = '';
    this.serverRequests.clear();
    this.currentRequest = null;
    this.currentPrompt = null;
    this.emit('prompt', null);
    this.emit('pending', false);
    this.emit('close');
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Codex RPC WebSocket is closed');
    this.emit('raw', {
      source: 'codex-rpc',
      direction: 'out',
      kind: obj.method ? 'request' : 'response',
      method: obj.method ?? null,
      requestId: obj.id ?? null,
      summary: obj.method ? `${obj.method} ${inputSummary(obj.params ?? {})}` : `response ${obj.id ?? ''}`.trim(),
      payload: obj,
    });
    this.ws.send(JSON.stringify(obj));
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
        this.emit('error', new Error(`invalid Codex RPC JSON: ${err.message}`));
        continue;
      }
      this._onMessage(msg);
    }
  }

  _onMessage(msg) {
    this.emit('raw', {
      source: 'codex-rpc',
      direction: 'in',
      kind: typeof msg.method === 'string' ? 'request-or-notification' : 'response',
      method: msg.method ?? null,
      requestId: msg.id ?? null,
      summary: msg.method
        ? `${msg.method} ${inputSummary(msg.params ?? {})}`
        : msg.error
          ? `error ${msg.error.message || msg.id || ''}`.trim()
          : `response ${msg.id ?? ''}`.trim(),
      payload: msg,
    });

    if (typeof msg.method === 'string') {
      const serverRequest = normalizeServerMessage(msg);
      if (serverRequest) {
        this.serverRequests.set(serverRequest.id, serverRequest);
        if (!this.currentRequest) this._activateNextRequest();
        return;
      }
      this._onNotification(msg.method, msg.params || {});
      return;
    }

    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(msg.error.message || `${p.method} failed`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
  }

  _onNotification(method, params) {
    if (method === 'serverRequest/resolved') {
      const requestId = params?.id ?? params?.requestId ?? params?.request_id ?? null;
      if (requestId != null) this.serverRequests.delete(requestId);
      else this.serverRequests.clear();
      if (this.currentRequest && (requestId == null || this.currentRequest.id === requestId)) {
        this._activateNextRequest();
      } else {
        this.emit('pending', this.serverRequests.size > 0);
      }
      return;
    }

    if (method === 'thread/status/changed') {
      this.emit('status', params.status || null);
      return;
    }

    if (method !== 'item/completed') return;
    const item = params.item || {};
    const ts = Number(params.completedAtMs || Date.now());

    if (item.type === 'userMessage') {
      const text = textFromContent(item.content);
      if (!text) return;
      this._appendMessage({
        uuid: item.id || `rpc-user-${ts}`,
        role: 'user',
        ts,
        blocks: [{ kind: 'text', text }],
        rawType: 'rpc_userMessage',
      });
      return;
    }

    if (item.type === 'agentMessage') {
      const text = String(item.text || '');
      if (!text.trim()) return;
      const subagent = parseCodexSubagentNotification(text);
      if (subagent) {
        this.emit('subagent', subagent);
        this.emit('raw', {
          source: 'codex-rpc',
          direction: 'in',
          kind: 'subagent',
          method,
          requestId: null,
          summary: `${subagent.agentId} ${subagent.state}`,
        });
        return;
      }
      this._appendMessage({
        uuid: item.id || `rpc-agent-${ts}`,
        role: 'assistant',
        ts,
        blocks: [{ kind: 'text', text }],
        rawType: 'rpc_agentMessage',
      });
      return;
    }

    if (item.type === 'functionCall' || item.type === 'customToolCall') {
      const id = item.callId || item.call_id || item.id || `rpc-tool-${ts}`;
      const input = item.arguments ?? item.input ?? {};
      this._appendMessage({
        uuid: id,
        role: 'assistant',
        ts,
        blocks: [{
          kind: 'tool_use',
          id,
          name: item.name || item.type,
          input,
          inputSummary: inputSummary(input),
        }],
        rawType: `rpc_${item.type}`,
      });
    }
  }

  _appendMessage(msg) {
    this.messages.push(msg);
    if (this.messages.length > 4000) this.messages.splice(0, this.messages.length - 4000);
    this.emit('messages', [msg]);
  }

  _activateNextRequest() {
    const next = this.serverRequests.values().next().value || null;
    this.currentRequest = next;
    this.currentPrompt = next ? promptForRequest(next) : null;
    this.emit('prompt', this.currentPrompt);
    this.emit('pending', !!next);
  }
}

export class CodexRpcManager extends EventEmitter {
  constructor() {
    super();
    this.clients = new Map();
  }

  async prepareEndpoint() {
    return codexRpcEndpoint();
  }

  async attach({ target, endpoint, cwd, resumeThreadId = null, transcriptPath = null, model = null }) {
    const existing = this.clients.get(target);
    if (existing) existing.close();
    const client = new CodexRpcClient({ target, endpoint, cwd, resumeThreadId, transcriptPath, model });
    this._bind(client);
    try {
      await client.connect();
    } catch (err) {
      client.close();
      throw err;
    }
    this.clients.set(target, client);
    return client;
  }

  async ensureAttached({ target, endpoint, cwd, resumeThreadId = null, transcriptPath = null }) {
    const existing = this.clients.get(target);
    if (existing?.isOpen() && existing.endpoint === endpoint) return existing;
    if (existing) {
      existing.close();
      this.clients.delete(target);
    }
    return this.attach({ target, endpoint, cwd, resumeThreadId, transcriptPath });
  }

  has(target) {
    return !!this.clients.get(target)?.isOpen();
  }

  get(target) {
    const client = this.clients.get(target) || null;
    return client?.isOpen() ? client : null;
  }

  messages(target) {
    return this.get(target)?.messages ?? [];
  }

  prompt(target) {
    return this.get(target)?.currentPrompt ?? null;
  }

  threadInfo(target) {
    return this.get(target)?.threadInfo() ?? null;
  }

  async submit(target, text, opts = {}) {
    const client = this.get(target);
    if (!client) throw new Error('Codex RPC client is not attached');
    return client.submit(text, opts);
  }

  answerPrompt(target, key) {
    const client = this.get(target);
    if (!client) throw new Error('Codex RPC client is not attached');
    return client.answerPrompt(key);
  }

  sweep(validTargets) {
    const valid = new Set(validTargets || []);
    for (const [target, client] of this.clients) {
      if (valid.has(target)) continue;
      client.close();
      this.clients.delete(target);
    }
  }

  _bind(client) {
    client.on('messages', (messages) => this.emit('messages', client.target, messages));
    client.on('thread', (thread) => this.emit('thread', client.target, thread));
    client.on('prompt', (prompt) => this.emit('prompt', client.target, prompt));
    client.on('pending', (pending) => this.emit('pending', client.target, pending));
    client.on('status', (status) => this.emit('status', client.target, status));
    client.on('subagent', (subagent) => this.emit('subagent', client.target, subagent));
    client.on('raw', (event) => this.emit('raw', client.target, event));
    client.on('error', (err) => this.emit('error', client.target, err));
    client.on('close', () => {
      // A replaced client's socket can finish closing after its successor is
      // already installed for the same tmux target. Ignore that stale event so
      // server-level teardown cannot clear the successor's prompt/thread state.
      if (this.clients.get(client.target) !== client) return;
      this.clients.delete(client.target);
      this.emit('close', client.target);
    });
  }
}
