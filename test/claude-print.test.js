import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { buildBridgeCommand, ClaudePrintManager } from '../lib/claude-print.js';
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
