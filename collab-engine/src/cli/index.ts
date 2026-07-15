#!/usr/bin/env node
import { openDb, resolveDbPath } from '../store/db.js';
import * as agentsCore from '../core/agents.js';
import * as messagesCore from '../core/messages.js';
import * as tasksCore from '../core/tasks.js';
import * as boundariesCore from '../core/boundaries.js';
import * as handoffsCore from '../core/handoffs.js';
import * as streamsCore from '../core/streams.js';
import type { TaskStatus, StreamStatus, MessageKind } from '../core/types.js';

type FlagValue = string | string[] | boolean;
type Flags = Record<string, FlagValue>;

/** Minimal hand parser: `--flag value...` groups consecutive non-flag tokens as the value. */
function parseFlags(tokens: string[]): Flags {
  const out: Flags = {};
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const values: string[] = [];
      i++;
      while (i < tokens.length && !tokens[i]!.startsWith('--')) {
        values.push(tokens[i]!);
        i++;
      }
      if (values.length === 0) out[key] = true;
      else if (values.length === 1) out[key] = values[0]!;
      else out[key] = values;
    } else {
      i++;
    }
  }
  return out;
}

function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  if (v === undefined || typeof v === 'boolean') return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function arr(flags: Flags, key: string): string[] | undefined {
  const v = flags[key];
  if (v === undefined || typeof v === 'boolean') return undefined;
  return Array.isArray(v) ? v : [v];
}

function bool(flags: Flags, key: string): boolean {
  return flags[key] === true || flags[key] === 'true';
}

