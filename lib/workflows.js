/**
 * lib/workflows.js — parse a session's Claude Code Workflow runs.
 *
 * Claude Code's `Workflow` tool orchestrates a fanned-out set of sub-agents
 * grouped into phases, and writes each run's LIVE aggregate state to:
 *
 *   <project>/<sessionId>.jsonl                          ← parent transcript
 *   <project>/<sessionId>/workflows/wf_<runId>.json      ← run doc (rewritten live)
 *   <project>/<sessionId>/subagents/workflows/<runId>/…  ← per-agent transcripts
 *
 * Unlike `lib/subagents.js` (which incrementally tails an APPEND-only parent
 * transcript by byte cursor), each `wf_<runId>.json` is a single JSON document
 * that is REWRITTEN in place as the run progresses. So the right analogue of
 * subagents' `_scanIncremental` mtime discipline is a whole-file parse cache
 * keyed by `(mtime, size)`: re-read + re-parse only when the file changes, and
 * serve the cached parse otherwise. This keeps the session poll cheap enough to
 * run for EVERY window on every tick (like `computeSubAgentActivity`).
 *
 * This module is deliberately a sibling of `lib/subagents.js`, NOT an extension
 * of it (S2): workflows are a richer, distinct concept (phases, pipelining,
 * per-agent rich state) and conflating them risks regressing the sub-agent
 * detection path. It surfaces two pure functions:
 *
 *   - computeWorkflowActivity({transcriptPath}) → ordered array of run objects
 *   - deriveWorkflowSummary(runs)               → {active, summary}
 *
 * Both are total: any malformed / partial / mid-write `wf_*.json` is skipped
 * (never thrown), so one bad file can never break the scan for the others.
 */

import fs from 'node:fs';
import path from 'node:path';
import { TranscriptTailer } from './transcript.js';

/** Only files matching this are treated as workflow-run docs. */
const WF_FILE_RE = /^wf_.+\.json$/;
/** LRU bound for the per-file parse cache. */
const WF_CACHE_MAX_KEYS = 512;
/** Defensive caps on model-authored preview strings we persist into the payload
 *  (T2): the producer already truncates these, but a future producer change must
 *  not let a multi-KB string ride the poll. Rendering still auto-escapes (React)
 *  in Phase B — this is a size guard, not an escaping one. */
const PREVIEW_MAX = 2000;
const TOOLNAME_MAX = 200;

/**
 * Per-file parse cache, keyed by absolute file path.
 * @type {Map<string, {mtimeMs:number, size:number, run:object|null}>}
 */
const _wfCache = new Map();

/** Count of actual disk-read+parse attempts — test hook for the mtime-skip proof. */
let _parseCount = 0;

// ---------------------------------------------------------------------------
// Small local helpers (LRU + truncate) — intentionally NOT imported from
// subagents.js so this module stays independent of it (S2).
// ---------------------------------------------------------------------------

function _rememberMapEntry(map, key, value, maxKeys) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maxKeys) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

