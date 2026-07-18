import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  computeWorkflowActivity,
  deriveWorkflowSummary,
  _resetWorkflowCache,
  _workflowParseCountForTest,
  _workflowCacheSizeForTest,
} from '../lib/workflows.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPECIMEN = path.join(__dirname, 'fixtures', 'workflows', 'wf_dc36fa0e-3c0.json');

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
