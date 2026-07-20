import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  computeWorkflowActivity,
  deriveWorkflowSummary,
  loadWorkflowAgentMessages,
  _resetWorkflowCache,
  _workflowParseCountForTest,
  _workflowCacheSizeForTest,
} from '../lib/workflows.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPECIMEN = path.join(__dirname, 'fixtures', 'workflows', 'wf_dc36fa0e-3c0.json');
// New-format fixture (mid-run snapshot: 6 agents, 5 with `result` = done, 1
// `started`-only = running), built from a REAL Claude Code Workflow run dir:
//   fixtures/workflows-new/<runId>/journal.jsonl + agent-*.meta.json (+ one
//   agent transcript for the model sniff), and fixtures/workflows-new/scripts/.
const NEW_FIX = path.join(__dirname, 'fixtures', 'workflows-new');
const NEW_RUNID = 'wf_1f7d2b2b-03d';

// ---------------------------------------------------------------------------
// Helpers — lay out a tmp session dir the way Claude Code does:
//   <tmp>/<sessionId>.jsonl                       ← parent transcript (path arg)
//   <tmp>/<sessionId>/workflows/wf_<runId>.json   ← run docs
// computeWorkflowActivity derives the workflows dir from transcriptPath exactly
// as lib/subagents.js derives subagents/ — so we exercise that real derivation.
// ---------------------------------------------------------------------------
function makeSession() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflows-test-'));
  const sessionId = 'sess-' + Math.random().toString(36).slice(2, 8);
  const transcriptPath = path.join(root, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, ''); // parent may be empty
  const wfDir = path.join(root, sessionId, 'workflows');
  fs.mkdirSync(wfDir, { recursive: true });
  return { root, transcriptPath, wfDir };
}

function writeRun(wfDir, runId, doc) {
  fs.writeFileSync(path.join(wfDir, `wf_${runId}.json`), JSON.stringify(doc));
}

/** Minimal synthetic run doc. `agents` is a flat list; phases derived from them. */
function makeRunDoc({ runId, name = 'wf', status = 'running', startTime = 1000, phases = [], agents = [] }) {
  const progress = [];
  for (const p of phases) progress.push({ type: 'workflow_phase', index: p.index, title: p.title });
  for (const a of agents) progress.push({ type: 'workflow_agent', ...a });
  return {
    runId,
    workflowName: name,
    summary: `${name} summary`,
    status,
    agentCount: agents.length,
    startTime,
    durationMs: 5000,
    totalTokens: 1234,
    totalToolCalls: 9,
    defaultModel: 'claude-fable-5',
    script: 'x'.repeat(5000), // huge — must be ignored, never surfaced
    phases,
    workflowProgress: progress,
  };
}

// ---------------------------------------------------------------------------
// New-format helpers — lay out a tmp session the way the CURRENT Claude Code
// writes a Workflow run:
//   <tmp>/<sessionId>.jsonl                                        ← parent
//   <tmp>/<sessionId>/subagents/workflows/<runId>/journal.jsonl    ← events
//   <tmp>/<sessionId>/subagents/workflows/<runId>/agent-<id>.*     ← meta/transcript
//   <tmp>/<sessionId>/workflows/scripts/<name>-<runId>.js          ← run script
// ---------------------------------------------------------------------------
function cpDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    if (fs.statSync(s).isDirectory()) cpDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** A tmp session pre-populated from the real new-format fixture (mid-run). */
function makeNewSession() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflows-new-'));
  const sessionId = 'sess-' + Math.random().toString(36).slice(2, 8);
  const transcriptPath = path.join(root, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, '');
  const base = path.join(root, sessionId);
  cpDir(path.join(NEW_FIX, NEW_RUNID), path.join(base, 'subagents', 'workflows', NEW_RUNID));
  cpDir(path.join(NEW_FIX, 'scripts'), path.join(base, 'workflows', 'scripts'));
  return { root, transcriptPath, base };
}

/** Write a bare new-format run dir (journal only) from a list of {agentId,type} events. */
function writeNewRun(base, runId, events) {
  const dir = path.join(base, 'subagents', 'workflows', runId);
  fs.mkdirSync(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e));
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), lines.join('\n') + '\n');
  return dir;
}

