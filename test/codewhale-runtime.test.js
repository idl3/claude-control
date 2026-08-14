import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import {
  CODEWHALE_RUNTIME_SOURCE,
  CodeWhaleRuntimeClient,
  CodeWhaleRuntimeSessionSource,
  CodeWhaleRuntimeSubAgentsSource,
  CodeWhaleRuntimeTranscriptSource,
  assertRuntimeCompatible,
  consumeSse,
  normalizeRuntimeSummary,
  normalizeRuntimeSubAgents,
  normalizeThreadDetail,
  runtimeSessionId,
  stripRuntimeInjectedContext,
  threadIdFromRuntimeSession,
} from '../lib/codewhale-runtime.js';

const INFO = {
  runtime_api_version: '1.0',
  codewhale_version: '0.9.5',
  codewhale_commit: '853cb707bbcf4f7dc4268fba6d811e0d04083f9c',
  transports: ['http', 'sse'],
  capabilities: { threads: true, event_replay: true },
};

function detail(agentText = 'OK', latestSeq = 3) {
  return {
    thread: { id: 'thr_test', workspace: '/tmp/project', model: 'gpt-test' },
    turns: [{ id: 'turn_1', status: 'completed' }],
    items: [
      {
        id: 'item_user',
        turn_id: 'turn_1',
        kind: 'user_message',
        status: 'completed',
        detail: 'Reply with exactly OK.\n<turn_meta>hidden runtime context</turn_meta>',
        started_at: '2026-08-12T00:00:00Z',
      },
      {
        id: 'item_agent',
        turn_id: 'turn_1',
        kind: 'agent_message',
        status: 'completed',
        detail: agentText,
        started_at: '2026-08-12T00:00:01Z',
      },
    ],
    latest_seq: latestSeq,
    pending_approvals: [],
    pending_user_inputs: [],
    pending_dynamic_tool_calls: [],
  };
}

test('runtime session ids round-trip without colliding with tmux targets', () => {
  assert.equal(runtimeSessionId('thr_123'), 'codewhale:runtime:thr_123');
  assert.equal(threadIdFromRuntimeSession('codewhale:runtime:thr_123'), 'thr_123');
  assert.equal(threadIdFromRuntimeSession('0:2.1'), null);
});

test('runtime compatibility requires thread discovery and replayable SSE', () => {
  assert.deepEqual(assertRuntimeCompatible(INFO), {
    version: '0.9.5',
    commit: INFO.codewhale_commit,
    runtimeApiVersion: '1.0',
  });
  assert.throws(
    () => assertRuntimeCompatible({ ...INFO, capabilities: { threads: true } }),
    /event_replay/,
  );
  assert.throws(() => assertRuntimeCompatible({ ...INFO, transports: ['http'] }), /SSE/);
});

test('runtime client keeps auth in a header and uses the canonical routes', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new CodeWhaleRuntimeClient({
    baseUrl: 'http://127.0.0.1:7878/',
    token: 'server-secret',
    fetchImpl,
  });

  await client.getThreadDetail('thr id');
  await client.startTurn('thr id', 'hello');
  await client.decideApproval('approval/id', { decision: 'allow', remember: true });

  assert.equal(calls[0].url, 'http://127.0.0.1:7878/v1/threads/thr%20id');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer server-secret');
  assert.doesNotMatch(calls[0].url, /server-secret/);
  assert.equal(calls[1].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].init.body), { prompt: 'hello' });
  assert.equal(calls[2].url, 'http://127.0.0.1:7878/v1/approvals/approval%2Fid');
  assert.deepEqual(JSON.parse(calls[2].init.body), { decision: 'allow', remember: true });
});

test('runtime client rejects credentials embedded in the base URL', () => {
  assert.throws(
    () => new CodeWhaleRuntimeClient({ baseUrl: 'http://user:secret@127.0.0.1:7878' }),
    /must not contain credentials/,
  );
});

