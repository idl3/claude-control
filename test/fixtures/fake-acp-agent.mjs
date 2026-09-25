#!/usr/bin/env node
/**
 * Minimal ACP agent over stdio. Speaks JSON-RPC 2.0 NDJSON.
 * Used by unit tests — not a real model.
 *
 * Prompt containing RUN_TERMINAL triggers a terminal/create client request
 * with `echo ok` (args array, no shell).
 */
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
const pending = new Map();
let nextId = 1;
let sessionId = null;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function request(method, params) {
  const id = `a-${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

rl.on('line', async (line) => {
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.id != null && !msg.method && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error }));
    else p.resolve(msg.result);
    return;
  }

  const { id, method, params } = msg;
  if (!method || id == null) return;

  try {
    const result = await handle(method, params);
    send({ jsonrpc: '2.0', id, result: result ?? {} });
  } catch (err) {
    send({
      jsonrpc: '2.0',
      id,
      error: err?.rpc || { code: -32603, message: err?.message || 'internal error' },
    });
  }
});

async function handle(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
        authMethods: [{ id: 'none', name: 'none' }],
      };
    case 'authenticate':
      return {};
    case 'session/new':
      sessionId = 'fake-sess-1';
      return { sessionId };
    case 'session/load':
      sessionId = params?.sessionId || 'fake-sess-1';
      return {};
    case 'session/cancel':
      return {};
    case 'session/prompt': {
      const text = Array.isArray(params?.prompt)
        ? params.prompt.map((b) => b?.text || '').join('')
        : '';
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'thinking' },
          },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'ack' },
          },
        },
      });
      if (text.includes('RUN_TERMINAL')) {
        const created = await request('terminal/create', {
          command: 'echo',
          args: ['ok'],
          cwd: params?.cwd || process.cwd(),
        });
        await request('terminal/wait_for_exit', { terminalId: created.terminalId });
        const output = await request('terminal/output', { terminalId: created.terminalId });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 't1',
              title: 'echo',
              rawInput: { command: 'echo', args: ['ok'] },
              status: 'completed',
              content: [{ type: 'content', content: { type: 'text', text: output?.output || '' } }],
            },
          },
        });
        await request('terminal/release', { terminalId: created.terminalId });
      }
      if (text.includes('ASK_PERM')) {
        await request('session/request_permission', {
          toolCall: { toolCallId: 'p1', title: 'write' },
          options: [
            { optionId: 'allow_once', name: 'Allow once' },
            { optionId: 'reject', name: 'Reject' },
          ],
        });
      }
      return { stopReason: 'end_turn' };
    }
    default: {
      const err = new Error(`Method not found: ${method}`);
      err.rpc = { code: -32601, message: err.message };
      throw err;
    }
  }
}