// ===========================================================================
// 1. Phase-grouping against the REAL specimen (completed, 1 phase × 6 agents).
// ===========================================================================
test('specimen: 1 completed run, phase-grouped with 6 done agents + joined detail', () => {
  _resetWorkflowCache();
  const { transcriptPath, wfDir } = makeSession();
  fs.copyFileSync(SPECIMEN, path.join(wfDir, 'wf_dc36fa0e-3c0.json'));

  const runs = computeWorkflowActivity({ transcriptPath });
  assert.equal(runs.length, 1);

  const run = runs[0];
  assert.equal(run.runId, 'wf_dc36fa0e-3c0');
  assert.equal(run.status, 'completed');
  assert.equal(run.active, false);
  assert.equal(run.workflowName, 'claudex-plan-review-fanout');
  assert.equal(run.agentCount, 6);
  assert.equal(run.total, 6);
  assert.equal(run.done, 6);
  assert.equal(run.totalTokens, 818842);

  // one phase "Review", detail joined from top-level phases[]
  assert.equal(run.phases.length, 1);
  const phase = run.phases[0];
  assert.equal(phase.index, 1);
  assert.equal(phase.title, 'Review');
  assert.equal(phase.detail, 'six plan-aware reviewers in parallel');
  assert.equal(phase.agents.length, 6);

  // every agent is done and carries the rich per-agent fields
  for (const ag of phase.agents) {
    assert.equal(ag.state, 'done');
    assert.ok(ag.agentType, 'agentType present');
    assert.ok(ag.model, 'model present');
    assert.equal(typeof ag.tokens, 'number');
    assert.equal(typeof ag.durationMs, 'number');
    assert.ok(ag.resultPreview, 'resultPreview present');
  }
  const coherence = phase.agents.find((a) => a.label === 'review:coherence');
  assert.equal(coherence.agentType, 'plan-coherence-reviewer');
  assert.equal(coherence.model, 'claude-haiku-4-5-20251001');

  // the huge script/result blobs must NOT leak into the run object
  assert.equal('script' in run, false);
  assert.equal('result' in run, false);

  // summary reflects the (completed) run
  const { active, summary } = deriveWorkflowSummary(runs);
  assert.equal(active, false);
  assert.equal(summary.name, 'claudex-plan-review-fanout');
  assert.equal(summary.done, 6);
  assert.equal(summary.total, 6);
  assert.equal(summary.status, 'completed');
});

// ===========================================================================
// 2. Multiple wf_*.json in one dir → multiple runs, ordered by startTime.
// ===========================================================================
test('multi-run: two run docs → two runs sorted by startTime ascending', () => {
  _resetWorkflowCache();
  const { transcriptPath, wfDir } = makeSession();
  writeRun(wfDir, 'later', makeRunDoc({ runId: 'later', name: 'B', status: 'completed', startTime: 2000 }));
  writeRun(wfDir, 'early', makeRunDoc({ runId: 'early', name: 'A', status: 'completed', startTime: 1000 }));

  const runs = computeWorkflowActivity({ transcriptPath });
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((r) => r.runId), ['early', 'later']);
});

// ===========================================================================
// 3. Partial / mid-write JSON → skipped, never thrown; siblings survive.
// ===========================================================================
test('partial/mid-write JSON is skipped, valid siblings still parse', () => {
  _resetWorkflowCache();
  const { transcriptPath, wfDir } = makeSession();
  writeRun(wfDir, 'good', makeRunDoc({ runId: 'good', status: 'completed', startTime: 1000 }));
  // a truncated mid-rewrite: valid JSON prefix, cut off before the close brace
  fs.writeFileSync(path.join(wfDir, 'wf_torn.json'), '{"runId":"torn","workflowProgress":[{"type":"workflow_ag');

  let runs;
  assert.doesNotThrow(() => { runs = computeWorkflowActivity({ transcriptPath }); });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, 'good');
});

