import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CodexRpcClient,
  CodexRpcManager,
  isCodexActiveStatus,
  isCodexAppServerCapture,
  parseCodexAppServerEndpoint,
} from '../lib/codex-rpc.js';

test('parseCodexAppServerEndpoint extracts loopback websocket URLs only', () => {
  assert.equal(
    parseCodexAppServerEndpoint('listening on: ws://127.0.0.1:55380'),
    'ws://127.0.0.1:55380',
  );
  assert.equal(
    parseCodexAppServerEndpoint('ready at ws://localhost:6001 for clients'),
    'ws://localhost:6001',
  );
  assert.equal(parseCodexAppServerEndpoint('ws://example.com:6001'), null);
});

test('isCodexAppServerCapture detects app-server panes without matching generic Codex text', () => {
  assert.equal(
    isCodexAppServerCapture(`codex app-server (WebSockets)\n  listening on: ws://127.0.0.1:55380\n  readyz: http://127.0.0.1:55380/readyz`),
    true,
  );
  assert.equal(
    isCodexAppServerCapture(`/Users/me/bin/codex app-server --listen 'ws://127.0.0.1:60036'`),
    true,
  );
  assert.equal(isCodexAppServerCapture('Welcome to Codex. Type a prompt below.'), false);
});

test('isCodexActiveStatus normalizes app-server working and sleeping states', () => {
  assert.equal(isCodexActiveStatus({ type: 'active' }), true);
  assert.equal(isCodexActiveStatus({ state: 'running' }), true);
  assert.equal(isCodexActiveStatus({ status: 'in_progress' }), true);
  assert.equal(isCodexActiveStatus({ busy: true }), true);
  assert.equal(isCodexActiveStatus('working'), true);

  assert.equal(isCodexActiveStatus({ type: 'inactive' }), false);
  assert.equal(isCodexActiveStatus({ state: 'idle' }), false);
  assert.equal(isCodexActiveStatus({ sleeping: true }), false);
  assert.equal(isCodexActiveStatus('done'), false);
  assert.equal(isCodexActiveStatus({ type: 'unknown' }), false);
});

test('CodexRpcClient _openThread starts persistent non-ephemeral threads', async () => {
  const calls = [];
  const client = new CodexRpcClient({
    target: 's:0.0',
    endpoint: 'ws://127.0.0.1:1',
    cwd: '/workspace',
  });
  client.request = async (method, params) => {
    calls.push({ method, params });
    return { thread: { id: 'thread-1', path: '/tmp/rollout.jsonl' } };
  };

  const opened = await client._openThread();

  assert.equal(opened.thread.id, 'thread-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'thread/start');
  assert.deepEqual(calls[0].params, {
    cwd: '/workspace',
    ephemeral: false,
    threadSource: 'user',
    sessionStartSource: 'startup',
  });
});

test('CodexRpcClient _openThread includes model in thread/start params when constructed with one', async () => {
  const calls = [];
  const client = new CodexRpcClient({
    target: 's:0.0',
    endpoint: 'ws://127.0.0.1:1',
    cwd: '/workspace',
    model: 'gpt-5.5',
  });
  client.request = async (method, params) => {
    calls.push({ method, params });
    return { thread: { id: 'thread-1', path: '/tmp/rollout.jsonl' } };
  };

  await client._openThread();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'thread/start');
  assert.deepEqual(calls[0].params, {
    cwd: '/workspace',
    ephemeral: false,
    threadSource: 'user',
    sessionStartSource: 'startup',
    model: 'gpt-5.5',
  });
});

test('CodexRpcClient _openThread omits model from thread/resume params even when constructed with one (model only applies to fresh threads)', async () => {
  const calls = [];
  const client = new CodexRpcClient({
    target: 's:0.0',
    endpoint: 'ws://127.0.0.1:1',
    cwd: '/workspace',
    resumeThreadId: 'thread-1',
    transcriptPath: '/tmp/rollout.jsonl',
    model: 'gpt-5.5',
  });
  client.request = async (method, params) => {
    calls.push({ method, params });
    return { thread: { id: 'thread-1', path: '/tmp/rollout.jsonl' } };
  };

  await client._openThread();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'thread/resume');
  assert.ok(!('model' in calls[0].params), 'thread/resume must not carry a model field');
});

test('CodexRpcManager.attach forwards model into the CodexRpcClient it constructs', () => {
  // Pure construction check — verifies the manager's attach() signature
  // accepts + forwards `model` without needing a live connection.
  const manager = new CodexRpcManager();
  const originalConnect = CodexRpcClient.prototype.connect;
  let capturedModel;
  CodexRpcClient.prototype.connect = async function connect() {
    capturedModel = this.model;
    throw new Error('stop before real connect');
  };
  return manager
    .attach({ target: 's:0.0', endpoint: 'ws://127.0.0.1:1', cwd: '/workspace', model: 'gpt-5.4' })
    .catch(() => {})
    .finally(() => {
      CodexRpcClient.prototype.connect = originalConnect;
      assert.equal(capturedModel, 'gpt-5.4');
    });
});