/** Bound a model-authored string; returns null for non-strings. */
function _truncate(value, max) {
  if (typeof value !== 'string') return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

// ---------------------------------------------------------------------------
// Parsing — pure, total (never throws) below the JSON.parse boundary.
// ---------------------------------------------------------------------------

/**
 * Shape one flat `workflow_agent` progress entry into the payload agent object.
 * `state` defaults to 'queued' (the least-committal, never-falsely-done value)
 * when absent — mirroring subagents' "under-complete rather than falsely done"
 * discipline.
 */
function _shapeAgent(a) {
  return {
    index: typeof a.index === 'number' ? a.index : null,
    label: a.label ?? null,
    agentId: a.agentId ?? null,
    agentType: a.agentType ?? null,
    model: a.model ?? null,
    state: a.state === 'running' || a.state === 'done' ? a.state : 'queued',
    startedAt: typeof a.startedAt === 'number' ? a.startedAt : null,
    queuedAt: typeof a.queuedAt === 'number' ? a.queuedAt : null,
    durationMs: typeof a.durationMs === 'number' ? a.durationMs : null,
    tokens: typeof a.tokens === 'number' ? a.tokens : null,
    toolCalls: typeof a.toolCalls === 'number' ? a.toolCalls : null,
    lastToolName: _truncate(a.lastToolName, TOOLNAME_MAX),
    promptPreview: _truncate(a.promptPreview, PREVIEW_MAX),
    resultPreview: _truncate(a.resultPreview, PREVIEW_MAX),
  };
}

/**
 * Group the flat, ordered `workflowProgress` array into phases → agents.
 *
 * `workflowProgress` interleaves `{type:'workflow_phase', index, title}` markers
 * with `{type:'workflow_agent', phaseIndex, phaseTitle, …}` entries. Agents are
 * bound to their phase by `phaseIndex` (falling back to `phaseTitle`), and each
 * phase's `detail` is joined from the top-level `phases[]` array by title, then
 * positionally by `index`. Phases keep first-appearance order (which equals
 * index order for a well-formed doc), so pipelined runs (a later phase's agents
 * appearing before an earlier phase completes) still read in the intended order.
 *
 * @param {unknown} workflowProgress  the flat progress array (may be missing)
 * @param {unknown} topPhases         top-level `phases:[{title,detail}]`
 * @returns {Array<{index:number|null, title:string|null, detail:string|null, agents:object[]}>}
 */
function _groupPhases(workflowProgress, topPhases) {
  /** @type {Map<string|number, {index:number|null, title:string|null, detail:string|null, agents:object[]}>} */
  const byKey = new Map();

  const detailByTitle = new Map();
  const detailByPos = [];
  if (Array.isArray(topPhases)) {
    topPhases.forEach((p, i) => {
      if (p && typeof p.title === 'string') detailByTitle.set(p.title, p.detail ?? null);
      detailByPos[i] = (p && typeof p.detail === 'string') ? p.detail : null;
    });
  }

  const resolveDetail = (index, title) => {
    if (title != null && detailByTitle.has(title)) return detailByTitle.get(title);
    if (typeof index === 'number' && index >= 1) return detailByPos[index - 1] ?? null;
    return null;
  };

  const ensurePhase = (index, title) => {
    const key = typeof index === 'number' ? index : `__t:${title ?? ''}`;
    let ph = byKey.get(key);
    if (!ph) {
      ph = {
        index: typeof index === 'number' ? index : null,
        title: title ?? null,
        detail: resolveDetail(index, title),
        agents: [],
      };
      byKey.set(key, ph);
    } else {
      // Late-arriving marker / richer agent metadata can fill gaps left by
      // whichever entry created the phase first.
      if (ph.title == null && title != null) ph.title = title;
      if (ph.detail == null) ph.detail = resolveDetail(index, title);
    }
    return ph;
  };

  if (Array.isArray(workflowProgress)) {
    for (const item of workflowProgress) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'workflow_phase') {
        ensurePhase(item.index, item.title);
      } else if (item.type === 'workflow_agent') {
        ensurePhase(item.phaseIndex, item.phaseTitle).agents.push(_shapeAgent(item));
      }
    }
  }

  return [...byKey.values()];
}

/**
 * Parse the raw text of one `wf_<runId>.json` into a run object. Throws only if
 * `JSON.parse` fails (partial/mid-write file) — the caller catches and skips.
 * Returns null for a JSON doc that is not a workflow-run (no `runId`).
 *
 * @param {string} raw
 * @returns {object|null}
 */