// ===========================================================================
// 4. Failed / errored status is surfaced; active is false for both.
// ===========================================================================
test('failed and errored runs surface status and read inactive', () => {
  _resetWorkflowCache();
  const { transcriptPath, wfDir } = makeSession();
  writeRun(wfDir, 'boom', makeRunDoc({
    runId: 'boom', status: 'failed', startTime: 1000,
    phases: [{ index: 1, title: 'Build' }],
    agents: [
      { index: 1, label: 'a', phaseIndex: 1, phaseTitle: 'Build', agentId: 'x1', agentType: 't', model: 'm', state: 'done', tokens: 10, toolCalls: 1, durationMs: 5, resultPreview: 'ok' },
      { index: 2, label: 'b', phaseIndex: 1, phaseTitle: 'Build', agentId: 'x2', agentType: 't', model: 'm', state: 'done', tokens: 10, toolCalls: 1, durationMs: 5, resultPreview: 'err' },
    ],
  }));
  writeRun(wfDir, 'err', makeRunDoc({ runId: 'err', status: 'errored', startTime: 2000 }));

  const runs = computeWorkflowActivity({ transcriptPath });
  const boom = runs.find((r) => r.runId === 'boom');
  const err = runs.find((r) => r.runId === 'err');
  assert.equal(boom.status, 'failed');
  assert.equal(boom.active, false);
  assert.equal(err.status, 'errored');
  assert.equal(err.active, false);

  const { active, summary } = deriveWorkflowSummary(runs);
  assert.equal(active, false);
  // no active run → summary is the most-recent run overall (err @ startTime 2000)
  assert.equal(summary.status, 'errored');
});

// ===========================================================================
// 5. Pipelined run: TWO phases each with a running agent (concurrent phases).
// ===========================================================================
test('pipelined run: two active phases group correctly; active phase title resolves', () => {
  _resetWorkflowCache();
  const { transcriptPath, wfDir } = makeSession();
  writeRun(wfDir, 'pipe', makeRunDoc({
    runId: 'pipe', name: 'pipeline', status: 'running', startTime: 1000,
    phases: [
      { index: 1, title: 'Plan' },
      { index: 2, title: 'Build' },
    ],
    agents: [
      { index: 1, label: 'p1', phaseIndex: 1, phaseTitle: 'Plan', agentId: 'p1', agentType: 't', model: 'm', state: 'done', tokens: 1, toolCalls: 1, durationMs: 1, resultPreview: 'r' },
      // interleaved: Build's agent appears before Plan finished (pipelining)
      { index: 2, label: 'b1', phaseIndex: 2, phaseTitle: 'Build', agentId: 'b1', agentType: 't', model: 'm', state: 'running', tokens: 1, toolCalls: 1, lastToolName: 'Grep' },
      { index: 3, label: 'p2', phaseIndex: 1, phaseTitle: 'Plan', agentId: 'p2', agentType: 't', model: 'm', state: 'running', tokens: 1, toolCalls: 1, lastToolName: 'Read' },
    ],
  }));

  const runs = computeWorkflowActivity({ transcriptPath });
  assert.equal(runs.length, 1);
  const run = runs[0];

  // two phases, in first-appearance (index) order, agents bound by phaseIndex
  assert.deepEqual(run.phases.map((p) => p.title), ['Plan', 'Build']);
  const plan = run.phases.find((p) => p.title === 'Plan');
  const build = run.phases.find((p) => p.title === 'Build');
  assert.deepEqual(plan.agents.map((a) => a.label), ['p1', 'p2']);
  assert.deepEqual(build.agents.map((a) => a.label), ['b1']);
  assert.equal(run.total, 3);
  assert.equal(run.done, 1);
  assert.equal(run.active, true);

  const { active, summary } = deriveWorkflowSummary(runs);
  assert.equal(active, true);
  // first phase (index order) with a running agent = Plan
  assert.equal(summary.activePhaseTitle, 'Plan');
  assert.equal(summary.done, 1);
  assert.equal(summary.total, 3);
});

// ===========================================================================
// 6. mtime cache: parse is skipped when the file is unchanged, redone on change.
// ===========================================================================
test('mtime cache skips re-parse until the file changes', () => {
  _resetWorkflowCache();
  const { transcriptPath, wfDir } = makeSession();
  const filePath = path.join(wfDir, 'wf_cached.json');
  fs.writeFileSync(filePath, JSON.stringify(makeRunDoc({ runId: 'cached', status: 'running', startTime: 1000 })));

  computeWorkflowActivity({ transcriptPath });
  assert.equal(_workflowParseCountForTest(), 1, 'first scan parses once');

  computeWorkflowActivity({ transcriptPath });
  computeWorkflowActivity({ transcriptPath });
  assert.equal(_workflowParseCountForTest(), 1, 'unchanged file is not re-parsed');

  // rewrite with different content (size differs) AND bump mtime — deterministic change
  fs.writeFileSync(filePath, JSON.stringify(makeRunDoc({ runId: 'cached', status: 'completed', startTime: 1000 })));
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(filePath, future, future);

  const runs = computeWorkflowActivity({ transcriptPath });
  assert.equal(_workflowParseCountForTest(), 2, 'changed file is re-parsed');
  assert.equal(runs[0].status, 'completed', 'cache serves the fresh parse');
});