test('SSE parser handles chunk boundaries and joined data lines', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'event: item.delta\ndata: {"seq":4,',
    '"thread_id":"thr_test"}\n\nevent: done\ndata: {"seq":5}\n\n',
  ];
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const events = [];
  await consumeSse(body, (event) => events.push(event));
  assert.deepEqual(events, [
    { seq: 4, thread_id: 'thr_test' },
    { seq: 5 },
  ]);
});

test('thread normalization uses stable item UUIDs and removes injected turn metadata', () => {
  const messages = normalizeThreadDetail(detail());
  assert.equal(messages.length, 2);
  assert.equal(messages[0].uuid, 'codewhale:thr_test:item_user');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].blocks[0].text, 'Reply with exactly OK.');
  assert.equal(messages[1].uuid, 'codewhale:thr_test:item_agent');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].blocks[0].text, 'OK');
  assert.equal(stripRuntimeInjectedContext('hello <turn_meta>secret</turn_meta>'), 'hello');
});

test('Runtime lifecycle status is transcript-compliant: chatter is hidden and sub-agent output is a tool receipt', () => {
  const fixture = detail();
  fixture.items.push(
    {
      id: 'tool_agent_start', turn_id: 'turn_1', kind: 'tool_call', status: 'completed',
      summary: 'agent: {"agent_id":"agent_123","status":"running"}',
      detail: '{"agent_id":"agent_123","status":"running"}',
      metadata: { action: 'start', agent_id: 'agent_123', status: 'running' },
      started_at: '2026-08-12T00:00:01Z',
    },
    {
      id: 'status_continue', turn_id: 'turn_1', kind: 'status', status: 'completed',
      detail: 'Continuing — tool results', started_at: '2026-08-12T00:00:02Z',
    },
    {
      id: 'status_progress', turn_id: 'turn_1', kind: 'status', status: 'completed',
      detail: 'Sub-agent agent_123: step 1/20: complete', started_at: '2026-08-12T00:00:03Z',
    },
    {
      id: 'status_done', turn_id: 'turn_1', kind: 'status', status: 'completed',
      detail: 'Sub-agent agent_123 completed: ### SUMMARY\n\n- result: 25\n\n### RISKS\nNone.',
      started_at: '2026-08-12T00:00:04Z',
    },
    {
      id: 'status_resume', turn_id: 'turn_1', kind: 'status', status: 'completed',
      detail: 'Resuming turn with 1 queued sub-agent completion(s)', started_at: '2026-08-12T00:00:05Z',
    },
  );

  const messages = normalizeThreadDetail(fixture);
  assert.equal(messages.length, 4, 'two chat messages, the agent tool use, and its linked result');
  const agentCall = messages[2];
  assert.equal(agentCall.blocks[0].kind, 'tool_use');
  assert.equal(agentCall.blocks[0].id, 'tool_agent_start');
  assert.equal(agentCall.blocks[0].name, 'agent');
  assert.equal(agentCall.blocks[0].inputSummary, 'start · agent_123 · running');
  const receipt = messages[3];
  assert.equal(receipt.uuid, 'codewhale:thr_test:status_done');
  assert.equal(receipt.role, 'assistant');
  assert.deepEqual(receipt.blocks[0], {
    kind: 'tool_result',
    forId: 'tool_agent_start',
    text: '### SUMMARY\n\n- result: 25\n\n### RISKS\nNone.',
    isError: false,
  });
  const transcriptText = JSON.stringify(messages);
  assert.doesNotMatch(transcriptText, /Continuing — tool results/);
  assert.doesNotMatch(transcriptText, /step 1\/20/);
  assert.doesNotMatch(transcriptText, /Resuming turn/);
});