function num(flags: Flags, key: string): number | undefined {
  const v = str(flags, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

function fail(message: string): never {
  process.stderr.write(`[collab] error: ${message}\n`);
  process.exit(1);
}

function print(value: unknown, pretty: boolean): void {
  process.stdout.write(pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value));
  process.stdout.write('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    fail('no command given. See README.md for usage.');
  }

  // Two-level subcommands (task/boundary/stream) consume 2 leading words; everything
  // else consumes 1. `serve` never touches flags/db.
  const twoWord = new Set(['task', 'boundary', 'stream']);
  const head = argv[0]!;

  if (head === 'serve') {
    await import('../mcp/server.js');
    return;
  }

  let command: string;
  let rest: string[];
  if (twoWord.has(head)) {
    command = `${head} ${argv[1] ?? ''}`.trim();
    rest = argv.slice(2);
  } else {
    command = head;
    rest = argv.slice(1);
  }

  const flags = parseFlags(rest);
  const pretty = bool(flags, 'pretty');
  const db = openDb(resolveDbPath());

  switch (command) {
    case 'register': {
      const harness = str(flags, 'harness');
      if (!harness) fail('--harness is required');
      print(
        agentsCore.register(db, {
          harness: harness!,
          role: str(flags, 'role') ?? null,
          worktree: str(flags, 'worktree') ?? null,
          branch: str(flags, 'branch') ?? null,
          cwd: str(flags, 'cwd') ?? null,
          capabilities: arr(flags, 'capabilities'),
          stream: str(flags, 'stream') ?? null,
          agentId: str(flags, 'agent-id'),
        }),
        pretty,
      );
      break;
    }

    case 'heartbeat': {
      const agentId = str(flags, 'agent');
      if (!agentId) fail('--agent is required');
      print(agentsCore.heartbeat(db, { agentId: agentId!, renewLeases: bool(flags, 'renew-leases') }), pretty);
      break;
    }

    case 'dir': {
      print(
        agentsCore.directory(db, { stream: str(flags, 'stream') ?? null, includeStale: bool(flags, 'include-stale') }),
        pretty,
      );
      break;
    }

    case 'deregister': {
      const agentId = str(flags, 'agent');
      if (!agentId) fail('--agent is required');
      print(agentsCore.deregister(db, { agentId: agentId! }), pretty);
      break;
    }

    case 'send': {
      const agentId = str(flags, 'agent');
      const body = str(flags, 'body');
      if (!agentId) fail('--agent is required');
      if (!body) fail('--body is required');
      print(
        messagesCore.send(db, {
          agentId: agentId!,
          body: body!,
          to: str(flags, 'to') ?? null,
          stream: str(flags, 'stream') ?? null,
          kind: str(flags, 'kind') as MessageKind | undefined,
        }),
        pretty,
      );
      break;
    }

    case 'poll': {
      const agentId = str(flags, 'agent');
      if (!agentId) fail('--agent is required');
      print(
        messagesCore.poll(db, { agentId: agentId!, ackThrough: num(flags, 'ack-through'), limit: num(flags, 'limit') }),
        pretty,
      );
      break;
    }

    case 'task create': {
      const agentId = str(flags, 'agent');
      const title = str(flags, 'title');
      if (!agentId) fail('--agent is required');
      if (!title) fail('--title is required');
      print(
        tasksCore.createTask(db, {
          agentId: agentId!,
          title: title!,
          body: str(flags, 'body') ?? null,
          stream: str(flags, 'stream') ?? null,
          priority: num(flags, 'priority'),
        }),
        pretty,
      );
      break;
    }

    case 'task list': {
      print(
        tasksCore.listTasks(db, {
          stream: str(flags, 'stream') ?? null,
          status: (str(flags, 'status') as TaskStatus | undefined) ?? null,
          owner: str(flags, 'owner') ?? null,
          mine: bool(flags, 'mine'),
          agentId: str(flags, 'agent') ?? null,
        }),
        pretty,
      );
      break;
    }

    case 'task claim': {
      const agentId = str(flags, 'agent');
      const taskId = str(flags, 'task');
      if (!agentId) fail('--agent is required');
      if (!taskId) fail('--task is required');
      print(tasksCore.claimTask(db, { agentId: agentId!, taskId: taskId! }), pretty);
      break;
    }

    case 'task update': {
      const agentId = str(flags, 'agent');
      const taskId = str(flags, 'task');
      if (!agentId) fail('--agent is required');
      if (!taskId) fail('--task is required');
      print(
        tasksCore.updateTask(db, {
          agentId: agentId!,
          taskId: taskId!,
          status: str(flags, 'status') as TaskStatus | undefined,
          body: str(flags, 'body'),
          expectedVersion: num(flags, 'expected-version'),
        }),
        pretty,
      );
      break;
    }

    case 'task complete': {
      const agentId = str(flags, 'agent');
      const taskId = str(flags, 'task');
      if (!agentId) fail('--agent is required');
      if (!taskId) fail('--task is required');
      print(tasksCore.completeTask(db, { agentId: agentId!, taskId: taskId! }), pretty);
      break;
    }

    case 'boundary declare': {
      const agentId = str(flags, 'agent');
      const paths = arr(flags, 'paths');
      if (!agentId) fail('--agent is required');
      if (!paths || paths.length === 0) fail('--paths is required');
      print(
        boundariesCore.declareBoundary(db, {
          agentId: agentId!,
          paths: paths!,
          ttlSec: num(flags, 'ttl'),
          stream: str(flags, 'stream') ?? null,
          note: str(flags, 'note') ?? null,
        }),
        pretty,
      );
      break;
    }

    case 'boundary check': {
      const paths = arr(flags, 'paths');
      if (!paths || paths.length === 0) fail('--paths is required');
      print(
        boundariesCore.checkBoundary(db, { paths: paths!, agentId: str(flags, 'agent') ?? null, stream: str(flags, 'stream') ?? null }),
        pretty,
      );
      break;
    }

    case 'boundary release': {
      const agentId = str(flags, 'agent');
      const boundaryId = str(flags, 'boundary');
      if (!agentId) fail('--agent is required');
      if (!boundaryId) fail('--boundary is required');
      print(boundariesCore.releaseBoundary(db, { agentId: agentId!, boundaryId: boundaryId! }), pretty);
      break;
    }

    case 'handoff': {
      const agentId = str(flags, 'agent');
      const toAgent = str(flags, 'to');
      if (!agentId) fail('--agent is required');
      if (!toAgent) fail('--to is required');
      print(
        handoffsCore.handoff(db, {
          agentId: agentId!,
          toAgent: toAgent!,
          taskId: str(flags, 'task') ?? null,
          boundaryId: str(flags, 'boundary') ?? null,
          note: str(flags, 'note') ?? null,
        }),
        pretty,
      );
      break;
    }

    case 'stream create': {
      const agentId = str(flags, 'agent');
      const name = str(flags, 'name');
      if (!agentId) fail('--agent is required');
      if (!name) fail('--name is required');
      print(streamsCore.createStream(db, { agentId: agentId!, name: name!, description: str(flags, 'description') ?? null }), pretty);
      break;
    }

    case 'stream list': {
      print(streamsCore.listStreams(db, { status: (str(flags, 'status') as StreamStatus | undefined) ?? null }), pretty);
      break;
    }

    default:
      fail(`unknown command: ${command}`);
  }
}

main().catch((err) => {
  process.stderr.write(`[collab] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