// ===========================================================================
// 7. Robustness: missing workflowProgress, no dir, non-wf files, empty input.
// ===========================================================================
test('missing workflowProgress → run with empty phases, zero totals', () => {
  _resetWorkflowCache();
  const { transcriptPath, wfDir } = makeSession();
  writeRun(wfDir, 'bare', { runId: 'bare', workflowName: 'bare', status: 'running', startTime: 1000 });

  const runs = computeWorkflowActivity({ transcriptPath });
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].phases, []);
  assert.equal(runs[0].total, 0);
  assert.equal(runs[0].done, 0);
  assert.equal(runs[0].active, true); // status running
});

test('no workflows dir / no transcriptPath / non-wf files → []', () => {
  _resetWorkflowCache();
  assert.deepEqual(computeWorkflowActivity({ transcriptPath: null }), []);
  assert.deepEqual(computeWorkflowActivity({}), []);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflows-nodir-'));
  const transcriptPath = path.join(root, 'sid.jsonl');
  fs.writeFileSync(transcriptPath, '');
  assert.deepEqual(computeWorkflowActivity({ transcriptPath }), []); // no workflows/ dir

  const wfDir = path.join(root, 'sid', 'workflows');
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, 'notes.txt'), 'ignore me');
  fs.writeFileSync(path.join(wfDir, 'scripts.json'), '{}'); // not wf_*.json
  assert.deepEqual(computeWorkflowActivity({ transcriptPath }), []); // non-wf files ignored
});

test('deriveWorkflowSummary handles empty and picks most-recent active run', () => {
  _resetWorkflowCache();
  assert.deepEqual(deriveWorkflowSummary([]), { active: false, summary: null });
  assert.deepEqual(deriveWorkflowSummary(null), { active: false, summary: null });

  const { transcriptPath, wfDir } = makeSession();
  writeRun(wfDir, 'oldrun', makeRunDoc({ runId: 'oldrun', name: 'old', status: 'completed', startTime: 1000 }));
  writeRun(wfDir, 'newrun', makeRunDoc({ runId: 'newrun', name: 'new', status: 'running', startTime: 2000 }));
  const runs = computeWorkflowActivity({ transcriptPath });
  const { active, summary } = deriveWorkflowSummary(runs);
  assert.equal(active, true);
  assert.equal(summary.name, 'new'); // the running one
});

// ===========================================================================
// 8. LRU cache bound holds.
// ===========================================================================
test('parse cache is LRU-bounded', () => {
  _resetWorkflowCache();
  const { transcriptPath, wfDir } = makeSession();
  for (let i = 0; i < 600; i++) {
    writeRun(wfDir, `r${i}`, makeRunDoc({ runId: `r${i}`, status: 'completed', startTime: i }));
  }
  computeWorkflowActivity({ transcriptPath });
  assert.ok(_workflowCacheSizeForTest() <= 512, `cache bounded, got ${_workflowCacheSizeForTest()}`);
});

// ===========================================================================
// 9. T2: over-long model-authored previews are truncated in the payload.
// ===========================================================================
test('T2: over-long previews are truncated with an ellipsis', () => {
  _resetWorkflowCache();
  const { transcriptPath, wfDir } = makeSession();
  const huge = 'z'.repeat(5000);
  writeRun(wfDir, 'big', makeRunDoc({
    runId: 'big', status: 'running', startTime: 1000,
    phases: [{ index: 1, title: 'P' }],
    agents: [
      { index: 1, label: 'a', phaseIndex: 1, phaseTitle: 'P', agentId: 'x', agentType: 't', model: 'm', state: 'running', promptPreview: huge, resultPreview: huge, lastToolName: huge },
    ],
  }));

  const runs = computeWorkflowActivity({ transcriptPath });
  const ag = runs[0].phases[0].agents[0];
  assert.ok(ag.promptPreview.length <= 2001, 'promptPreview bounded');
  assert.ok(ag.resultPreview.endsWith('…'), 'resultPreview truncated');
  assert.ok(ag.lastToolName.length <= 201, 'lastToolName bounded');
});