test('Runtime sub-agent snapshot feeds Claude Control Agent panel shape', () => {
  const fixture = detail();
  fixture.items.push(
    {
      id: 'tool_agent_start', turn_id: 'turn_1', kind: 'tool_call', status: 'completed',
      detail: '{"name":"workflow-agent-1","agent_id":"agent_123","status":"running"}',
      metadata: { action: 'start', agent_id: 'agent_123', status: 'running' },
      started_at: '2026-08-12T00:00:01Z',
    },
    {
      id: 'status_spawned', turn_id: 'turn_1', kind: 'status', status: 'completed',
      detail: 'Sub-agent agent_123 spawned: Derive the deterministic seed.',
      started_at: '2026-08-12T00:00:02Z',
    },
    {
      id: 'status_done', turn_id: 'turn_1', kind: 'status', status: 'completed',
      detail: 'Sub-agent agent_123 completed: ### SUMMARY\n\nSeed is 25.',
      started_at: '2026-08-12T00:00:04Z',
    },
  );

  const agents = normalizeRuntimeSubAgents(fixture);
  assert.equal(agents.length, 1);
  assert.deepEqual(agents[0], {
    agentId: 'agent_123',
    toolUseId: 'tool_agent_start',
    agentType: 'workflow-agent-1',
    description: 'Derive the deterministic seed.',
    status: 'done',
    messages: [{
      uuid: 'codewhale-subagent:thr_test:agent_123:status_done',
      role: 'assistant',
      ts: Date.parse('2026-08-12T00:00:04Z'),
      blocks: [{ kind: 'text', text: '### SUMMARY\n\nSeed is 25.' }],
      rawType: 'codewhale:subagent.completed',
    }],
    messagesLoaded: true,
    createdAt: Date.parse('2026-08-12T00:00:01Z'),
    model: 'gpt-test',
    def: null,
    nested: [],
  });
});

test('Runtime sub-agent source emits changed agents and supports panel load()', async () => {
  const source = new CodeWhaleRuntimeSubAgentsSource();
  const fixture = detail();
  fixture.items.push({
    id: 'tool_agent_start', turn_id: 'turn_1', kind: 'tool_call', status: 'completed',
    detail: '{"name":"worker-one","agent_id":"agent_123","status":"running"}',
    metadata: { action: 'start', agent_id: 'agent_123', status: 'running' },
    started_at: '2026-08-12T00:00:01Z',
  });
  const changed = once(source, 'change');
  source.update(fixture);
  const [entry] = await changed;
  assert.equal(entry.agentId, 'agent_123');
  assert.equal(entry.status, 'running');
  assert.deepEqual(source.snapshot(), [entry]);
  assert.deepEqual(await source.load('agent_123'), entry);
  assert.equal(await source.load('unknown'), null);
});

test('runtime summary becomes a CodeWhale thread presentation, not a terminal row', () => {
  const row = normalizeRuntimeSummary({
    id: 'thr_test',
    title: 'Reply with exactly OK.\n<turn_meta>hidden</turn_meta>',
    preview: 'OK',
    model: 'gpt-test',
    workspace: '/tmp/project',
    updated_at: '2026-08-12T00:00:00Z',
    latest_turn_status: 'completed',
  });
  assert.equal(row.id, 'codewhale:runtime:thr_test');
  assert.equal(row.kind, 'codewhale');
  assert.equal(row.presentation, 'thread');
  assert.equal(row.transport, 'codewhale-http-sse');
  assert.equal(row.name, 'Reply with exactly OK.');
  assert.equal(row.thinking, false);
});

test('session source publishes compatible Runtime threads through the external-session seam', async () => {
  const calls = [];
  const registry = {
    setExternalSessions(source, rows) { calls.push({ source, rows }); },
  };
  const client = {
    runtimeInfo: async () => INFO,
    listThreadSummaries: async () => [{
      id: 'thr_test', title: 'Test thread', preview: 'OK', model: 'gpt-test',
      workspace: '/tmp/project', updated_at: '2026-08-12T00:00:00Z', latest_turn_status: 'completed',
    }],
  };
  const source = new CodeWhaleRuntimeSessionSource(client, registry);
  await source.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, CODEWHALE_RUNTIME_SOURCE);
  assert.equal(calls[0].rows[0].presentation, 'thread');
  assert.equal(source.health().status, 'green');
});