// ── Task 10: skipPermissions toggle (default ON) — Codex RPC transport ──────
// approvalPolicy/sandbox are only meaningful on a fresh thread/start (mirrors
// the model field's fresh-thread-only exclusion from thread/resume above).

test('CodexRpcClient _openThread includes approvalPolicy+sandbox in thread/start params when constructed with skipPermissions', async () => {
  const calls = [];
  const client = new CodexRpcClient({
    target: 's:0.0',
    endpoint: 'ws://127.0.0.1:1',
    cwd: '/workspace',
    skipPermissions: true,
  });
  client.request = async (method, params) => {
    calls.push({ method, params });
    return { thread: { id: 'thread-1', path: '/tmp/rollout.jsonl' } };
  };

  await client._openThread();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'thread/start');
  assert.deepEqual(calls[0].params, {
    cwd: '/workspace',
    ephemeral: false,
    threadSource: 'user',
    sessionStartSource: 'startup',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  });
});

test('CodexRpcClient _openThread omits approvalPolicy+sandbox from thread/start when skipPermissions is false (regression: byte-identical to unset shape)', async () => {
  const calls = [];
  const client = new CodexRpcClient({
    target: 's:0.0',
    endpoint: 'ws://127.0.0.1:1',
    cwd: '/workspace',
    skipPermissions: false,
  });
  client.request = async (method, params) => {
    calls.push({ method, params });
    return { thread: { id: 'thread-1', path: '/tmp/rollout.jsonl' } };
  };

  await client._openThread();

  assert.deepEqual(calls[0].params, {
    cwd: '/workspace',
    ephemeral: false,
    threadSource: 'user',
    sessionStartSource: 'startup',
  });
});

test('CodexRpcClient _openThread never carries approvalPolicy+sandbox on thread/resume even when constructed with skipPermissions (fresh-thread-only)', async () => {
  const calls = [];
  const client = new CodexRpcClient({
    target: 's:0.0',
    endpoint: 'ws://127.0.0.1:1',
    cwd: '/workspace',
    resumeThreadId: 'thread-1',
    transcriptPath: '/tmp/rollout.jsonl',
    skipPermissions: true,
  });
  client.request = async (method, params) => {
    calls.push({ method, params });
    return { thread: { id: 'thread-1', path: '/tmp/rollout.jsonl' } };
  };

  await client._openThread();

  assert.equal(calls[0].method, 'thread/resume');
  assert.ok(!('approvalPolicy' in calls[0].params), 'thread/resume must not carry approvalPolicy');
  assert.ok(!('sandbox' in calls[0].params), 'thread/resume must not carry sandbox');
});

test('CodexRpcManager.attach forwards skipPermissions into the CodexRpcClient it constructs', () => {
  const manager = new CodexRpcManager();
  const originalConnect = CodexRpcClient.prototype.connect;
  let captured;
  CodexRpcClient.prototype.connect = async function connect() {
    captured = this.skipPermissions;
    throw new Error('stop before real connect');
  };
  return manager
    .attach({ target: 's:0.0', endpoint: 'ws://127.0.0.1:1', cwd: '/workspace', skipPermissions: true })
    .catch(() => {})
    .finally(() => {
      CodexRpcClient.prototype.connect = originalConnect;
      assert.equal(captured, true);
    });
});

test('CodexRpcClient _openThread resumes by thread id and rollout path', async () => {
  const calls = [];
  const client = new CodexRpcClient({
    target: 's:0.0',
    endpoint: 'ws://127.0.0.1:1',
    cwd: '/workspace',
    resumeThreadId: 'thread-1',
    transcriptPath: '/tmp/rollout.jsonl',
  });
  client.request = async (method, params) => {
    calls.push({ method, params });
    return { thread: { id: 'thread-1', path: '/tmp/rollout.jsonl' } };
  };

  await client._openThread();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'thread/resume');
  assert.deepEqual(calls[0].params, {
    cwd: '/workspace',
    threadId: 'thread-1',
    path: '/tmp/rollout.jsonl',
  });
});

test('CodexRpcClient _openThread retries resume without path for older app-server builds', async () => {
  const calls = [];
  const client = new CodexRpcClient({
    target: 's:0.0',
    endpoint: 'ws://127.0.0.1:1',
    cwd: '/workspace',
    resumeThreadId: 'thread-1',
    transcriptPath: '/tmp/rollout.jsonl',
  });
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (calls.length === 1) throw new Error('invalid params: unknown field path');
    return { thread: { id: 'thread-1', path: '/tmp/rollout.jsonl' } };
  };

  await client._openThread();

  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'thread/resume');
  assert.equal(calls[1].method, 'thread/resume');
  assert.deepEqual(calls[1].params, {
    cwd: '/workspace',
    threadId: 'thread-1',
  });
});