// ===========================================================================
// 12. loadWorkflowAgentMessages (B3) — one-shot agent transcript loader from
//     <session>/subagents/workflows/<runId>/agent-<agentId>.jsonl (the dir the
//     SubAgentsWatcher does NOT scan), parsed via TranscriptTailer → Msg[].
// ===========================================================================
function writeAgentTranscript(root, sessionId, runId, agentId, lines) {
  const dir = path.join(root, sessionId, 'subagents', 'workflows', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), lines.join('\n') + '\n');
}

test('loadWorkflowAgentMessages: reads + parses a workflow agent transcript', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-agent-'));
  const sessionId = 'sess-agent';
  const transcriptPath = path.join(root, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, '');
  writeAgentTranscript(root, sessionId, 'wf_abc123', 'a99', [
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: 1, message: { role: 'user', content: 'go' } }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      timestamp: 2,
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    }),
  ]);

  const msgs = await loadWorkflowAgentMessages({ transcriptPath, runId: 'wf_abc123', agentId: 'a99' });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].blocks[0].text, 'done');
});

test('loadWorkflowAgentMessages: missing file / bad args → []', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-agent-'));
  const transcriptPath = path.join(root, 'sess.jsonl');
  fs.writeFileSync(transcriptPath, '');
  assert.deepEqual(await loadWorkflowAgentMessages({ transcriptPath, runId: 'wf_none', agentId: 'nope' }), []);
  assert.deepEqual(await loadWorkflowAgentMessages({ transcriptPath: null, runId: 'wf_x', agentId: 'a' }), []);
  assert.deepEqual(await loadWorkflowAgentMessages({ transcriptPath, runId: '', agentId: 'a' }), []);
});

test('loadWorkflowAgentMessages (T1): rejects traversal / non-wf runId', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-agent-'));
  const sessionId = 'sess-trav';
  const transcriptPath = path.join(root, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, '');
  // Plant a real transcript OUTSIDE the workflows tree to prove it's unreachable.
  const secret = path.join(root, sessionId, 'subagents', 'secret');
  fs.mkdirSync(secret, { recursive: true });
  fs.writeFileSync(
    path.join(secret, 'agent-x.jsonl'),
    JSON.stringify({ type: 'assistant', uuid: 's', message: { role: 'assistant', content: [{ type: 'text', text: 'leak' }] } }) + '\n',
  );

  // runId without the wf_ prefix is rejected outright.
  assert.deepEqual(await loadWorkflowAgentMessages({ transcriptPath, runId: '../secret', agentId: 'x' }), []);
  // A runId with a path separator can never match the strict charset.
  assert.deepEqual(await loadWorkflowAgentMessages({ transcriptPath, runId: 'wf_../secret', agentId: 'x' }), []);
  // agentId with a separator is rejected too.
  assert.deepEqual(await loadWorkflowAgentMessages({ transcriptPath, runId: 'wf_a', agentId: '../secret/agent-x' }), []);
});

// ===========================================================================
// NEW FORMAT — the current Claude Code writes each run as a DIRECTORY under
// <session>/subagents/workflows/<runId>/ (journal.jsonl + agent-*), NOT the
// legacy single wf_<runId>.json. These assert the new reader against the real
// mid-run fixture and its edge cases, plus co-existence + de-dupe with legacy.
// ===========================================================================

