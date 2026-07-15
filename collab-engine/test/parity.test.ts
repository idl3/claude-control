/**
 * CLI-vs-core parity: proves the CLI is a genuinely thin adapter over the
 * same schema/semantics as `core/`, not a look-alike reimplementation.
 * Strategy: interleave writes across BOTH paths against one shared DB file
 * and assert cross-path operations succeed and are mutually visible —
 * e.g. a task created by the CLI can be claimed via core, and a task
 * created via core can be claimed by the CLI, with identical resulting
 * store state either way. Spawning the real CLI subprocess (not calling its
 * internals in-process) proves the shim actually works end-to-end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/store/db.js';
import * as agentsCore from '../src/core/agents.js';
import * as tasksCore from '../src/core/tasks.js';
import * as boundariesCore from '../src/core/boundaries.js';
import * as messagesCore from '../src/core/messages.js';

const CLI_PATH = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));

function runCli(dbPath: string, args: string[]): unknown {
  const res = spawnSync(process.execPath, ['--import', 'tsx', CLI_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, COLLAB_DB: dbPath },
  });
  assert.equal(res.status, 0, `CLI exited ${res.status}: stderr=${res.stderr}`);
  const lastLine = res.stdout.trim().split('\n').at(-1)!;
  return JSON.parse(lastLine);
}

function freshDbPath(prefix: string): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dbPath: join(dir, 'collab.db') };
}

test('parity: register — CLI-registered and core-registered agents are structurally identical', () => {
  const { dir, dbPath } = freshDbPath('collab-parity-register-');
  try {
    const cliResult = runCli(dbPath, [
      'register',
      '--agent-id', 'cli-a',
      '--harness', 'test-harness',
      '--role', 'implementer',
      '--capabilities', 'ts', 'sql',
    ]) as { ok: true; agentId: string };
    assert.equal(cliResult.ok, true);
    assert.equal(cliResult.agentId, 'cli-a');

    const db = openDb(dbPath);
    const coreResult = agentsCore.register(db, {
      agentId: 'core-a',
      harness: 'test-harness',
      role: 'implementer',
      capabilities: ['ts', 'sql'],
    });
    assert.equal(coreResult.ok, true);

    const viaCliAgent = agentsCore.getAgent(db, cliResult.agentId);
    const viaCoreAgent = agentsCore.getAgent(db, coreResult.agentId);
    assert.ok(viaCliAgent);
    assert.ok(viaCoreAgent);
    // Same shape modulo id/timestamps: the CLI wrote a row core reads identically.
    assert.equal(viaCliAgent!.harness, viaCoreAgent!.harness);
    assert.equal(viaCliAgent!.role, viaCoreAgent!.role);
    assert.deepEqual(viaCliAgent!.capabilities, viaCoreAgent!.capabilities);
    assert.equal(viaCliAgent!.status, viaCoreAgent!.status);
    assert.equal(viaCliAgent!.inboxCursor, viaCoreAgent!.inboxCursor);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parity: task_create + task_claim — cross-path claim succeeds and is visible on both sides', () => {
  const { dir, dbPath } = freshDbPath('collab-parity-task-');
  try {
    runCli(dbPath, ['register', '--agent-id', 'cli-a', '--harness', 'test-harness']);
    const db = openDb(dbPath);
    agentsCore.register(db, { agentId: 'core-a', harness: 'test-harness' });

    // CLI creates a task; CORE claims it.
    const created1 = runCli(dbPath, ['task', 'create', '--agent', 'cli-a', '--title', 'cli-created task']) as {
      ok: true;
      taskId: string;
    };
    const claimed1 = tasksCore.claimTask(db, { agentId: 'core-a', taskId: created1.taskId });
    assert.equal(claimed1.ok, true);
    if (claimed1.ok) {
      assert.equal(claimed1.task.status, 'claimed');
      assert.equal(claimed1.task.ownerAgentId, 'core-a');
    }
    // Verify the CLI itself can see the core-side claim.
    const listed1 = runCli(dbPath, ['task', 'list', '--status', 'claimed']) as { ok: true; tasks: { id: string; ownerAgentId: string }[] };
    const seen1 = listed1.tasks.find((t) => t.id === created1.taskId);
    assert.ok(seen1, 'CLI task list must see the core-side claim');
    assert.equal(seen1!.ownerAgentId, 'core-a');

    // CORE creates a task; CLI claims it.
    const created2 = tasksCore.createTask(db, { agentId: 'core-a', title: 'core-created task' });
    const claimed2 = runCli(dbPath, ['task', 'claim', '--agent', 'cli-a', '--task', created2.taskId]) as {
      ok: true;
      task: { status: string; ownerAgentId: string };
    };
    assert.equal(claimed2.ok, true);
    assert.equal(claimed2.task.status, 'claimed');
    assert.equal(claimed2.task.ownerAgentId, 'cli-a');
    // Verify via core directly.
    const viaCore = tasksCore.getTask(db, created2.taskId);
    assert.equal(viaCore!.ownerAgentId, 'cli-a');
    assert.equal(viaCore!.status, 'claimed');

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parity: boundary_declare — cross-path declare is enforced by checkBoundary on both sides', () => {
  const { dir, dbPath } = freshDbPath('collab-parity-boundary-');
  try {
    runCli(dbPath, ['register', '--agent-id', 'cli-a', '--harness', 'test-harness']);
    const db = openDb(dbPath);
    agentsCore.register(db, { agentId: 'core-a', harness: 'test-harness' });

    // CLI declares a lease; CORE's checkBoundary must see the conflict.
    const declared1 = runCli(dbPath, ['boundary', 'declare', '--agent', 'cli-a', '--paths', 'src/parity/**']) as {
      ok: true;
      boundaryId: string;
    };
    const conflicts1 = boundariesCore.checkBoundary(db, { paths: ['src/parity/thing.ts'], agentId: 'core-a' });
    assert.equal(conflicts1.conflicts.length, 1);
    assert.equal(conflicts1.conflicts[0]!.boundaryId, declared1.boundaryId);
    assert.equal(conflicts1.conflicts[0]!.owner, 'cli-a');

    // CORE declares a lease; the CLI's `boundary check` must see the conflict.
    const declared2 = boundariesCore.declareBoundary(db, { agentId: 'core-a', paths: ['web/parity/**'] });
    const conflicts2 = runCli(dbPath, ['boundary', 'check', '--paths', 'web/parity/thing.tsx', '--agent', 'cli-a']) as {
      ok: true;
      conflicts: { boundaryId: string; owner: string }[];
    };
    assert.equal(conflicts2.conflicts.length, 1);
    assert.equal(conflicts2.conflicts[0]!.boundaryId, declared2.boundaryId);
    assert.equal(conflicts2.conflicts[0]!.owner, 'core-a');

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parity: send/poll — CLI-sent message is polled via core, and core-sent message is polled via CLI', () => {
  const { dir, dbPath } = freshDbPath('collab-parity-message-');
  try {
    runCli(dbPath, ['register', '--agent-id', 'cli-a', '--harness', 'test-harness']);
    const db = openDb(dbPath);
    agentsCore.register(db, { agentId: 'core-a', harness: 'test-harness' });

    // CLI sends cli-a -> core-a; core polls it.
    const sent1 = runCli(dbPath, ['send', '--agent', 'cli-a', '--to', 'core-a', '--body', 'hello from cli']) as {
      ok: true;
      messageId: number;
    };
    const polled1 = messagesCore.poll(db, { agentId: 'core-a' });
    assert.equal(polled1.messages.length, 1);
    assert.equal(polled1.messages[0]!.id, sent1.messageId);
    assert.equal(polled1.messages[0]!.body, 'hello from cli');
    assert.equal(polled1.messages[0]!.fromAgent, 'cli-a');

    // core sends core-a -> cli-a; the CLI polls it.
    const sent2 = messagesCore.send(db, { agentId: 'core-a', to: 'cli-a', body: 'hello from core' });
    const polled2 = runCli(dbPath, ['poll', '--agent', 'cli-a']) as {
      ok: true;
      messages: { id: number; body: string; fromAgent: string }[];
    };
    assert.equal(polled2.messages.length, 1);
    assert.equal(polled2.messages[0]!.id, sent2.messageId);
    assert.equal(polled2.messages[0]!.body, 'hello from core');
    assert.equal(polled2.messages[0]!.fromAgent, 'core-a');

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