test('CodexRpcClient item/completed appends displayable app-server messages', () => {
  const client = new CodexRpcClient({
    target: 's:0.0',
    endpoint: 'ws://127.0.0.1:1',
    cwd: '/workspace',
  });
  const batches = [];
  const rawEvents = [];
  client.on('messages', (messages) => batches.push(messages));
  client.on('raw', (event) => rawEvents.push(event));

  client._onMessage({
    method: 'item/completed',
    params: {
      completedAtMs: 123,
      item: {
        id: 'user-1',
        type: 'userMessage',
        content: [{ type: 'text', text: 'Please inspect the event stream.' }],
      },
    },
  });
  client._onMessage({
    method: 'item/completed',
    params: {
      completedAtMs: 124,
      item: {
        id: 'agent-1',
        type: 'agentMessage',
        text: 'The stream is separated from transcript rendering.',
      },
    },
  });

  assert.equal(batches.length, 2);
  assert.equal(client.messages.length, 2);
  assert.equal(client.messages[0].role, 'user');
  assert.equal(client.messages[0].blocks[0].text, 'Please inspect the event stream.');
  assert.equal(client.messages[1].role, 'assistant');
  assert.equal(client.messages[1].blocks[0].text, 'The stream is separated from transcript rendering.');
  assert.equal(rawEvents.length, 2);
});

test('CodexRpcClient keeps raw/status/unknown app-server events out of transcript messages', () => {
  const client = new CodexRpcClient({
    target: 's:0.0',
    endpoint: 'ws://127.0.0.1:1',
    cwd: '/workspace',
  });
  const batches = [];
  const rawEvents = [];
  const statuses = [];
  client.on('messages', (messages) => batches.push(messages));
  client.on('raw', (event) => rawEvents.push(event));
  client.on('status', (status) => statuses.push(status));

  client._onMessage({
    method: 'thread/status/changed',
    params: { status: { type: 'active' } },
  });
  client._onMessage({
    method: 'item/completed',
    params: {
      completedAtMs: 125,
      item: {
        id: 'reasoning-1',
        type: 'reasoning',
        summary: [{ text: 'Internal reasoning summary' }],
      },
    },
  });
  client._onMessage({
    method: 'some/new/rawNotification',
    params: { payload: { debug: true } },
  });

  assert.deepEqual(batches, []);
  assert.deepEqual(client.messages, []);
  assert.deepEqual(statuses, [{ type: 'active' }]);
  assert.equal(rawEvents.length, 3);
  assert.equal(rawEvents[0].kind, 'request-or-notification');
  assert.equal(rawEvents[0].method, 'thread/status/changed');
  assert.equal(rawEvents[1].method, 'item/completed');
  assert.equal(rawEvents[2].method, 'some/new/rawNotification');
});

test('CodexRpcClient surfaces every JSON-RPC server request and queues prompts', () => {
  const client = new CodexRpcClient({
    target: 's:0.0',
    endpoint: 'ws://127.0.0.1:1',
    cwd: '/workspace',
  });
  const prompts = [];
  const pending = [];
  const sent = [];
  client.ws = {
    readyState: 1,
    send: (payload) => sent.push(JSON.parse(payload)),
  };
  client._closed = false;
  client.on('prompt', (prompt) => prompts.push(prompt));
  client.on('pending', (value) => pending.push(value));

  client._onMessage({
    id: 41,
    method: 'item/commandExecution/requestApproval',
    params: { cwd: '/workspace', command: 'npm test' },
  });
  client._onMessage({
    id: 42,
    method: 'item/someFutureRequest',
    params: { reason: 'new app-server request shape' },
  });

  assert.equal(prompts.length, 1);
  assert.match(prompts[0].question, /Run command/);
  assert.deepEqual(pending, [true]);

  client.answerPrompt('1');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { id: 41, result: { decision: 'accept' } });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].question, /Codex request: item\/someFutureRequest/);
  assert.deepEqual(pending, [true, true]);

  client.answerPrompt('1');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], { id: 42, result: {} });
  assert.equal(prompts.length, 3);
  assert.equal(prompts[2], null);
  assert.deepEqual(pending, [true, true, false]);
});

test('CodexRpcClient rejects pending calls immediately when the socket closes', async () => {
  const client = new CodexRpcClient({
    target: 's:0.0',
    endpoint: 'ws://127.0.0.1:1',
    cwd: '/workspace',
  });
  client.ws = { readyState: 1, send: () => {} };
  client._closed = false;

  const pending = client.request('turn/start', { threadId: 'thread-1' });
  client._handleClose(client.ws);

  await assert.rejects(pending, /WebSocket closed/);
  assert.equal(client.isOpen(), false);
});