// 13. Real mid-run fixture: run appears, in-progress, agents + statuses correct.
test('new-format: real partial run → in-progress, 5 done + 1 running, enriched', () => {
  _resetWorkflowCache();
  const { transcriptPath } = makeNewSession();

  const runs = computeWorkflowActivity({ transcriptPath });
  assert.equal(runs.length, 1);
  const run = runs[0];

  assert.equal(run.runId, NEW_RUNID);
  // one agent still `started`-only → the run reads as running (never falsely done)
  assert.equal(run.status, 'running');
  assert.equal(run.active, true);
  assert.equal(run.total, 6);
  assert.equal(run.done, 5);
  assert.equal(run.agentCount, 6);

  // workflowName from the script filename; summary from its meta.description.
  assert.equal(run.workflowName, 'grain-builders-buildout');
  assert.ok(run.summary && run.summary.includes('Grain Builders'), 'summary from script meta');

  // one untitled phase holding all six agents (phases are not journal-derivable)
  assert.equal(run.phases.length, 1);
  const agents = run.phases[0].agents;
  assert.equal(agents.length, 6);
  assert.equal(agents.filter((a) => a.state === 'running').length, 1);
  assert.equal(agents.filter((a) => a.state === 'done').length, 5);

  // the still-running agent is the one with a `started` but no `result`
  const running = agents.find((a) => a.state === 'running');
  assert.equal(running.agentId, 'a732b5a8aecba7601');
  assert.equal(running.resultPreview, null, 'a running agent has no result yet');

  // done agents carry their structured result (from the journal `result` object)
  const doneWithResult = agents.filter((a) => a.state === 'done' && a.resultPreview);
  assert.equal(doneWithResult.length, 5, 'every done agent surfaces its result');

  // agentType comes from agent-<id>.meta.json (all "workflow-subagent" here)
  assert.ok(agents.every((a) => a.agentType === 'workflow-subagent'), 'agentType from meta');

  // model is sniffed from the one agent we shipped a transcript for; the rest
  // have no transcript file → null (tolerated, never thrown).
  const withModel = agents.find((a) => a.agentId === 'a1647bc8cb0abc358');
  assert.equal(withModel.model, 'claude-opus-4-8');

  // rail/dock summary reflects the live (running) run
  const { active, summary } = deriveWorkflowSummary(runs);
  assert.equal(active, true);
  assert.equal(summary.name, 'grain-builders-buildout');
  assert.equal(summary.done, 5);
  assert.equal(summary.total, 6);
  assert.equal(summary.status, 'running');
});

// 14. Legacy AND new format co-exist (different runIds) → both surface, sorted.
test('new-format: legacy wf_*.json and a new-format dir both surface, de-duped', () => {
  _resetWorkflowCache();
  const { transcriptPath, base } = makeNewSession();
  // add a LEGACY run in the same session (earlier startTime → sorts first)
  const legacyDir = path.join(base, 'workflows');
  fs.mkdirSync(legacyDir, { recursive: true });
  writeRun(legacyDir, 'wf_legacy1', makeRunDoc({ runId: 'wf_legacy1', name: 'legacy', status: 'completed', startTime: 1 }));

  const runs = computeWorkflowActivity({ transcriptPath });
  const ids = runs.map((r) => r.runId).sort();
  assert.deepEqual(ids, ['wf_1f7d2b2b-03d', 'wf_legacy1']);
  // legacy run keeps its own reader's shape
  assert.equal(runs.find((r) => r.runId === 'wf_legacy1').workflowName, 'legacy');
});

// 15. De-dupe by runId: a legacy doc WINS over a same-runId new-format dir.
test('new-format: legacy doc wins de-dupe over a same-runId new-format dir', () => {
  _resetWorkflowCache();
  const { transcriptPath, base } = makeNewSession();
  // Plant a legacy doc with the SAME runId as the new-format fixture, but with
  // real 2-phase grouping — it must win (richer source).
  const legacyDir = path.join(base, 'workflows');
  fs.mkdirSync(legacyDir, { recursive: true });
  writeRun(legacyDir, NEW_RUNID, makeRunDoc({
    runId: NEW_RUNID, name: 'legacy-wins', status: 'completed', startTime: 5,
    phases: [{ index: 1, title: 'Build' }, { index: 2, title: 'Verify' }],
    agents: [
      { index: 1, label: 'b', phaseIndex: 1, phaseTitle: 'Build', agentId: 'x', agentType: 't', model: 'm', state: 'done', tokens: 1, toolCalls: 1, durationMs: 1, resultPreview: 'r' },
    ],
  }));

  const runs = computeWorkflowActivity({ transcriptPath });
  assert.equal(runs.length, 1, 'the runId is not duplicated');
  const run = runs[0];
  assert.equal(run.workflowName, 'legacy-wins');
  assert.equal(run.status, 'completed');
  assert.equal(run.phases.length, 2, 'legacy phase grouping wins, not the single new-format group');
});

