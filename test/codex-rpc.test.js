import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CodexRpcClient,
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