test('transcript source hydrates a snapshot then upserts a materialized Runtime item', async () => {
  let detailCalls = 0;
  const client = {
    getThreadDetail: async () => {
      detailCalls += 1;
      return detailCalls === 1 ? detail('O', 3) : detail('OK', 4);
    },
    streamThreadEvents: async (_threadId, sinceSeq, { signal, onEvent }) => {
      assert.equal(sinceSeq, 3);
      await onEvent({
        seq: 4,
        previous_seq: 3,
        thread_id: 'thr_test',
        event: 'item.delta',
        item_id: 'item_agent',
      });
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  };
  const source = new CodeWhaleRuntimeTranscriptSource(client, { threadId: 'thr_test' });
  const changed = once(source, 'upsert');
  await source.start();
  const [messages] = await changed;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].uuid, 'codewhale:thr_test:item_agent');
  assert.equal(messages[0].blocks[0].text, 'OK');
  source.stop();
});

test('transcript source resnapshots on a previous_seq discontinuity', async () => {
  let detailCalls = 0;
  let streamCalls = 0;
  const client = {
    getThreadDetail: async () => {
      detailCalls += 1;
      return detail(detailCalls === 1 ? 'before gap' : 'after gap', detailCalls === 1 ? 3 : 8);
    },
    streamThreadEvents: async (_threadId, _sinceSeq, { signal, onEvent }) => {
      streamCalls += 1;
      if (streamCalls === 1) {
        await onEvent({
          seq: 8,
          previous_seq: 2,
          thread_id: 'thr_test',
          event: 'item.completed',
        });
        return;
      }
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  };
  const source = new CodeWhaleRuntimeTranscriptSource(client, { threadId: 'thr_test' });
  const reset = once(source, 'reset');
  await source.start();
  const [messages] = await reset;
  assert.equal(messages[1].blocks[0].text, 'after gap');
  assert.equal(detailCalls, 2);
  source.stop();
});

test('transcript source hydrates Runtime approvals as an actionable pending question', async () => {
  const approvals = [{
    id: 'approval_agent_1',
    turn_id: 'turn_1',
    tool_name: 'agent',
    description: 'Start Agent 1 for the workflow',
    intent_summary: 'Launch the first workflow agent',
  }];
  const decisions = [];
  let pendingApprovals = approvals;
  const client = {
    getThreadDetail: async () => ({ ...detail(), pending_approvals: pendingApprovals }),
    streamThreadEvents: async (_threadId, _sinceSeq, { signal }) => {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
    decideApproval: async (approvalId, decision) => {
      decisions.push({ approvalId, decision });
      pendingApprovals = [];
      return { ok: true, delivered: true };
    },
  };
  const source = new CodeWhaleRuntimeTranscriptSource(client, { threadId: 'thr_test' });
  await source.start();
  const pending = source.getPending();
  assert.equal(pending.toolUseId, 'codewhale-approval:approval_agent_1');
  assert.equal(pending.questions[0].header, 'Approval required · agent');
  assert.match(pending.questions[0].question, /Launch the first workflow agent/);
  assert.deepEqual(pending.questions[0].options.map((option) => option.label), [
    'Allow once',
    'Always allow for this thread',
    'Deny',
  ]);

  await source.answerPending(pending.toolUseId, [['Always allow for this thread']]);
  assert.deepEqual(decisions, [{
    approvalId: 'approval_agent_1',
    decision: { decision: 'allow', remember: true },
  }]);
  assert.equal(source.getPending(), null);
  source.stop();
});

test('approval.required refresh emits pending and settlement clears it', async () => {
  const approval = {
    id: 'approval_agent_2', turn_id: 'turn_1', tool_name: 'agent',
    description: 'Start another workflow agent',
  };
  let snapshot = detail('OK', 3);
  const client = {
    getThreadDetail: async () => snapshot,
    streamThreadEvents: async (_threadId, sinceSeq, { signal, onEvent }) => {
      assert.equal(sinceSeq, 3);
      snapshot = { ...detail('OK', 4), pending_approvals: [approval] };
      await onEvent({
        seq: 4, previous_seq: 3, thread_id: 'thr_test', event: 'approval.required',
      });
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  };
  const source = new CodeWhaleRuntimeTranscriptSource(client, { threadId: 'thr_test' });
  const pendingEvent = once(source, 'pending');
  await source.start();
  const [pending] = await pendingEvent;
  assert.equal(pending.toolUseId, 'codewhale-approval:approval_agent_2');
  source.stop();
});
