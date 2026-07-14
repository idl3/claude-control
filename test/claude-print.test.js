import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { buildBridgeCommand, ClaudePrintManager, ClaudePrintClient } from '../lib/claude-print.js';
import { shellQuoteName } from '../lib/tmux.js';

test('buildBridgeCommand quotes every shell argument', () => {
  const cmd = buildBridgeCommand({
    nodeBin: '/usr/local/bin/node',
    bridgePath: '/app/bin/claude-print-bridge.mjs',
    socketPath: '/tmp/cc print.sock',
    cwd: "/workspace/it's here",
    claudeBin: '/opt/homebrew/bin/claude',
    name: "work's session",
    permissionMode: 'acceptEdits',
    quote: shellQuoteName,
  });

  assert.equal(
    cmd,
    "'/usr/local/bin/node' '/app/bin/claude-print-bridge.mjs' --socket '/tmp/cc print.sock' --cwd '/workspace/it'\\''s here' --bin '/opt/homebrew/bin/claude' --permission-mode 'acceptEdits' --name 'work'\\''s session'",
  );
});

test('buildBridgeCommand defaults to bypassPermissions (print mode cannot answer prompts)', () => {
  const cmd = buildBridgeCommand({
    nodeBin: '/usr/local/bin/node',
    bridgePath: '/app/bin/claude-print-bridge.mjs',
    socketPath: '/tmp/cc.sock',
    cwd: '/workspace',
    claudeBin: '/usr/local/bin/claude',
    quote: shellQuoteName,
  });
  assert.match(cmd, /--permission-mode 'bypassPermissions'/);
});

// ── model plumbing (draft-composer model picker) ────────────────────────────

test('buildBridgeCommand appends --model after --name when a model is set', () => {
  const cmd = buildBridgeCommand({
    nodeBin: '/usr/local/bin/node',
    bridgePath: '/app/bin/claude-print-bridge.mjs',
    socketPath: '/tmp/cc.sock',
    cwd: '/workspace',
    claudeBin: '/usr/local/bin/claude',
    name: 'my session',
    model: 'opus',
    quote: shellQuoteName,
  });
  assert.equal(
    cmd,
    "'/usr/local/bin/node' '/app/bin/claude-print-bridge.mjs' --socket '/tmp/cc.sock' --cwd '/workspace' --bin '/usr/local/bin/claude' --permission-mode 'bypassPermissions' --name 'my session' --model 'opus'",
  );
});

test('buildBridgeCommand appends --model even without a name', () => {
  const cmd = buildBridgeCommand({
    nodeBin: '/usr/local/bin/node',
    bridgePath: '/app/bin/claude-print-bridge.mjs',
    socketPath: '/tmp/cc.sock',
    cwd: '/workspace',
    claudeBin: '/usr/local/bin/claude',
    model: 'haiku',
    quote: shellQuoteName,
  });
  assert.match(cmd, /--model 'haiku'$/);
  assert.doesNotMatch(cmd, /--name/);
});

test('buildBridgeCommand omits --model when absent (regression: pre-model shape unchanged)', () => {
  const cmd = buildBridgeCommand({
    nodeBin: '/usr/local/bin/node',
    bridgePath: '/app/bin/claude-print-bridge.mjs',
    socketPath: '/tmp/cc.sock',
    cwd: '/workspace',
    claudeBin: '/usr/local/bin/claude',
    name: 'my session',
    quote: shellQuoteName,
  });
  assert.doesNotMatch(cmd, /--model/);
});

test('ClaudePrintManager accepts bridge connection and normalizes user messages', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-claude-print-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const manager = new ClaudePrintManager({ socketDir: dir });
  const socketPath = manager.endpointFor('s:1.0');
  const client = await manager.attach({ target: 's:1.0', socketPath, cwd: os.tmpdir() });
  t.after(() => client.close());

  const bridge = net.createConnection(socketPath);
  bridge.setEncoding('utf8');
  t.after(() => bridge.destroy());

  await new Promise((resolve, reject) => {
    bridge.once('connect', resolve);
    bridge.once('error', reject);
  });
  bridge.write(JSON.stringify({ type: 'ready' }) + '\n');
  await client.waitForBridge();

  const got = new Promise((resolve) => manager.once('messages', (_id, messages) => resolve(messages)));
  bridge.write(JSON.stringify({
    type: 'event',
    event: {
      type: 'user',
      uuid: 'u1',
      session_id: 'sid-1',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'hello print mode' }],
      },
    },
  }) + '\n');

  const messages = await got;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].blocks[0].text, 'hello print mode');
  assert.equal(manager.threadInfo('s:1.0').sessionId, 'sid-1');
});