test('CodexRpcManager replaces stale or endpoint-changed clients on ensureAttached', async () => {
  const manager = new CodexRpcManager();
  const stale = new CodexRpcClient({
    target: 's:0.0',
    endpoint: 'ws://127.0.0.1:1',
    cwd: '/workspace',
  });
  stale.ws = { readyState: 3, close: () => {}, terminate: () => {} };
  stale._closed = true;
  manager.clients.set('s:0.0', stale);

  let attached = null;
  manager.attach = async (args) => {
    attached = args;
    const fresh = new CodexRpcClient(args);
    fresh.ws = { readyState: 1, close: () => {}, terminate: () => {}, send: () => {} };
    fresh._closed = false;
    manager.clients.set(args.target, fresh);
    return fresh;
  };

  const result = await manager.ensureAttached({
    target: 's:0.0',
    endpoint: 'ws://127.0.0.1:2',
    cwd: '/workspace',
    resumeThreadId: 'thread-1',
    transcriptPath: '/tmp/rollout.jsonl',
  });

  assert.equal(result.endpoint, 'ws://127.0.0.1:2');
  assert.deepEqual(attached, {
    target: 's:0.0',
    endpoint: 'ws://127.0.0.1:2',
    cwd: '/workspace',
    resumeThreadId: 'thread-1',
    transcriptPath: '/tmp/rollout.jsonl',
  });
});

test('CodexRpcManager ignores close events from a superseded client', () => {
  const manager = new CodexRpcManager();
  const stale = new CodexRpcClient({
    target: 's:0.0',
    endpoint: 'ws://127.0.0.1:1',
    cwd: '/workspace',
  });
  const current = new CodexRpcClient({
    target: 's:0.0',
    endpoint: 'ws://127.0.0.1:2',
    cwd: '/workspace',
  });
  manager._bind(stale);
  manager._bind(current);
  manager.clients.set(current.target, current);
  const closed = [];
  manager.on('close', (target) => closed.push(target));

  stale.emit('close');
  assert.equal(manager.clients.get(current.target), current);
  assert.deepEqual(closed, []);

  current.emit('close');
  assert.equal(manager.clients.has(current.target), false);
  assert.deepEqual(closed, ['s:0.0']);
});

// ── submit() — draft-composer initial-prompt delivery over an attached
// RPC thread (server.js's handleSessionNew calls this right after attach()
// resolves, so threadId is already populated — no separate "ready" wait
// needed, unlike the print-mode bridge socket). ────────────────────────────

test('CodexRpcClient.submit sends turn/start with the text and cwd once a thread is open', async () => {
  const client = new CodexRpcClient({
    target: 's:0.0',
    endpoint: 'ws://127.0.0.1:1',
    cwd: '/workspace',
  });
  client.threadId = 'thread-1'; // set by connect()/_openThread() in production
  const calls = [];
  client.request = async (method, params) => {
    calls.push({ method, params });
    return { turn: { id: 'turn-1' } };
  };

  await client.submit('build the feature', { cwd: '/workspace' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'turn/start');
  assert.deepEqual(calls[0].params, {
    threadId: 'thread-1',
    input: [{ type: 'text', text: 'build the feature', text_elements: [] }],
    cwd: '/workspace',
  });
});

test('CodexRpcClient.submit rejects before a thread is open (no threadId yet)', async () => {
  const client = new CodexRpcClient({
    target: 's:0.0',
    endpoint: 'ws://127.0.0.1:1',
    cwd: '/workspace',
  });
  await assert.rejects(() => client.submit('too early'), /thread is not ready/);
});

test('CodexRpcManager.submit forwards to the attached client for the target', async () => {
  const manager = new CodexRpcManager();
  const calls = [];
  const client = new CodexRpcClient({ target: 's:0.0', endpoint: 'ws://127.0.0.1:1', cwd: '/workspace' });
  client.threadId = 'thread-1';
  client.ws = { readyState: 1, close: () => {}, terminate: () => {}, send: () => {} };
  client._closed = false;
  client.request = async (method, params) => {
    calls.push({ method, params });
    return {};
  };
  manager.clients.set('s:0.0', client);

  await manager.submit('s:0.0', 'initial prompt text', { cwd: '/workspace' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.input[0].text, 'initial prompt text');
});

test('CodexRpcManager.submit rejects when no client is attached for the target', async () => {
  const manager = new CodexRpcManager();
  await assert.rejects(
    () => manager.submit('missing:0.0', 'hello'),
    /Codex RPC client is not attached/,
  );
});