function _parseRun(raw) {
  const data = JSON.parse(raw); // partial/mid-write → throws → caller skips
  if (!data || typeof data !== 'object') return null;
  const runId = typeof data.runId === 'string' && data.runId ? data.runId : null;
  if (!runId) return null; // not a workflow-run doc

  const phases = _groupPhases(data.workflowProgress, data.phases);

  let total = 0;
  let done = 0;
  for (const ph of phases) {
    for (const ag of ph.agents) {
      total += 1;
      if (ag.state === 'done') done += 1;
    }
  }

  // Fail-open to 'running' if a (parseable) doc lacks a status — never falsely
  // report a live run as finished. `active` derives from status directly.
  const status = typeof data.status === 'string' && data.status ? data.status : 'running';

  return {
    runId,
    workflowName: data.workflowName ?? null,
    summary: _truncate(data.summary, PREVIEW_MAX),
    status,
    agentCount: typeof data.agentCount === 'number' ? data.agentCount : total,
    startTime: typeof data.startTime === 'number' ? data.startTime : null,
    durationMs: typeof data.durationMs === 'number' ? data.durationMs : null,
    totalTokens: typeof data.totalTokens === 'number' ? data.totalTokens : null,
    totalToolCalls: typeof data.totalToolCalls === 'number' ? data.totalToolCalls : null,
    done,
    total,
    active: status === 'running',
    phases,
  };
}

/**
 * Read + parse one `wf_*.json`, memoized by `(mtime, size)`. Re-reads only when
 * the file changed; serves the cached parse (including a cached null for a
 * malformed/non-run doc) otherwise. Never throws — a vanished/unreadable file
 * returns null and drops its cache entry.
 *
 * @param {string} filePath  absolute path to a `wf_*.json`
 * @returns {object|null}
 */
function _loadRunCached(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    _wfCache.delete(filePath);
    return null;
  }

  const cached = _wfCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    _rememberMapEntry(_wfCache, filePath, cached, WF_CACHE_MAX_KEYS); // refresh LRU
    return cached.run;
  }

  let run = null;
  try {
    _parseCount += 1; // count the re-read (proves the mtime-skip)
    run = _parseRun(fs.readFileSync(filePath, 'utf8'));
  } catch {
    run = null; // partial/mid-write JSON — skip this run, never throw
  }
  _rememberMapEntry(_wfCache, filePath, { mtimeMs: stat.mtimeMs, size: stat.size, run }, WF_CACHE_MAX_KEYS);
  return run;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse every workflow run for a session, ordered by start time (ascending, so
 * the array reads oldest→newest for stable multi-run rendering). The workflows
 * dir is derived from the trusted `transcriptPath` EXACTLY as `lib/subagents.js`
 * derives the subagents dir (T1) — never from request input, no traversal
 * (`WF_FILE_RE` constrains filenames further). Safe to call for every session
 * on every poll: each file is `(mtime,size)`-cached.
 *
 * @param {{transcriptPath: string|null}} args
 * @returns {object[]}  per-run objects (see _parseRun); [] when no workflows dir
 */
export function computeWorkflowActivity({ transcriptPath } = {}) {
  if (!transcriptPath) return [];
  const dir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'workflows');

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return []; // no workflows dir → this session has run none
  }

  const runs = [];
  for (const name of entries) {
    if (!WF_FILE_RE.test(name)) continue;
    const run = _loadRunCached(path.join(dir, name));
    if (run) runs.push(run);
  }
  runs.sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
  return runs;
}

/** The title of the phase a run is "at" right now (running > next-queued > last). */
function _activePhaseTitle(run) {
  const phases = run?.phases ?? [];
  for (const ph of phases) if (ph.agents.some((a) => a.state === 'running')) return ph.title;
  for (const ph of phases) if (ph.agents.some((a) => a.state === 'queued')) return ph.title;
  return phases.length ? phases[phases.length - 1].title : null;
}

/**
 * Derive the session-level workflow summary from a run array (the thin shape the
 * rail indicator + live dock read). `active` is true when ANY run is running;
 * `summary` describes the most-recently-active run (else the most-recent run
 * overall, so a just-completed run still surfaces its final N/M + status).
 *
 * @param {object[]} runs  output of computeWorkflowActivity
 * @returns {{active: boolean, summary: {name:string|null, activePhaseTitle:string|null, done:number, total:number, status:string}|null}}
 */
