import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SessionRegistry } from '../lib/sessions.js';
import { AcpRegistry } from '../lib/acp/registry.js';
import { AcpRuntime } from '../lib/acp/runtime.js';
import { buildGrokSpawn, grokAuthMethodId, GROK_AUTH_API_KEY, GROK_AUTH_CACHED_TOKEN } from '../lib/acp/adapters/grok.js';
import { buildCodexAcpSpawn } from '../lib/acp/adapters/codex.js';
import { isValidTarget } from '../lib/tmux.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(__dirname, 'fixtures', 'fake-acp-agent.mjs');

function sessionReg() {
  return new SessionRegistry({
    projectsRoot: '/nonexistent',
    tmux: { listPanes: async () => [], listWindows: async () => [] },
  });
}

function acpReg(sessionRegistry) {
  return new AcpRegistry({
    sessionRegistry,
    skipPermissions: true,
    createRuntime: (opts) => new AcpRuntime({
      ...opts,
      command: process.execPath,
      args: [FAKE_AGENT],
      skipPermissions: true,
    }),
  });
}

test('buildGrokSpawn uses agent --no-leader stdio and always-approve when skipPermissions', () => {
  const { command, args } = buildGrokSpawn({ skipPermissions: true, model: 'grok-build' });
  assert.equal(command, 'grok');
  assert.deepEqual(args, ['-m', 'grok-build', 'agent', '--no-leader', '--always-approve', 'stdio']);
});

test('buildGrokSpawn omits always-approve when skipPermissions is off', () => {
  const { args } = buildGrokSpawn({ skipPermissions: false });
  assert.deepEqual(args, ['agent', '--no-leader', 'stdio']);
});

test('grokAuthMethodId prefers XAI_API_KEY', () => {
  assert.equal(grokAuthMethodId({ XAI_API_KEY: 'xai-test' }), GROK_AUTH_API_KEY);
  assert.equal(grokAuthMethodId({}), GROK_AUTH_CACHED_TOKEN);
});

test('buildCodexAcpSpawn sets NO_BROWSER and full-access when skipPermissions', () => {
  const { command, args, env } = buildCodexAcpSpawn({ skipPermissions: true, codexPath: '/bin/codex' });
  assert.equal(command, 'codex-acp');
  assert.deepEqual(args, []);
  assert.equal(env.NO_BROWSER, '1');
  assert.equal(env.INITIAL_AGENT_MODE, 'agent-full-access');
  assert.equal(env.CODEX_PATH, '/bin/codex');
});

test('AcpRegistry.create publishes a grok ACP row that is not a tmux target', async () => {
  const sessions = sessionReg();
  const acp = acpReg(sessions);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-reg-'));
  try {
    const row = await acp.create({ kind: 'grok', cwd, name: 'probe' });
    assert.equal(row.kind, 'grok');
    assert.equal(row.transport, 'acp');
    assert.equal(row.name, 'probe');
    assert.equal(isValidTarget(row.id), false);
    assert.match(row.id, /^acp:grok:/);
    assert.equal(row.sessionId, 'fake-sess-1');
    const listed = sessions.getSessions().find((s) => s.id === row.id);
    assert.ok(listed);
    assert.equal(listed.transport, 'acp');
  } finally {
    await acp.shutdownAll();
  }
});

test('AcpRegistry.prompt stores user + assistant messages for subscribe snapshot', async () => {
  const sessions = sessionReg();
  const acp = acpReg(sessions);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-reg-'));
  try {
    const row = await acp.create({ kind: 'grok', cwd, name: 'chat' });
    await acp.prompt(row.id, 'hello');
    const msgs = acp.get(row.id).messages;
    assert.ok(msgs.some((m) => m.role === 'user' && m.blocks[0].text === 'hello'));
    assert.ok(msgs.some((m) => m.blocks[0]?.kind === 'text' && m.role === 'assistant'));
  } finally {
    await acp.shutdownAll();
  }
});

test('AcpRegistry persists meta+history and restore rehydrates a disconnected row', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-data-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-reg-'));
  const sessions1 = sessionReg();
  const acp1 = acpReg(sessions1);
  acp1._dataDir = dataDir;
  let id;
  try {
    const row = await acp1.create({ kind: 'grok', cwd, name: 'kept', prompt: 'hello' });
    id = row.id;
    await acp1.shutdownAll();
  } finally {
    await acp1.shutdownAll();
  }
  const sessions2 = sessionReg();
  const acp2 = acpReg(sessions2);
  acp2._dataDir = dataDir;
  try {
    await acp2.restore();
    const listed = sessions2.getSessions().find((s) => s.id === id);
    assert.ok(listed);
    assert.equal(listed.name, 'kept');
    assert.equal(listed.transport, 'acp');
    const msgs = acp2.get(id).messages;
    assert.ok(msgs.some((m) => m.role === 'user'));
  } finally {
    await acp2.shutdownAll();
  }
});

test('AcpRegistry.create with initial prompt delivers it as the first turn', async () => {
  const sessions = sessionReg();
  const acp = acpReg(sessions);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-reg-'));
  try {
    const row = await acp.create({ kind: 'grok', cwd, name: 'first', prompt: 'Reply with ack.' });
    const msgs = acp.get(row.id).messages;
    assert.ok(msgs.some((m) => m.role === 'user'));
    assert.ok(msgs.some((m) => m.role === 'assistant' && m.blocks[0]?.text === 'ack'));
  } finally {
    await acp.shutdownAll();
  }
});

// --- Claude ACP (claude-agent-acp) ---
import { buildClaudeAcpSpawn, CLAUDE_ACP_BYPASS_MODE } from '../lib/acp/adapters/claude.js';

test('buildClaudeAcpSpawn passes model via ANTHROPIC_MODEL and requests bypass mode when skipPermissions', () => {
  const { command, args, env, initialModeId } = buildClaudeAcpSpawn({ skipPermissions: true, model: 'claude-opus-5-5', env: {} });
  assert.equal(command, 'claude-agent-acp');
  assert.deepEqual(args, []);
  assert.equal(env.ANTHROPIC_MODEL, 'claude-opus-5-5');
  assert.equal(env.NO_BROWSER, '1');
  assert.equal(initialModeId, CLAUDE_ACP_BYPASS_MODE);
});

test('buildClaudeAcpSpawn leaves ANTHROPIC_MODEL unset for default model and no mode when permissions kept', () => {
  const { env, initialModeId } = buildClaudeAcpSpawn({ skipPermissions: false, model: null, env: {} });
  assert.equal(env.ANTHROPIC_MODEL, undefined);
  assert.equal(initialModeId, null);
});

test('AcpRegistry.create kind=claude spawns, survives an agent without session/set_mode, and publishes a claude row', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-claude-'));
  const reg = sessionReg();
  const acp = acpReg(reg);
  try {
    const row = await acp.create({ kind: 'claude', cwd, name: 'cc-acp', model: 'claude-fable-5-1' });
    assert.equal(row.kind, 'claude');
    assert.equal(row.transport, 'acp');
    assert.equal(row.model, 'claude-fable-5-1');
    assert.ok(row.sessionId);
  } finally {
    await acp.shutdownAll();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
