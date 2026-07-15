import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../store/db.js';
import * as agents from '../core/agents.js';
import * as messages from '../core/messages.js';
import * as tasks from '../core/tasks.js';
import * as boundaries from '../core/boundaries.js';
import * as handoffs from '../core/handoffs.js';
import * as streams from '../core/streams.js';

const TASK_STATUS = z.enum(['open', 'claimed', 'in_progress', 'blocked', 'done', 'cancelled']);
const STREAM_STATUS = z.enum(['active', 'closed']);
const MESSAGE_KIND = z.enum(['msg', 'handoff', 'system']);

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

/** Register all 17 collab_* MCP tools. Every handler is a thin adapter over `core/`. */
export function registerAllTools(server: McpServer, db: Db): void {
  // ---- Agent lifecycle ----

  server.registerTool(
    'collab_register',
    {
      description: 'Create or refresh an agent row. Returns {agentId}.',
      inputSchema: {
        harness: z.string(),
        role: z.string().optional(),
        worktree: z.string().optional(),
        branch: z.string().optional(),
        cwd: z.string().optional(),
        capabilities: z.array(z.string()).optional(),
        stream: z.string().optional(),
        agent_id: z.string().optional(),
      },
    },
    async (args) =>
      jsonResult(
        agents.register(db, {
          harness: args.harness,
          role: args.role ?? null,
          worktree: args.worktree ?? null,
          branch: args.branch ?? null,
          cwd: args.cwd ?? null,
          capabilities: args.capabilities,
          stream: args.stream ?? null,
          agentId: args.agent_id,
        }),
      ),
  );

  server.registerTool(
    'collab_heartbeat',
    {
      description: 'Touch last_heartbeat; optionally renew the agent active leases.',
      inputSchema: {
        agent_id: z.string(),
        renew_leases: z.boolean().optional(),
      },
    },
    async (args) => jsonResult(agents.heartbeat(db, { agentId: args.agent_id, renewLeases: args.renew_leases })),
  );

  server.registerTool(
    'collab_directory',
    {
      description: 'List agents with computed live/stale. Excludes gone unless include_stale.',
      inputSchema: {
        stream: z.string().optional(),
        include_stale: z.boolean().optional(),
      },
    },
    async (args) => jsonResult(agents.directory(db, { stream: args.stream ?? null, includeStale: args.include_stale })),
  );

  server.registerTool(
    'collab_deregister',
    {
      description: "Mark an agent gone and release its leases.",
      inputSchema: { agent_id: z.string() },
    },
    async (args) => jsonResult(agents.deregister(db, { agentId: args.agent_id })),
  );

  // ---- Messaging ----

  server.registerTool(
    'collab_send',
    {
      description: 'Send a message. Omit `to` for a broadcast. Returns {messageId}.',
      inputSchema: {
        agent_id: z.string(),
        body: z.string(),
        to: z.string().optional(),
        stream: z.string().optional(),
        kind: MESSAGE_KIND.optional(),
      },
    },
    async (args) =>
      jsonResult(
        messages.send(db, {
          agentId: args.agent_id,
          body: args.body,
          to: args.to ?? null,
          stream: args.stream ?? null,
          kind: args.kind,
        }),
      ),
  );

  server.registerTool(
    'collab_poll',
    {
      description:
        'Poll the inbox. If ack_through given, advance the cursor first. At-least-once: unacked messages redeliver.',
      inputSchema: {
        agent_id: z.string(),
        ack_through: z.number().int().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async (args) => jsonResult(messages.poll(db, { agentId: args.agent_id, ackThrough: args.ack_through, limit: args.limit })),
  );

  // ---- Task board ----

  server.registerTool(
    'collab_task_create',
    {
      description: 'Create an open task. Returns {taskId}.',
      inputSchema: {
        agent_id: z.string(),
        title: z.string(),
        body: z.string().optional(),
        stream: z.string().optional(),
        priority: z.number().int().optional(),
      },
    },
    async (args) =>
      jsonResult(
        tasks.createTask(db, {
          agentId: args.agent_id,
          title: args.title,
          body: args.body ?? null,
          stream: args.stream ?? null,
          priority: args.priority,
        }),
      ),
  );

  server.registerTool(
    'collab_task_list',
    {
      description: 'List tasks, ordered priority DESC, created_at ASC.',
      inputSchema: {
        stream: z.string().optional(),
        status: TASK_STATUS.optional(),
        owner: z.string().optional(),
        mine: z.boolean().optional(),
        agent_id: z.string().optional(),
      },
    },
    async (args) =>
      jsonResult(
        tasks.listTasks(db, {
          stream: args.stream ?? null,
          status: args.status ?? null,
          owner: args.owner ?? null,
          mine: args.mine,
          agentId: args.agent_id ?? null,
        }),
      ),
  );

  server.registerTool(
    'collab_task_claim',
    {
      description: "Atomic conditional claim. Returns {ok, task} or {ok:false, reason:'conflict'}.",
      inputSchema: { agent_id: z.string(), task_id: z.string() },
    },
    async (args) => jsonResult(tasks.claimTask(db, { agentId: args.agent_id, taskId: args.task_id })),
  );

  server.registerTool(
    'collab_task_update',
    {
      description: 'Owner-guarded status/body change; optimistic on expected_version.',
      inputSchema: {
        agent_id: z.string(),
        task_id: z.string(),
        status: TASK_STATUS.optional(),
        body: z.string().optional(),
        expected_version: z.number().int().optional(),
      },
    },
    async (args) =>
      jsonResult(
        tasks.updateTask(db, {
          agentId: args.agent_id,
          taskId: args.task_id,
          status: args.status,
          body: args.body,
          expectedVersion: args.expected_version,
        }),
      ),
  );

  server.registerTool(
    'collab_task_complete',
    {
      description: "Owner-only. Sets status='done'.",
      inputSchema: { agent_id: z.string(), task_id: z.string() },
    },
    async (args) => jsonResult(tasks.completeTask(db, { agentId: args.agent_id, taskId: args.task_id })),
  );

  // ---- Boundaries / worktree leases ----

  server.registerTool(
    'collab_boundary_declare',
    {
      description: 'Advertise ownership of path/glob patterns. Returns {boundaryId, expiresAt}.',
      inputSchema: {
        agent_id: z.string(),
        paths: z.array(z.string()).min(1),
        ttl_sec: z.number().int().positive().optional(),
        stream: z.string().optional(),
        note: z.string().optional(),
      },
    },
    async (args) =>
      jsonResult(
        boundaries.declareBoundary(db, {
          agentId: args.agent_id,
          paths: args.paths,
          ttlSec: args.ttl_sec,
          stream: args.stream ?? null,
          note: args.note ?? null,
        }),
      ),
  );

  server.registerTool(
    'collab_boundary_check',
    {
      description: 'For each concrete path, list conflicting active leases held by other agents.',
      inputSchema: {
        paths: z.array(z.string()).min(1),
        agent_id: z.string().optional(),
        stream: z.string().optional(),
      },
    },
    async (args) => jsonResult(boundaries.checkBoundary(db, { paths: args.paths, agentId: args.agent_id ?? null, stream: args.stream ?? null })),
  );

  server.registerTool(
    'collab_boundary_release',
    {
      description: 'Owner-only. Releases a boundary lease.',
      inputSchema: { agent_id: z.string(), boundary_id: z.string() },
    },
    async (args) => jsonResult(boundaries.releaseBoundary(db, { agentId: args.agent_id, boundaryId: args.boundary_id })),
  );

  // ---- Handoff ----

  server.registerTool(
    'collab_handoff',
    {
      description: 'Reassign a task and/or boundary to another agent and notify them. One transaction.',
      inputSchema: {
        agent_id: z.string(),
        to_agent: z.string(),
        task_id: z.string().optional(),
        boundary_id: z.string().optional(),
        note: z.string().optional(),
      },
    },
    async (args) =>
      jsonResult(
        handoffs.handoff(db, {
          agentId: args.agent_id,
          toAgent: args.to_agent,
          taskId: args.task_id ?? null,
          boundaryId: args.boundary_id ?? null,
          note: args.note ?? null,
        }),
      ),
  );

  // ---- Streams ----

  server.registerTool(
    'collab_stream_create',
    {
      description: 'Create a workstream grouping. Returns {streamId}.',
      inputSchema: { agent_id: z.string(), name: z.string(), description: z.string().optional() },
    },
    async (args) => jsonResult(streams.createStream(db, { agentId: args.agent_id, name: args.name, description: args.description ?? null })),
  );

  server.registerTool(
    'collab_stream_list',
    {
      description: 'List streams.',
      inputSchema: { status: STREAM_STATUS.optional() },
    },
    async (args) => jsonResult(streams.listStreams(db, { status: args.status ?? null })),
  );
}
