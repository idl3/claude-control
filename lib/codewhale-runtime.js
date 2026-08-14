// CodeWhale Runtime adapter.
//
// The public seam is deliberately small:
//   - CodeWhaleRuntimeClient owns HTTP/auth/SSE details.
//   - CodeWhaleRuntimeSessionSource publishes Session-shaped thread rows.
//   - CodeWhaleRuntimeTranscriptSource publishes normalized transcript changes.
//
// Runtime tokens stay in this server-only module. Browser-facing rows contain
// no base URL, token, raw system prompt, or provider credential material.

import { EventEmitter } from 'node:events';

export const CODEWHALE_RUNTIME_SOURCE = 'codewhale-runtime';
export const CODEWHALE_RUNTIME_SESSION_PREFIX = 'codewhale:runtime:';
const CODEWHALE_APPROVAL_PREFIX = 'codewhale-approval:';

const DEFAULT_BASE_URL = 'http://127.0.0.1:7878';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_MS = 1000;
const REQUIRED_CAPABILITIES = ['threads', 'event_replay'];

const ITEM_EVENT_NAMES = new Set([
  'item.started',
  'item.delta',
  'item.completed',
  'item.failed',
  'item.interrupted',
  'turn.started',
  'turn.lifecycle',
  'turn.completed',
  'approval.required',
  'approval.decided',
  'approval.timeout',
  'user_input.required',
  'user_input.answered',
  'user_input.canceled',
]);

class CursorGapError extends Error {}