export function deriveWorkflowSummary(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return { active: false, summary: null };
  const active = runs.some((r) => r.active);
  // runs are start-time ascending, so the last is the most recent.
  const chosen = [...runs].reverse().find((r) => r.active) ?? runs[runs.length - 1];
  return {
    active,
    summary: {
      name: chosen.workflowName ?? null,
      activePhaseTitle: _activePhaseTitle(chosen),
      done: chosen.done,
      total: chosen.total,
      status: chosen.status,
    },
  };
}

// ---------------------------------------------------------------------------
// Agent transcript loader (Phase B / B3) — the Agent View "open full transcript"
// reuses the SAME single sub-agent viewer (SubAgentThread) as top-level
// sub-agents, but workflow-agent transcripts live in a DIFFERENT dir the
// SubAgentsWatcher does not scan:
//   <session>/subagents/workflows/<runId>/agent-<agentId>.jsonl
// so it needs its own one-shot loader. Parsed with the SAME TranscriptTailer as
// lib/subagents.js `_loadSnapshot` (snapshotOnly, bounded tail) so the client
// receives identical `Msg[]` — no second parser, no new message shape.
// ---------------------------------------------------------------------------

/** Same charset discipline as subagents; strict enough that neither key can
 *  introduce a path separator. runId must carry the `wf_` prefix (so it can
 *  never be `.`/`..`); agentId only ever forms the `agent-<id>.jsonl` filename. */
const WF_RUNID_STRICT_RE = /^wf_[A-Za-z0-9._-]+$/;
const WF_AGENTID_STRICT_RE = /^[A-Za-z0-9._-]+$/;
/** Bounded tail — mirror the sub-agent loader (lib/subagents.js). */
const WF_AGENT_TAIL_BYTES = 256 * 1024;

/**
 * Load one workflow agent's transcript as `Msg[]`, on demand. The path is
 * derived from the TRUSTED `transcriptPath` (never request input) exactly as
 * `computeWorkflowActivity` derives the workflows dir (T1); `runId`/`agentId`
 * are charset-validated and a resolve-prefix guard rejects anything that would
 * escape `<session>/subagents/workflows/`. Never throws — a missing/unreadable
 * transcript returns [].
 *
 * @param {{transcriptPath: string|null, runId: string, agentId: string}} args
 * @returns {Promise<object[]>}  parsed messages (see lib/transcript.js parseRecord)
 */
export async function loadWorkflowAgentMessages({ transcriptPath, runId, agentId } = {}) {
  if (!transcriptPath || typeof runId !== 'string' || typeof agentId !== 'string') return [];
  if (!WF_RUNID_STRICT_RE.test(runId) || !WF_AGENTID_STRICT_RE.test(agentId)) return [];

  const base = transcriptPath.replace(/\.jsonl$/, '');
  const wfRoot = path.join(base, 'subagents', 'workflows');
  const jsonlPath = path.join(wfRoot, runId, `agent-${agentId}.jsonl`);
  // Belt-and-suspenders anti-traversal: the resolved file must stay under wfRoot.
  if (!path.resolve(jsonlPath).startsWith(path.resolve(wfRoot) + path.sep)) return [];

  const tailer = new TranscriptTailer(jsonlPath, {
    tailBytes: WF_AGENT_TAIL_BYTES,
    snapshotOnly: true,
    watch: false,
    pollMs: 0,
  });
  tailer.on('error', () => {});
  try {
    await tailer.start();
    return tailer.getMessages();
  } catch {
    return [];
  } finally {
    tailer.stop();
  }
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

/** Reset the parse cache + parse counter. Test-only. */
export function _resetWorkflowCache() {
  _wfCache.clear();
  _parseCount = 0;
}

/** Number of disk read+parse attempts since the last reset. Test-only. */
export function _workflowParseCountForTest() {
  return _parseCount;
}

/** Current parse-cache size. Test-only (LRU bound assertion). */
export function _workflowCacheSizeForTest() {
  return _wfCache.size;
}