// ── Draft-composer initial prompt: submit() after waitForBridge() resolves ──
// Mirrors server.js's handleSessionNew print-transport flow exactly: attach →
// type the launch command → waitForBridge() → submit(prompt) over the socket
// (never typed into the pane).

test('ClaudePrintClient.submit writes the prompt over the socket once the bridge is ready', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-claude-print-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const manager = new ClaudePrintManager({ socketDir: dir });
  const socketPath = manager.endpointFor('s:2.0');
  const client = await manager.attach({ target: 's:2.0', socketPath, cwd: os.tmpdir() });
  t.after(() => client.close());

  const bridge = net.createConnection(socketPath);
  bridge.setEncoding('utf8');
  t.after(() => bridge.destroy());

  await new Promise((resolve, reject) => {
    bridge.once('connect', resolve);
    bridge.once('error', reject);
  });

  // Bridge signals ready — waitForBridge() is what handleSessionNew awaits
  // before submitting an initial prompt.
  bridge.write(JSON.stringify({ type: 'ready' }) + '\n');
  await client.waitForBridge();

  const gotLine = new Promise((resolve) => {
    let buf = '';
    bridge.on('data', (chunk) => {
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx >= 0) resolve(buf.slice(0, idx));
    });
  });

  client.submit('multi-line\ninitial prompt');

  const line = await gotLine;
  assert.deepEqual(JSON.parse(line), { type: 'submit', text: 'multi-line\ninitial prompt' });
});

test('ClaudePrintClient.submit throws when the bridge socket is not yet connected', () => {
  const client = new ClaudePrintClient({ target: 's:3.0', socketPath: '/tmp/does-not-matter.sock', cwd: os.tmpdir() });
  assert.throws(() => client.submit('too early'), /not connected/);
});

test('ClaudePrintManager sweep keeps fresh undiscovered clients during create grace', async () => {
  const manager = new ClaudePrintManager({ socketDir: os.tmpdir() });
  const closed = [];
  manager.clients.set('s:2.0', {
    createdAt: Date.now(),
    close: () => closed.push('fresh'),
  });
  manager.sweep([], { graceMs: 30_000 });
  assert.equal(manager.has('s:2.0'), true);
  assert.deepEqual(closed, []);

  manager.clients.get('s:2.0').createdAt = Date.now() - 60_000;
  manager.sweep([], { graceMs: 30_000 });
  assert.equal(manager.has('s:2.0'), false);
  assert.deepEqual(closed, ['fresh']);
});

test('ClaudePrintManager ignores close events from a superseded client', () => {
  const manager = new ClaudePrintManager({ socketDir: os.tmpdir() });
  const stale = new ClaudePrintClient({
    target: 's:2.0',
    socketPath: '/tmp/stale-claude-print.sock',
    cwd: os.tmpdir(),
  });
  const current = new ClaudePrintClient({
    target: 's:2.0',
    socketPath: '/tmp/current-claude-print.sock',
    cwd: os.tmpdir(),
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
  assert.deepEqual(closed, ['s:2.0']);
});

test('ClaudePrintClient ignores a delayed close from its replaced socket', () => {
  const manager = new ClaudePrintManager({ socketDir: os.tmpdir() });
  const client = new ClaudePrintClient({
    target: 's:3.0',
    socketPath: '/tmp/reconnecting-claude-print.sock',
    cwd: os.tmpdir(),
  });
  manager._bind(client);
  manager.clients.set(client.target, client);
  const closed = [];
  manager.on('close', (target) => closed.push(target));

  const fakeSocket = () => Object.assign(new EventEmitter(), {
    destroyed: false,
    destroy() { this.destroyed = true; },
    setEncoding() {},
    unref() {},
  });
  const oldSocket = fakeSocket();
  const currentSocket = fakeSocket();

  client._attach(oldSocket);
  client._attach(currentSocket);
  currentSocket.emit('data', `${JSON.stringify({ type: 'ready' })}\n`);
  oldSocket.emit('close');

  assert.equal(client.socket, currentSocket);
  assert.equal(client.ready, true);
  assert.equal(manager.clients.get(client.target), client);
  assert.deepEqual(closed, []);

  currentSocket.emit('close');
  assert.equal(client.socket, null);
  assert.equal(client.ready, false);
  assert.equal(manager.clients.has(client.target), false);
  assert.deepEqual(closed, ['s:3.0']);
});