// 16. In-progress-only synthetic: every agent `started`, none `result` → running.
test('new-format: started-only run reads as fully in-progress', () => {
  _resetWorkflowCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflows-inprog-'));
  const sid = 'sid';
  const tp = path.join(root, `${sid}.jsonl`);
  fs.writeFileSync(tp, '');
  writeNewRun(path.join(root, sid), 'wf_live', [
    { type: 'started', key: 'v2:aaa', agentId: 'a1' },
    { type: 'started', key: 'v2:bbb', agentId: 'a2' },
  ]);

  const runs = computeWorkflowActivity({ transcriptPath: tp });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'running');
  assert.equal(runs[0].active, true);
  assert.equal(runs[0].total, 2);
  assert.equal(runs[0].done, 0);
  assert.ok(runs[0].phases[0].agents.every((a) => a.state === 'running'));
});

// 17. Totality: a torn last line + a garbage line are skipped, siblings survive.
test('new-format: torn/garbage journal lines are skipped, never thrown', () => {
  _resetWorkflowCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflows-torn-'));
  const sid = 'sid';
  const tp = path.join(root, `${sid}.jsonl`);
  fs.writeFileSync(tp, '');
  const dir = path.join(root, sid, 'subagents', 'workflows', 'wf_torn');
  fs.mkdirSync(dir, { recursive: true });
  const good = [
    JSON.stringify({ type: 'started', key: 'v2:a', agentId: 'g1' }),
    JSON.stringify({ type: 'result', key: 'v2:a', agentId: 'g1', result: { ok: true } }),
    JSON.stringify({ type: 'started', key: 'v2:b', agentId: 'g2' }),
    'not json at all — a torn mid-write line',
    '{"type":"result","key":"v2:b","agentId":"g2","result":{"ok', // truncated
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), good);

  let runs;
  assert.doesNotThrow(() => { runs = computeWorkflowActivity({ transcriptPath: tp }); });
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run.total, 2, 'both good agents registered');
  assert.equal(run.done, 1, 'only g1 has a parseable result; g2 stays running');
  assert.equal(run.status, 'running');
  const g1 = run.phases[0].agents.find((a) => a.agentId === 'g1');
  assert.ok(g1.resultPreview && g1.resultPreview.includes('ok'), 'g1 result surfaced');
});

// 18. mtime cache: an unchanged journal is not re-read; a changed one is.
test('new-format: journal (mtime,size) cache skips re-parse until it changes', () => {
  _resetWorkflowCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflows-newcache-'));
  const sid = 'sid';
  const tp = path.join(root, `${sid}.jsonl`);
  fs.writeFileSync(tp, '');
  const dir = writeNewRun(path.join(root, sid), 'wf_c', [{ type: 'started', key: 'v2:a', agentId: 'a1' }]);
  const journal = path.join(dir, 'journal.jsonl');

  computeWorkflowActivity({ transcriptPath: tp });
  const first = _workflowParseCountForTest();
  assert.equal(first, 1, 'first scan reads the journal once');
  computeWorkflowActivity({ transcriptPath: tp });
  computeWorkflowActivity({ transcriptPath: tp });
  assert.equal(_workflowParseCountForTest(), first, 'unchanged journal is not re-read');

  // append a result (size changes) + bump mtime → deterministic invalidation
  fs.writeFileSync(journal, [
    JSON.stringify({ type: 'started', key: 'v2:a', agentId: 'a1' }),
    JSON.stringify({ type: 'result', key: 'v2:a', agentId: 'a1', result: { ok: 1 } }),
  ].join('\n') + '\n');
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(journal, future, future);

  const runs = computeWorkflowActivity({ transcriptPath: tp });
  assert.equal(_workflowParseCountForTest(), first + 1, 'changed journal is re-read');
  assert.equal(runs[0].status, 'completed', 'the fresh parse is served');
});

// 19. Regression guard: the new-format scan never breaks a legacy-only session.
test('new-format: legacy-only session (no subagents/workflows) is unaffected', () => {
  _resetWorkflowCache();
  const { transcriptPath, wfDir } = makeSession();
  writeRun(wfDir, 'onlylegacy', makeRunDoc({ runId: 'onlylegacy', name: 'L', status: 'completed', startTime: 1 }));
  const runs = computeWorkflowActivity({ transcriptPath });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, 'onlylegacy');
});
