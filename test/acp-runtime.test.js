import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AcpRuntime } from '../lib/acp/runtime.js';
import { AcpMapper, userMessage } from '../lib/acp/mapper.js';
import { createFsHost, isInsideRoot } from '../lib/acp/hosts/fs.js';
import { createTerminalHost } from '../lib/acp/hosts/terminal.js';
import { createPermissionHost } from '../lib/acp/hosts/permission.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(__dirname, 'fixtures', 'fake-acp-agent.mjs');

function spawnOpts(cwd) {
  return {
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd,
    skipPermissions: true,
  };
}

test('mapper concatenates thought and assistant chunks onto stable uuids', () => {
  const m = new AcpMapper();
  const a = m.applyUpdate({
    update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'th' } },
  });
  const b = m.applyUpdate({
    update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'ink' } },
  });
  assert.equal(a[0].uuid, b[0].uuid);
  assert.equal(b[0].blocks[0].kind, 'thinking');
  assert.equal(b[0].blocks[0].text, 'think');

  const c = m.applyUpdate({
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ac' } },
  });
  const d = m.applyUpdate({
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'k' } },
  });
  assert.equal(c[0].uuid, d[0].uuid);
  assert.equal(d[0].blocks[0].kind, 'text');
  assert.equal(d[0].blocks[0].text, 'ack');
});

test('mapper emits tool_use then tool_result on completed tool_call', () => {
  const m = new AcpMapper();
  const msgs = m.applyUpdate({
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'echo',
      rawInput: { command: 'echo' },
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ok\n' } }],
    },
  });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].blocks[0].kind, 'tool_use');
  assert.equal(msgs[0].blocks[0].id, 't1');
  assert.equal(msgs[0].blocks[1].kind, 'tool_result');
  assert.equal(msgs[0].blocks[1].forId, 't1');
  assert.match(msgs[0].blocks[1].text, /ok/);
});

test('userMessage is a user-role NormalizedMessage', () => {
  const u = userMessage('hello');
  assert.equal(u.role, 'user');
  assert.equal(u.blocks[0].text, 'hello');
});

test('fs-host refuses a symlink that points outside cwd', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-fs-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-fs-out-'));
  const secret = path.join(outside, 'secret.txt');
  await fs.writeFile(secret, 'leak');
  const link = path.join(dir, 'link');
  await fs.symlink(outside, link);
  const host = createFsHost({ getCwd: () => dir });
  await assert.rejects(
    () => host.readTextFile({ path: path.join(link, 'secret.txt') }),
    /outside allowed roots/,
  );
});

test('fs-host refuses relative paths and parent-escape', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-fs-'));
  const host = createFsHost({ getCwd: () => dir });
  await assert.rejects(() => host.readTextFile({ path: 'relative.txt' }), /absolute/);
  await assert.rejects(
    () => host.readTextFile({ path: path.join(dir, '..', 'outside.txt') }),
    /outside allowed roots/,
  );
  await assert.rejects(
    () => host.writeTextFile({ path: path.join(dir, '..', '.ssh', 'id_rsa'), content: 'nope' }),
    /outside allowed roots/,
  );
});

test('isInsideRoot treats the root itself as inside and rejects siblings', () => {
  assert.equal(isInsideRoot('/tmp/proj', '/tmp/proj'), true);
  assert.equal(isInsideRoot('/tmp/proj', '/tmp/proj/src/a.ts'), true);
  assert.equal(isInsideRoot('/tmp/proj', '/tmp/other'), false);
  assert.equal(isInsideRoot('/tmp/proj', '/tmp/proj-evil/x'), false);
});

test('fs-host reads and writes inside cwd', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-fs-'));
  const host = createFsHost({ getCwd: () => dir });
  const file = path.join(dir, 'hello.txt');
  await host.writeTextFile({ path: file, content: 'hi' });
  const { content } = await host.readTextFile({ path: file });
  assert.equal(content, 'hi');
});

test('terminal-host runs echo via args array and captures output', async () => {
  const host = createTerminalHost({ getCwd: () => process.cwd() });
  const { terminalId } = await host.create({ command: 'echo', args: ['ok'] });
  await host.waitForExit({ terminalId });
  const out = await host.output({ terminalId });
  assert.match(out.output, /ok/);
  assert.equal(out.exitStatus.exitCode, 0);
  await host.release({ terminalId });
});

test('permission-host skipPermissions auto-allows', async () => {
  const host = createPermissionHost({ skipPermissions: true });
  const result = await host.requestPermission({
    options: [{ optionId: 'allow_always', name: 'Always' }],
  });
  assert.equal(result.outcome.optionId, 'allow_always');
});

test('permission-host waits for answer()', async () => {
  const host = createPermissionHost({ skipPermissions: false });
  const pending = [];
  host.setOnPending((p) => pending.push(p));
  const promise = host.requestPermission({
    options: [{ optionId: 'allow_once', name: 'Once' }],
  });
  assert.equal(pending.length, 1);
  host.answer(pending[0].requestId, { optionId: 'allow_once' });
  const result = await promise;
  assert.equal(result.outcome.optionId, 'allow_once');
});

test('runtime handshake + prompt against fake agent streams thought and ack', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-rt-'));
  const rt = new AcpRuntime(spawnOpts(cwd));
  const appends = [];
  rt.on('append', (msgs) => appends.push(...msgs));
  try {
    await rt.start();
    assert.equal(rt.sessionId, 'fake-sess-1');
    const result = await rt.prompt('Reply with ack.');
    assert.equal(result.stopReason, 'end_turn');
    const thinking = appends.find((m) => m.blocks?.[0]?.kind === 'thinking');
    const text = appends.find((m) => m.blocks?.[0]?.kind === 'text' && m.role === 'assistant');
    const user = appends.find((m) => m.role === 'user');
    assert.ok(thinking, 'expected thought chunk');
    assert.equal(thinking.blocks[0].text, 'thinking');
    assert.ok(text, 'expected assistant text');
    assert.equal(text.blocks[0].text, 'ack');
    assert.equal(user.blocks[0].text, 'Reply with ack.');
  } finally {
    await rt.shutdown();
  }
});

test('runtime RUN_TERMINAL actually executes echo via the terminal host', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-rt-'));
  const rt = new AcpRuntime(spawnOpts(cwd));
  const appends = [];
  rt.on('append', (msgs) => appends.push(...msgs));
  try {
    await rt.start();
    await rt.prompt('RUN_TERMINAL please');
    const tool = appends.find((m) => m.blocks?.some((b) => b.kind === 'tool_result'));
    assert.ok(tool, 'expected tool result');
    const result = tool.blocks.find((b) => b.kind === 'tool_result');
    assert.match(result.text, /ok/);
  } finally {
    await rt.shutdown();
  }
});

test('runtime session/load resumes the fake session id', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-rt-'));
  const rt = new AcpRuntime(spawnOpts(cwd));
  try {
    await rt.start({ resumeSessionId: 'fake-sess-1' });
    assert.equal(rt.sessionId, 'fake-sess-1');
  } finally {
    await rt.shutdown();
  }
});