function clip(value, max = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value || DEFAULT_BASE_URL));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('CodeWhale Runtime URL must use http or https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('CodeWhale Runtime URL must not contain credentials, query, or fragment');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function abortSignals(external, timeoutMs) {
  const controller = new AbortController();
  let timer = null;
  const onAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', onAbort, { once: true });
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(new Error('CodeWhale Runtime request timed out')), timeoutMs);
    timer.unref?.();
  }
  return {
    signal: controller.signal,
    cleanup() {
      if (timer) clearTimeout(timer);
      external?.removeEventListener?.('abort', onAbort);
    },
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function runtimeSessionId(threadId) {
  return `${CODEWHALE_RUNTIME_SESSION_PREFIX}${threadId}`;
}

export function threadIdFromRuntimeSession(id) {
  const value = String(id ?? '');
  return value.startsWith(CODEWHALE_RUNTIME_SESSION_PREFIX)
    ? value.slice(CODEWHALE_RUNTIME_SESSION_PREFIX.length)
    : null;
}

export function stripRuntimeInjectedContext(value) {
  return String(value ?? '')
    .replace(/<turn_meta>[\s\S]*?<\/turn_meta>/gi, '')
    .trim();
}

function itemText(item) {
  return stripRuntimeInjectedContext(item?.detail || item?.summary || '');
}

function itemTimestamp(item) {
  return item?.started_at || item?.ended_at || null;
}

function itemTimestampMs(item) {
  const parsed = Date.parse(itemTimestamp(item) || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function embeddedJson(value) {
  const text = String(value ?? '');
  const start = text.indexOf('{');
  if (start < 0) return null;
  return safeJson(text.slice(start));
}

function terminalItemStatus(status) {
  return ['completed', 'failed', 'interrupted', 'canceled'].includes(String(status || ''));
}

function runtimeToolName(item) {
  if (item.kind === 'command_execution') return 'exec_command';
  if (item.kind === 'file_change') return 'file_change';
  if (item.metadata?.tool_name || item.metadata?.name) {
    return item.metadata.tool_name || item.metadata.name;
  }
  const prefixed = String(item.summary || '').match(/^([A-Za-z_][\w.-]*):(?:\s|$)/);
  return prefixed?.[1] || 'tool';
}

function runtimeToolSummary(item, name) {
  const action = clip(item.metadata?.action || '', 40);
  if (name === 'agent' && action === 'start' && item.metadata?.agent_id) {
    return [action, item.metadata.agent_id, item.metadata.status].filter(Boolean).join(' · ');
  }
  if (name === 'agent' && action === 'wait') {
    const settled = Number(item.metadata?.settled);
    const running = Number(item.metadata?.running);
    return [
      'wait',
      Number.isFinite(settled) ? `${settled} settled` : null,
      Number.isFinite(running) ? `${running} running` : null,
    ].filter(Boolean).join(' · ');
  }
  return clip(item.summary || item.detail || name, 120);
}

function normalizeToolItem(threadId, item) {
  const name = runtimeToolName(item);
  const summary = runtimeToolSummary(item, name);
  const blocks = [{
    kind: 'tool_use',
    id: item.id,
    name,
    input: item.metadata || {},
    inputSummary: summary,
  }];
  if (terminalItemStatus(item.status)) {
    blocks.push({
      kind: 'tool_result',
      forId: item.id,
      text: itemText(item) || `${name} ${item.status}`,
      isError: item.status === 'failed' || item.status === 'interrupted',
    });
  }
  return {
    uuid: `codewhale:${threadId}:${item.id}`,
    role: 'assistant',
    ts: itemTimestamp(item),
    blocks,
    rawType: `codewhale:${item.kind}`,
  };
}

function normalizeRuntimeStatus(threadId, item, base, text, agentToolIds) {
  // Runtime lifecycle chatter is useful for transport diagnostics but is not
  // a conversational assistant message. CodeWhale already emits the actual
  // tool_call and agent_message items; projecting these status lines as text
  // creates duplicate, noisy transcript turns.
  const completion = text.match(/^Sub-agent\s+(\S+)\s+(completed|failed|canceled):\s*([\s\S]*)$/i);
  if (!completion) return null;

  const [, agentId, state, output] = completion;
  const forId = agentToolIds?.get(agentId);
  if (!forId) {
    // Fail closed rather than invent an orphan tool result that the frontend
    // cannot attach to a real tool call.
    return null;
  }
  return {
    ...base,
    role: 'assistant',
    blocks: [{
      kind: 'tool_result',
      forId,
      text: output.trim() || `Sub-agent ${agentId} ${state.toLowerCase()}`,
      isError: state.toLowerCase() !== 'completed',
    }],
  };
}

export function normalizeRuntimeItem(threadId, item, { agentToolIds } = {}) {
  if (!item?.id || !item?.kind) return null;
  const base = {
    uuid: `codewhale:${threadId}:${item.id}`,
    ts: itemTimestamp(item),
    rawType: `codewhale:${item.kind}`,
  };
  const text = itemText(item);
  switch (item.kind) {
    case 'user_message':
      return { ...base, role: 'user', blocks: [{ kind: 'text', text }] };
    case 'agent_message':
      return { ...base, role: 'assistant', blocks: [{ kind: 'text', text }] };
    case 'agent_reasoning':
      return { ...base, role: 'assistant', blocks: [{ kind: 'thinking', text }] };
    case 'tool_call':
    case 'command_execution':
    case 'file_change':
      return normalizeToolItem(threadId, item);
    case 'context_compaction':
      return {
        ...base,
        role: 'assistant',
        blocks: [{ kind: 'text', text: text || clip(item.summary || item.kind) }],
      };
    case 'status':
      return normalizeRuntimeStatus(threadId, item, base, text, agentToolIds);
    case 'error':
      return {
        ...base,
        role: 'assistant',
        blocks: [{ kind: 'text', text: text ? `Error: ${text}` : 'CodeWhale Runtime error' }],
      };
    default:
      return null;
  }
}

export function normalizeThreadDetail(detail, { maxBuffer = 4000 } = {}) {
  const threadId = detail?.thread?.id;
  if (!threadId || !Array.isArray(detail?.items)) return [];
  const agentToolIds = new Map();
  for (const item of detail.items) {
    if (
      item?.kind === 'tool_call'
      && item?.metadata?.action === 'start'
      && typeof item?.metadata?.agent_id === 'string'
    ) {
      agentToolIds.set(item.metadata.agent_id, item.id);
    }
  }
  const messages = detail.items
    .map((item) => normalizeRuntimeItem(threadId, item, { agentToolIds }))
    .filter(Boolean);
  return messages.length > maxBuffer ? messages.slice(messages.length - maxBuffer) : messages;
}

export function normalizeRuntimeSubAgents(detail) {
  const threadId = detail?.thread?.id;
  if (!threadId || !Array.isArray(detail?.items)) return [];
  const agents = new Map();

  for (const item of detail.items) {
    if (
      item?.kind !== 'tool_call'
      || item?.metadata?.action !== 'start'
      || typeof item?.metadata?.agent_id !== 'string'
    ) continue;
    const agentId = item.metadata.agent_id;
    const projection = embeddedJson(item.detail) || embeddedJson(item.summary) || {};
    agents.set(agentId, {
      agentId,
      toolUseId: item.id,
      agentType: typeof projection.name === 'string' ? projection.name : 'codewhale-agent',
      description: null,
      status: 'running',
      messages: [],
      messagesLoaded: true,
      createdAt: itemTimestampMs(item),
      model: detail.thread.model || null,
      def: null,
      nested: [],
    });
  }

  for (const item of detail.items) {
    if (item?.kind !== 'status') continue;
    const text = itemText(item);
    const spawned = text.match(/^Sub-agent\s+(\S+)\s+spawned:\s*([\s\S]*)$/i);
    if (spawned && agents.has(spawned[1])) {
      agents.get(spawned[1]).description = spawned[2].trim() || null;
      continue;
    }
    const completion = text.match(/^Sub-agent\s+(\S+)\s+(completed|failed|canceled):\s*([\s\S]*)$/i);
    if (!completion || !agents.has(completion[1])) continue;
    const [, agentId, state, output] = completion;
    const agent = agents.get(agentId);
    agent.status = 'done';
    agent.messages = [{
      uuid: `codewhale-subagent:${threadId}:${agentId}:${item.id}`,
      role: 'assistant',
      ts: itemTimestampMs(item),
      blocks: [{
        kind: 'text',
        text: output.trim() || `Sub-agent ${agentId} ${state.toLowerCase()}`,
      }],
      rawType: `codewhale:subagent.${state.toLowerCase()}`,
    }];
  }

  return [...agents.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

export class CodeWhaleRuntimeSubAgentsSource extends EventEmitter {
  constructor() {
    super();
    this._agents = new Map();
    this._stopped = false;
  }

  update(detail) {
    if (this._stopped) return;
    const next = normalizeRuntimeSubAgents(detail);
    const previous = this._agents;
    this._agents = new Map(next.map((agent) => [agent.agentId, agent]));
    for (const agent of next) {
      if (JSON.stringify(previous.get(agent.agentId)) !== JSON.stringify(agent)) {
        this.emit('change', agent);
      }
    }
  }

  snapshot() { return [...this._agents.values()]; }
  async load(agentId) { return this._agents.get(agentId) || null; }
  poll() {}
  markDone() {}
  trim(max = 40) {
    const keep = Math.max(1, Number(max) || 1);
    for (const agent of this._agents.values()) {
      if (agent.messages.length > keep) agent.messages = agent.messages.slice(-keep);
    }
  }
  stop() {
    this._stopped = true;
    this._agents.clear();
  }
}

function approvalIdFromToolUseId(toolUseId) {
  const value = String(toolUseId ?? '');
  return value.startsWith(CODEWHALE_APPROVAL_PREFIX)
    ? value.slice(CODEWHALE_APPROVAL_PREFIX.length)
    : null;
}

export function normalizeRuntimeApproval(approval) {
  const approvalId = String(approval?.approval_id || approval?.id || '');
  if (!approvalId) return null;
  const toolName = clip(approval?.tool_name || 'tool', 80);
  const question = clip(
    approval?.intent_summary || approval?.description || `Allow CodeWhale to run ${toolName}?`,
    500,
  );
  return {
    toolUseId: `${CODEWHALE_APPROVAL_PREFIX}${approvalId}`,
    questions: [{
      header: `Approval required · ${toolName}`,
      question,
      multiSelect: false,
      options: [
        { label: 'Allow once', description: 'Run this tool call once.' },
        { label: 'Always allow for this thread', description: 'Allow and remember this decision for the current Runtime thread.' },
        { label: 'Deny', description: 'Refuse this tool call.' },
      ],
    }],
  };
}

function approvalDecisionFromSelections(selections) {
  const labels = (Array.isArray(selections) ? selections : [])
    .flatMap((selection) => Array.isArray(selection) ? selection : [])
    .map((label) => String(label));
  if (labels.includes('Always allow for this thread')) return { decision: 'allow', remember: true };
  if (labels.includes('Allow once')) return { decision: 'allow', remember: false };
  if (labels.includes('Deny')) return { decision: 'deny', remember: false };
  throw new Error('Choose Allow once, Always allow for this thread, or Deny');
}

function cleanTitle(value, fallback = 'CodeWhale Runtime') {
  const text = stripRuntimeInjectedContext(value).split('\n')[0].trim();
  return clip(text || fallback, 120);
}

export function normalizeRuntimeSummary(summary) {
  const threadId = String(summary?.id || '');
  if (!threadId) return null;
  const latestStatus = String(summary.latest_turn_status || '').toLowerCase();
  const thinking = latestStatus === 'queued' || latestStatus === 'in_progress';
  const updatedMs = Date.parse(summary.updated_at || '');
  const title = cleanTitle(summary.title || summary.preview);
  return {
    id: runtimeSessionId(threadId),
    sessionId: threadId,
    name: title,
    title,
    cwd: typeof summary.workspace === 'string' ? summary.workspace : null,
    kind: 'codewhale',
    presentation: 'thread',
    transport: 'codewhale-http-sse',
    pending: false,
    active: thinking,
    thinking,
    errored: latestStatus === 'failed',
    archived: !!summary.archived,
    model: summary.model || null,
    summary: stripRuntimeInjectedContext(summary.preview || ''),
    lastActivity: summary.updated_at || null,
    lastActivityMs: Number.isFinite(updatedMs) ? updatedMs : null,
  };
}

export function assertRuntimeCompatible(info) {
  if (!info || typeof info !== 'object') throw new Error('CodeWhale Runtime returned invalid runtime info');
  if (!Array.isArray(info.transports) || !info.transports.includes('sse')) {
    throw new Error('CodeWhale Runtime does not advertise SSE transport');
  }
  for (const capability of REQUIRED_CAPABILITIES) {
    if (info.capabilities?.[capability] !== true) {
      throw new Error(`CodeWhale Runtime lacks required capability ${capability}`);
    }
  }
  return {
    version: info.codewhale_version || info.version || 'unknown',
    commit: info.codewhale_commit || 'unknown',
    runtimeApiVersion: info.runtime_api_version || 'unknown',
  };
}

export async function consumeSse(body, onEvent) {
  if (!body?.getReader) throw new Error('CodeWhale Runtime SSE response has no readable body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const consumeBlock = async (block) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    const event = safeJson(data);
    if (event) await onEvent(event);
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      await consumeBlock(block);
    }
    if (done) break;
  }
  if (buffer.trim()) await consumeBlock(buffer);
}

export class CodeWhaleRuntimeClient {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    token = '',
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('CodeWhale Runtime requires fetch');
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = typeof token === 'string' ? token : '';
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  _headers(extra = {}) {
    return {
      Accept: 'application/json',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  async _request(path, {
    method = 'GET',
    body,
    signal,
    accept = 'application/json',
    timeoutMs = this.timeoutMs,
  } = {}) {
    const combined = abortSignals(signal, timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this._headers({
          Accept: accept,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        }),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const parsed = safeJson(text);
        const detail = parsed?.error?.message || parsed?.message || text || response.statusText;
        throw new Error(`CodeWhale Runtime ${method} ${path} failed (${response.status}): ${clip(detail)}`);
      }
      return response;
    } finally {
      combined.cleanup();
    }
  }

  async _json(path, options) {
    const response = await this._request(path, options);
    const text = await response.text();
    const parsed = safeJson(text);
    if (parsed === null) throw new Error(`CodeWhale Runtime ${path} returned invalid JSON`);
    return parsed;
  }

  health() { return this._json('/health'); }
  runtimeInfo() { return this._json('/v1/runtime/info'); }
  listThreadSummaries() { return this._json('/v1/threads/summary?limit=100&include_archived=true'); }
  getThreadDetail(threadId) { return this._json(`/v1/threads/${encodeURIComponent(threadId)}`); }

  startTurn(threadId, prompt) {
    return this._json(`/v1/threads/${encodeURIComponent(threadId)}/turns`, {
      method: 'POST',
      body: { prompt: String(prompt ?? '') },
    });
  }

  decideApproval(approvalId, { decision, remember = false } = {}) {
    if (decision !== 'allow' && decision !== 'deny') {
      throw new Error('CodeWhale approval decision must be allow or deny');
    }
    return this._json(`/v1/approvals/${encodeURIComponent(String(approvalId ?? ''))}`, {
      method: 'POST',
      body: { decision, remember: !!remember },
    });
  }

  async interruptActiveTurn(threadId) {
    const detail = await this.getThreadDetail(threadId);
    const turn = [...(Array.isArray(detail.turns) ? detail.turns : [])]
      .reverse()
      .find((candidate) => candidate?.status === 'queued' || candidate?.status === 'in_progress');
    if (!turn?.id) return { interrupted: false };
    return this._json(
      `/v1/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turn.id)}/interrupt`,
      { method: 'POST', body: {} },
    );
  }

  async streamThreadEvents(threadId, sinceSeq, { signal, onEvent } = {}) {
    const response = await this._request(
      `/v1/threads/${encodeURIComponent(threadId)}/events?since_seq=${encodeURIComponent(String(sinceSeq || 0))}`,
      // The transcript stream is intentionally long lived. Its caller owns
      // cancellation; applying the short JSON request timeout here would tear
      // down a healthy SSE connection every few seconds.
      { signal, accept: 'text/event-stream', timeoutMs: 0 },
    );
    await consumeSse(response.body, onEvent || (() => {}));
  }
}

export class CodeWhaleRuntimeSessionSource {
  constructor(client, registry, { intervalMs = 5000 } = {}) {
    this.client = client;
    this.registry = registry;
    this.intervalMs = intervalMs;
    this._interval = null;
    this._ticking = false;
    this._lastRows = [];
    this._health = { status: 'unknown', reason: null, version: null, commit: null };
  }

  health() { return { ...this._health }; }

  async tick() {
    if (this._ticking) return;
    this._ticking = true;
    try {
      const info = await this.client.runtimeInfo();
      const compatible = assertRuntimeCompatible(info);
      const summaries = await this.client.listThreadSummaries();
      if (!Array.isArray(summaries)) throw new Error('CodeWhale Runtime thread summaries must be an array');
      this._lastRows = summaries.map(normalizeRuntimeSummary).filter(Boolean);
      this._health = { status: 'green', reason: null, ...compatible };
      this.registry.setExternalSessions(CODEWHALE_RUNTIME_SOURCE, this._lastRows);
    } catch (err) {
      const reason = String(err?.message || err);
      this._health = { ...this._health, status: this._lastRows.length ? 'amber' : 'red', reason };
      this.registry.setExternalSessions(
        CODEWHALE_RUNTIME_SOURCE,
        this._lastRows.map((row) => ({ ...row, stale: true })),
      );
    } finally {
      this._ticking = false;
    }
  }

  start() {
    if (this._interval) return;
    this.tick().catch(() => {});
    this._interval = setInterval(() => this.tick().catch(() => {}), this.intervalMs);
    this._interval.unref?.();
  }

  stop() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
  }
}

export class CodeWhaleRuntimeTranscriptSource extends EventEmitter {
  constructor(client, {
    threadId,
    maxBuffer = 4000,
    retryMs = DEFAULT_RETRY_MS,
    wait = (ms) => new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  } = {}) {
    super();
    this.client = client;
    this.threadId = threadId;
    this.maxBuffer = maxBuffer;
    this.retryMs = retryMs;
    this.wait = wait;
    this._messages = [];
    this._pending = null;
    this.subagents = new CodeWhaleRuntimeSubAgentsSource();
    this._cursor = 0;
    this._running = false;
    this._startPromise = null;
    this._streamController = null;
  }

  getMessages() { return this._messages; }
  getPending() { return this._pending; }

  _setPendingFromDetail(detail, { emit = false } = {}) {
    const next = (Array.isArray(detail?.pending_approvals) ? detail.pending_approvals : [])
      .map(normalizeRuntimeApproval)
      .find(Boolean) || null;
    const changed = JSON.stringify(next) !== JSON.stringify(this._pending);
    this._pending = next;
    if (emit && changed) this.emit('pending', next);
  }

  async _loadSnapshot({ emitReset = false } = {}) {
    const detail = await this.client.getThreadDetail(this.threadId);
    if (detail?.thread?.id !== this.threadId) throw new Error('CodeWhale Runtime returned the wrong thread snapshot');
    this._messages = normalizeThreadDetail(detail, { maxBuffer: this.maxBuffer });
    this._setPendingFromDetail(detail, { emit: emitReset });
    this.subagents.update(detail);
    this._cursor = Number.isSafeInteger(detail.latest_seq) && detail.latest_seq >= 0 ? detail.latest_seq : 0;
    if (emitReset) this.emit('reset', this._messages);
  }

  async start() {
    if (this._startPromise) return this._startPromise;
    this._running = true;
    this._startPromise = this._loadSnapshot().then(() => {
      if (this._pending) this.emit('pending', this._pending);
      this.emit('ready');
      this._follow().catch((err) => this.emit('error', err));
    });
    return this._startPromise;
  }

  async _refreshItems() {
    const detail = await this.client.getThreadDetail(this.threadId);
    const next = normalizeThreadDetail(detail, { maxBuffer: this.maxBuffer });
    const previous = new Map(this._messages.map((message) => [message.uuid, JSON.stringify(message)]));
    const changed = next.filter((message) => previous.get(message.uuid) !== JSON.stringify(message));
    this._messages = next;
    this._setPendingFromDetail(detail, { emit: true });
    this.subagents.update(detail);
    if (changed.length) this.emit('upsert', changed);
  }

  async answerPending(toolUseId, selections) {
    const approvalId = approvalIdFromToolUseId(toolUseId);
    if (!approvalId || this._pending?.toolUseId !== toolUseId) {
      throw new Error('stale CodeWhale approval (already decided or changed)');
    }
    const decision = approvalDecisionFromSelections(selections);
    const result = await this.client.decideApproval(approvalId, decision);
    // Re-read the authoritative pending set after delivery. A workflow can
    // queue several approvals at once; clearing locally would briefly hide (or
    // race and overwrite) the next request if approval.decided arrives first.
    await this._refreshItems();
    return result;
  }

  async _acceptEvent(event) {
    if (!event || event.thread_id !== this.threadId) return;
    const seq = Number(event.seq);
    if (!Number.isSafeInteger(seq) || seq <= this._cursor) return;
    if (Object.hasOwn(event, 'previous_seq')) {
      const previousSeq = Number(event.previous_seq);
      if (!Number.isSafeInteger(previousSeq) || previousSeq !== this._cursor) {
        throw new CursorGapError(`CodeWhale Runtime cursor gap at ${this._cursor} -> ${seq}`);
      }
    }
    this._cursor = seq;
    const eventName = event.event || event.kind || '';
    if (ITEM_EVENT_NAMES.has(eventName)) await this._refreshItems();
  }

  async _follow() {
    while (this._running) {
      const controller = new AbortController();
      this._streamController = controller;
      try {
        await this.client.streamThreadEvents(this.threadId, this._cursor, {
          signal: controller.signal,
          onEvent: (event) => this._acceptEvent(event),
        });
      } catch (err) {
        if (!this._running || controller.signal.aborted) break;
        if (err instanceof CursorGapError) {
          await this._loadSnapshot({ emitReset: true });
          continue;
        }
        this.emit('error', err);
      } finally {
        if (this._streamController === controller) this._streamController = null;
      }
      if (this._running) await this.wait(this.retryMs);
    }
  }

  trim(max) {
    const keep = Math.max(1, Number(max) || 1);
    if (this._messages.length > keep) this._messages = this._messages.slice(this._messages.length - keep);
  }

  stop() {
    this._running = false;
    this._streamController?.abort();
    this._streamController = null;
  }
}
