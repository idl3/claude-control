#!/usr/bin/env node
/**
 * bin/collab-mcp.js — stdio MCP shim for claude-collab.
 *
 * Registered in Claude's (~/.claude/settings.json) and Codex's
 * (~/.codex/config.toml) MCP config by `claude-control collab install`. Each
 * agent session spawns this as an MCP server INSIDE its tmux pane, so it inherits
 * `$TMUX_PANE` (the stable %N pane id). Every tool call forwards to the
 * claude-control server (/api/collab/*) with that paneId, so the server can map
 * the caller to a live session and route/nudge peers.
 *
 * Hand-rolled newline-delimited JSON-RPC 2.0 (MCP stdio framing) — no SDK dep, so
 * the shim adds nothing to the runtime dependency tree.
 */
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NAME = 'claude-collab';
const VERSION = '0.1.0';
const DEFAULT_PROTOCOL = '2024-11-05';

const PANE_ID = process.env.TMUX_PANE || '';
const BASE_URL = (process.env.CLAUDE_CONTROL_URL || 'http://127.0.0.1:4317').replace(/\/$/, '');

function readToken() {
  if (process.env.CLAUDE_CONTROL_TOKEN) return process.env.CLAUDE_CONTROL_TOKEN.trim();
  try {
    return fs.readFileSync(path.join(os.homedir(), '.claude-control', 'token'), 'utf8').trim();
  } catch {
    return '';
  }
}
const TOKEN = readToken();

async function api(method, pathname, { query, body } = {}) {
  const url = new URL(BASE_URL + pathname);
  if (query) for (const [k, v] of Object.entries(query)) if (v != null && v !== '') url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// Tool registry: schema (advertised to the agent) + handler (→ HTTP). Every
// handler runs in the caller's pane, so paneId is injected here, not by the agent.
const TOOLS = [
  {
    name: 'collab_open',
    description: 'Announce THIS session as open for collaboration and create a room. Returns a roomId + a short join code to share with a collaborator.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', description: 'Optional short topic for the room.' } } },
    handler: (a) => api('POST', '/api/collab/open', { body: { paneId: PANE_ID, topic: a.topic } }),
  },
  {
    name: 'collab_list',
    description: 'List sessions/rooms currently open for collaboration (find a collaborator to join).',
    inputSchema: { type: 'object', properties: {} },
    handler: () => api('GET', '/api/collab/list'),
  },
  {
    name: 'collab_join',
    description: 'Join a collaboration room by its short code (or roomId). Pairs THIS session with the room members.',
    inputSchema: { type: 'object', properties: { code: { type: 'string' }, roomId: { type: 'string' } } },
    handler: (a) => api('POST', '/api/collab/join', { body: { paneId: PANE_ID, code: a.code, roomId: a.roomId } }),
  },
  {
    name: 'collab_send',
    description: 'Send a message to a collaboration room. Idle peers are nudged in their pane; all peers can fetch it with collab_read.',
    inputSchema: { type: 'object', properties: { roomId: { type: 'string' }, text: { type: 'string' } }, required: ['roomId', 'text'] },
    handler: (a) => api('POST', '/api/collab/send', { body: { paneId: PANE_ID, roomId: a.roomId, text: a.text } }),
  },
  {
    name: 'collab_read',
    description: 'Fetch new room messages after a cursor (`since` seq, default 0). Set wait=true to long-poll for the next message. Returns { seq, messages }.',
    inputSchema: { type: 'object', properties: { roomId: { type: 'string' }, since: { type: 'number' }, wait: { type: 'boolean' } }, required: ['roomId'] },
    handler: (a) => api('GET', '/api/collab/read', { query: { paneId: PANE_ID, roomId: a.roomId, since: a.since, wait: a.wait ? '1' : undefined } }),
  },
  {
    name: 'collab_remember',
    description: 'Replay the FULL append-only transcript of a room — use to restore context after a compaction/clear. Returns { log }.',
    inputSchema: { type: 'object', properties: { roomId: { type: 'string' } }, required: ['roomId'] },
    handler: (a) => api('GET', '/api/collab/history', { query: { paneId: PANE_ID, roomId: a.roomId } }),
  },
  {
    name: 'collab_members',
    description: 'List the members of a collaboration room.',
    inputSchema: { type: 'object', properties: { roomId: { type: 'string' } }, required: ['roomId'] },
    handler: (a) => api('GET', '/api/collab/members', { query: { paneId: PANE_ID, roomId: a.roomId } }),
  },
  {
    name: 'collab_leave',
    description: 'Leave a collaboration room.',
    inputSchema: { type: 'object', properties: { roomId: { type: 'string' } }, required: ['roomId'] },
    handler: (a) => api('POST', '/api/collab/leave', { body: { paneId: PANE_ID, roomId: a.roomId } }),
  },
];
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleToolCall(id, params) {
  const tool = TOOL_BY_NAME.get(params?.name);
  if (!tool) return replyError(id, -32602, `unknown tool: ${params?.name}`);
  if (!PANE_ID) {
    return reply(id, {
      content: [{ type: 'text', text: 'Not inside a claude-control tmux pane ($TMUX_PANE is unset), so this session cannot collaborate.' }],
      isError: true,
    });
  }
  try {
    const out = await tool.handler(params.arguments || {});
    reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
  } catch (err) {
    reply(id, { content: [{ type: 'text', text: `collab error: ${err?.message || err}` }], isError: true });
  }
}

async function onMessage(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: NAME, version: VERSION },
      });
    case 'notifications/initialized':
    case 'initialized':
      return; // notification — no response
    case 'tools/list':
      return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call':
      return handleToolCall(id, params);
    case 'ping':
      return reply(id, {});
    default:
      if (id != null) replyError(id, -32601, `method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return; // ignore a torn/non-JSON line
  }
  Promise.resolve(onMessage(msg)).catch((err) => {
    if (msg?.id != null) replyError(msg.id, -32603, String(err?.message || err));
  });
});
