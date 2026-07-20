/**
 * lib/workflows.js — parse a session's Claude Code Workflow runs.
 *
 * Claude Code's `Workflow` tool orchestrates a fanned-out set of sub-agents and
 * has written each run to disk in TWO on-disk formats over its lifetime. This
 * reader supports BOTH, de-duped by runId, so runs from any CC version surface:
 *
 * (A) LEGACY — a single live-rewritten run doc:
 *   <project>/<sessionId>/workflows/wf_<runId>.json      ← run doc (rewritten live)
 * Each `wf_<runId>.json` is one JSON document REWRITTEN in place as the run
 * progresses, so the right analogue of subagents' `_scanIncremental` mtime
 * discipline is a whole-file parse cache keyed by `(mtime, size)`: re-read +
 * re-parse only when the file changes, serve the cached parse otherwise. It
 * carries rich, pre-bound state (phases, per-agent tallies), so on the rare
 * collision it WINS over the new format.
 *
 * (B) NEW — the current CC version no longer writes `wf_<runId>.json`. Instead a
 * run is a DIRECTORY of append-only artifacts:
 *   <project>/<sessionId>/subagents/workflows/<runId>/journal.jsonl
 *       one JSON object per line: {type:'started'|'result'|…, key, agentId, result?}
 *       (started with no matching result ⇒ that agent is STILL RUNNING)
 *   <project>/<sessionId>/subagents/workflows/<runId>/agent-<id>.jsonl   ← transcript
 *   <project>/<sessionId>/subagents/workflows/<runId>/agent-<id>.meta.json ← {agentType,…}
 *   <project>/<sessionId>/workflows/scripts/<name>-<runId>.js            ← the run script
 * A new-format run is built from journal.jsonl (agents + started→running /
 * result→done), enriched from the meta/transcript/script, and cached by the
 * journal's `(mtime, size)` — same cheap re-read discipline as (A). Phases are
 * NOT recoverable from the journal (it records agentId + an opaque `v2:` key
 * only, with no reversible phase label), so new-format agents land in ONE
 * untitled group — honest, never a false structure.
 *
 * This module is deliberately a sibling of `lib/subagents.js`, NOT an extension
 * of it (S2): workflows are a richer, distinct concept (phases, pipelining,
 * per-agent rich state) and conflating them risks regressing the sub-agent
 * detection path. It surfaces two pure functions:
 *
 *   - computeWorkflowActivity({transcriptPath}) → ordered array of run objects
 *   - deriveWorkflowSummary(runs)               → {active, summary}
 *
 * Both are total: any malformed / partial / mid-write file (a `wf_*.json` or a
 * torn journal line, a missing meta/transcript) is skipped (never thrown), so
 * one bad file can never break the scan for the others, and a running
 * (incomplete) run always renders as in-progress rather than crashing the scan.
 */

import fs from 'node:fs';
import path from 'node:path';
import { TranscriptTailer } from './transcript.js';

/** Only files matching this are treated as (legacy) workflow-run docs. */
const WF_FILE_RE = /^wf_.+\.json$/;
/** The new-format run journal filename (one JSON event per line). */
const WF_JOURNAL_NAME = 'journal.jsonl';
/** A started-but-resultless agent whose freshest artifact (transcript, meta, or
 *  the journal itself) is older than this reads as FAILED, not running — the
 *  journal has no failure event, so staleness is the only on-disk signal that
 *  the runtime gave up on the attempt (e.g. gateway 502s). 5 min: a live agent
 *  writes its transcript far more often than that. */
const WF_STALE_MS = 5 * 60 * 1000;
/** Bounded head read of an agent transcript, to sniff its model cheaply. */
const WF_HEAD_BYTES = 64 * 1024;
/** Bounded head read of a run script, to sniff its `meta.description`. */
const WF_SCRIPT_HEAD_BYTES = 4 * 1024;
/** LRU bound for the per-file parse cache. */
const WF_CACHE_MAX_KEYS = 512;
/** Defensive caps on model-authored preview strings we persist into the payload
 *  (T2): the producer already truncates these, but a future producer change must
 *  not let a multi-KB string ride the poll. Rendering still auto-escapes (React)
 *  in Phase B — this is a size guard, not an escaping one. */
const PREVIEW_MAX = 2000;
const TOOLNAME_MAX = 200;

/**
 * Legacy per-file parse cache, keyed by absolute `wf_*.json` path.
 * @type {Map<string, {mtimeMs:number, size:number, run:object|null}>}
 */
const _wfCache = new Map();

/**
 * New-format per-run cache, keyed by absolute run-dir path. Invalidated by the
 * run's `journal.jsonl` `(mtime, size)` — the same cheap re-read discipline as
 * the legacy cache, but the invalidation signal is the append-only journal.
 * @type {Map<string, {mtimeMs:number, size:number, run:object|null}>}
 */
const _wfNewCache = new Map();

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
    // 'error' is a REAL recorded state (runtime exhausted its retries) — pass it
    // through; clamping it to 'queued' hides finished-run failures (the UI has a
    // dedicated ✕ treatment for it). Anything unknown still defaults to queued.
    state: a.state === 'running' || a.state === 'done' || a.state === 'error' ? a.state : 'queued',
    attempts: typeof a.attempt === 'number' ? a.attempt : undefined,
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
  let failed = 0;
  for (const ph of phases) {
    for (const ag of ph.agents) {
      total += 1;
      if (ag.state === 'done') done += 1;
      else if (ag.state === 'error') failed += 1;
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
    failed,
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
  const base = transcriptPath.replace(/\.jsonl$/, '');

  // De-dupe by runId across the two on-disk formats. Legacy wf_<runId>.json docs
  // are the richer source (bound phases, token/tool tallies), so they WIN on the
  // rare collision: add them first, then only fill in a new-format run whose
  // runId no legacy doc already provided.
  const byId = new Map();

  // (A) legacy: <session>/workflows/wf_<runId>.json (single rewritten doc).
  const legacyDir = path.join(base, 'workflows');
  let legacyEntries;
  try {
    legacyEntries = fs.readdirSync(legacyDir);
  } catch {
    legacyEntries = []; // no legacy dir → none in this format
  }
  for (const name of legacyEntries) {
    if (!WF_FILE_RE.test(name)) continue;
    const run = _loadRunCached(path.join(legacyDir, name));
    if (run && run.runId && !byId.has(run.runId)) byId.set(run.runId, run);
  }

  // (B) new: <session>/subagents/workflows/<runId>/ (journal + per-agent files).
  _scanNewFormatRuns(base, byId);

  const runs = [...byId.values()];
  runs.sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
  return runs;
}

// ---------------------------------------------------------------------------
// New-format reader — <session>/subagents/workflows/<runId>/… (journal.jsonl +
// per-agent transcript/meta + the run script). Total: any malformed / partial /
// mid-write artifact is skipped, never thrown; a run with a still-running agent
// reads as in-progress. Cheap: each run is cached by its journal's (mtime,size),
// so a session poll only rebuilds a run whose journal actually changed.
// ---------------------------------------------------------------------------

/**
 * Discover every new-format run under `<base>/subagents/workflows/` and add each
 * (keyed by runId) to `byId`, unless a legacy doc already provided that runId.
 * @param {string} base    transcriptPath with the `.jsonl` stripped
 * @param {Map<string, object>} byId  runId → run object (mutated in place)
 */
function _scanNewFormatRuns(base, byId) {
  const wfRoot = path.join(base, 'subagents', 'workflows');
  let dirEntries;
  try {
    dirEntries = fs.readdirSync(wfRoot, { withFileTypes: true });
  } catch {
    return; // no new-format dir → nothing to add (cheap ENOENT)
  }

  // The run scripts live in a sibling dir; list it ONCE per session scan (not
  // per run) so name/summary resolution stays cheap.
  const scriptsDir = path.join(base, 'workflows', 'scripts');
  let scriptNames;
  try {
    scriptNames = fs.readdirSync(scriptsDir);
  } catch {
    scriptNames = [];
  }

  for (const ent of dirEntries) {
    if (!ent.isDirectory() || !WF_RUNID_STRICT_RE.test(ent.name)) continue;
    const runId = ent.name;
    if (byId.has(runId)) continue; // legacy already provided this run (it wins)
    const run = _loadNewRunCached(path.join(wfRoot, runId), runId, scriptsDir, scriptNames);
    if (run) byId.set(runId, run);
  }
}

/**
 * Read + build one new-format run, memoized by its `journal.jsonl` `(mtime,size)`.
 * Never throws — a vanished/unreadable journal returns null and drops its cache
 * entry; a mid-write journal is tolerated line-by-line.
 */
function _loadNewRunCached(runDir, runId, scriptsDir, scriptNames) {
  const journalPath = path.join(runDir, WF_JOURNAL_NAME);
  let stat;
  try {
    stat = fs.statSync(journalPath);
  } catch {
    _wfNewCache.delete(runDir);
    return null; // no journal yet (mid-create) → skip, never falsely done
  }

  // The cache key carries a coarse time bucket: agent state derives from
  // artifact STALENESS (running → failed), which advances with wall-clock even
  // when the journal itself is untouched. One rebuild per staleness window max.
  const bucket = Math.floor(Date.now() / WF_STALE_MS);
  const cached = _wfNewCache.get(runDir);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.bucket === bucket) {
    _rememberMapEntry(_wfNewCache, runDir, cached, WF_CACHE_MAX_KEYS); // refresh LRU
    return cached.run;
  }

  let run = null;
  try {
    _parseCount += 1; // count the re-read (proves the mtime-skip)
    run = _buildNewRun(runDir, runId, journalPath, stat, scriptsDir, scriptNames);
  } catch {
    run = null; // any unexpected failure → skip this run, never throw the scan
  }
  _rememberMapEntry(_wfNewCache, runDir, { mtimeMs: stat.mtimeMs, size: stat.size, bucket, run }, WF_CACHE_MAX_KEYS);
  return run;
}

/**
 * Build a run object (the SAME shape as legacy `_parseRun`) from a run dir. The
 * journal establishes the agent set + per-agent state; the meta/transcript/script
 * enrich agentType, model, resultPreview, workflowName and summary best-effort.
 */
function _buildNewRun(runDir, runId, journalPath, journalStat, scriptsDir, scriptNames) {
  const raw = fs.readFileSync(journalPath, 'utf8');

  // LOGICAL agents are keyed by the journal's `key` (a hash of the agent's
  // prompt+opts): the runtime retries a failed agent under the SAME key with a
  // NEW agentId, so grouping by agentId counts every attempt as its own agent
  // (the "21/214 vs terminal's 21/72" inflation). First-seen key order =
  // logical start order. `result` marks the logical agent done no matter which
  // attempt produced it.
  const agents = new Map(); // key → {key, attempts:[agentId], hasResult, result, resultAgentId}
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let evt;
    try {
      evt = JSON.parse(s);
    } catch {
      continue; // torn last line / bad line — skip it, keep the good siblings
    }
    if (!evt || typeof evt !== 'object') continue;
    const agentId = typeof evt.agentId === 'string' && evt.agentId ? evt.agentId : null;
    if (!agentId) continue;
    const key = typeof evt.key === 'string' && evt.key ? evt.key : `agent:${agentId}`;
    let a = agents.get(key);
    if (!a) {
      a = { key, attempts: [], hasResult: false, result: null, resultAgentId: null };
      agents.set(key, a);
    }
    if (evt.type === 'started') {
      a.attempts.push(agentId);
    } else if (evt.type === 'result') {
      a.hasResult = true;
      a.resultAgentId = agentId;
      if (evt.result !== undefined) a.result = evt.result;
    }
  }

  const { workflowName, summary, declaredPhases } = _resolveScriptMeta(runId, scriptsDir, scriptNames);

  const shaped = [];
  let done = 0;
  let failed = 0;
  let index = 0;
  const journalMs = Number.isFinite(journalStat.mtimeMs) ? journalStat.mtimeMs : 0;
  for (const a of agents.values()) {
    index += 1;
    // The attempt the UI should point at: the one that produced the result,
    // else the latest. started→running / result→done; a resultless agent whose
    // artifacts have all gone stale reads 'error' (the runtime gave up on it —
    // the journal records no failure event of its own).
    const liveId = a.resultAgentId ?? a.attempts[a.attempts.length - 1] ?? null;
    const state = a.hasResult ? 'done' : _isAttemptAlive(runDir, liveId, journalMs) ? 'running' : 'error';
    if (state === 'done') done += 1;
    else if (state === 'error') failed += 1;
    shaped.push({
      index,
      label: null,
      agentId: liveId,
      agentType: _readAgentType(runDir, liveId),
      model: _sniffAgentModel(runDir, liveId),
      state,
      attempts: Math.max(a.attempts.length, 1),
      startedAt: null,
      queuedAt: null,
      durationMs: null,
      tokens: null,
      toolCalls: null,
      lastToolName: null,
      promptPreview: _sniffPromptPreview(runDir, liveId),
      resultPreview: a.result != null ? _truncate(_stringifyResult(a.result), PREVIEW_MAX) : null,
      lastReply: a.hasResult ? _tailLastReply(runDir, liveId) : null,
    });
  }

  const total = shaped.length;
  // 'completed' only when EVERY logical agent produced a result. A run with no
  // live attempts left but results missing reads 'failed' (the runtime ended or
  // abandoned those keys); anything with a live attempt stays 'running' — never
  // falsely done, and an empty mid-create journal fails open to 'running'.
  const status =
    total === 0 || shaped.some((ag) => ag.state === 'running')
      ? 'running'
      : done === total
        ? 'completed'
        : 'failed';

  // The journal file's birth time is the cheapest proxy for the run's start (ms
  // epoch, so it sorts uniformly against legacy runs' `data.startTime`).
  const startTime =
    Number.isFinite(journalStat.birthtimeMs) && journalStat.birthtimeMs > 0
      ? journalStat.birthtimeMs
      : Number.isFinite(journalStat.mtimeMs)
        ? journalStat.mtimeMs
        : null;

  // Phases are not recoverable from the journal (see the file header), so every
  // agent lands in ONE untitled group. Legacy runs keep their real phases.
  const phases = total > 0 ? [{ index: null, title: null, detail: null, agents: shaped }] : [];

  return {
    runId,
    workflowName,
    summary,
    declaredPhases: declaredPhases.length ? declaredPhases : null,
    status,
    agentCount: total,
    startTime,
    durationMs: null,
    totalTokens: null,
    totalToolCalls: null,
    done,
    failed,
    total,
    active: status === 'running',
    phases,
  };
}

/** Stringify a journal `result` for `resultPreview` (a bare string passes through). */
function _stringifyResult(result) {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return null; // circular / unserialisable — drop it, never throw
  }
}

/** Best-effort agentType from `agent-<id>.meta.json`; null on any failure. */
function _readAgentType(runDir, agentId) {
  if (!WF_AGENTID_STRICT_RE.test(agentId)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(runDir, `agent-${agentId}.meta.json`), 'utf8'));
    return meta && typeof meta.agentType === 'string' ? meta.agentType : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort model from a bounded HEAD read of `agent-<id>.jsonl` (the first
 * `"model":"…"` — the earliest assistant record's model). Reads at most
 * WF_HEAD_BYTES; null on any failure. Not load-bearing — it fills in on the next
 * journal change if the transcript had no assistant record yet at build time.
 */
function _sniffAgentModel(runDir, agentId) {
  if (!WF_AGENTID_STRICT_RE.test(agentId)) return null;
  let fd;
  try {
    fd = fs.openSync(path.join(runDir, `agent-${agentId}.jsonl`), 'r');
    const buf = Buffer.allocUnsafe(WF_HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, WF_HEAD_BYTES, 0);
    const m = buf.toString('utf8', 0, n).match(/"model"\s*:\s*"([^"]+)"/);
    return m ? _truncate(m[1], TOOLNAME_MAX) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Liveness of a resultless logical agent: TRUE while its newest artifact
 * (transcript or meta) — or, lacking files, the journal itself — is younger
 * than WF_STALE_MS. Total: stat failures just keep the journal base time.
 */
function _isAttemptAlive(runDir, agentId, journalMs) {
  let newest = journalMs || 0;
  if (agentId && WF_AGENTID_STRICT_RE.test(agentId)) {
    for (const suffix of ['jsonl', 'meta.json']) {
      try {
        const st = fs.statSync(path.join(runDir, `agent-${agentId}.${suffix}`));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        /* absent artifact — keep the journal base */
      }
    }
  }
  return newest > 0 && Date.now() - newest < WF_STALE_MS;
}

/** Flatten a transcript message's content (string or block array) to text. */
function _contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return null;
}

/**
 * Best-effort TASK snippet: the agent's first user message (its prompt) from a
 * bounded head read. This is the only task signal the new format leaves on disk
 * — neither the journal nor meta.json carries the agent's label/prompt.
 */
function _sniffPromptPreview(runDir, agentId) {
  if (!agentId || !WF_AGENTID_STRICT_RE.test(agentId)) return null;
  let fd;
  try {
    fd = fs.openSync(path.join(runDir, `agent-${agentId}.jsonl`), 'r');
    const buf = Buffer.allocUnsafe(WF_HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, WF_HEAD_BYTES, 0);
    const firstLine = buf.toString('utf8', 0, n).split('\n', 1)[0];
    const rec = JSON.parse(firstLine);
    const text = _contentText(rec?.message?.content);
    return text ? _truncate(text.replace(/\s+/g, ' ').trim(), 300) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

/** Tail bytes scanned for the last assistant reply. */
const WF_REPLY_TAIL_BYTES = 32 * 1024;

/**
 * Best-effort LAST assistant text from a bounded tail read — the human-readable
 * answer, so a done agent's preview reads as a reply instead of the raw
 * structured-result JSON (which stays available via resultPreview/fallback).
 */
function _tailLastReply(runDir, agentId) {
  if (!agentId || !WF_AGENTID_STRICT_RE.test(agentId)) return null;
  let fd;
  try {
    const file = path.join(runDir, `agent-${agentId}.jsonl`);
    const size = fs.statSync(file).size;
    fd = fs.openSync(file, 'r');
    const start = Math.max(0, size - WF_REPLY_TAIL_BYTES);
    const buf = Buffer.allocUnsafe(Math.min(size, WF_REPLY_TAIL_BYTES));
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8', 0, n).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const s = lines[i].trim();
      if (!s) continue;
      let rec;
      try {
        rec = JSON.parse(s);
      } catch {
        continue; // torn tail line — try the one above
      }
      if (rec?.type !== 'assistant') continue;
      const text = _contentText(rec?.message?.content);
      if (text) return _truncate(text.trim(), 600);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Resolve `{workflowName, summary, declaredPhases}` for a run from its script
 * `<name>-<runId>.js`. workflowName comes from the FILENAME (strip the runId
 * suffix — robust, no JS parsing); summary is a bounded, best-effort regex of
 * the script's `meta.description`; declaredPhases is the meta.phases title
 * list. All null/[] when the script is absent/unreadable.
 *
 * declaredPhases exists because the new-format journal records NO phase info
 * (agents all land in one untitled group) — the card header surfaces the
 * script's declared pipeline ("Find → Verify") instead of a fake "Phase".
 */
function _resolveScriptMeta(runId, scriptsDir, scriptNames) {
  const file = scriptNames.find((n) => n.endsWith('.js') && n.includes(runId));
  if (!file) return { workflowName: null, summary: null, declaredPhases: [] };

  let workflowName = file.replace(/\.js$/, '');
  const at = workflowName.lastIndexOf(runId);
  if (at >= 0) workflowName = workflowName.slice(0, at).replace(/[-_]+$/, '');
  workflowName = workflowName || null;

  let summary = null;
  const declaredPhases = [];
  let fd;
  try {
    fd = fs.openSync(path.join(scriptsDir, file), 'r');
    const buf = Buffer.allocUnsafe(WF_SCRIPT_HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, WF_SCRIPT_HEAD_BYTES, 0);
    const head = buf.toString('utf8', 0, n);
    const m = head.match(/description:\s*'((?:\\.|[^'\\])*)'/);
    if (m) summary = _truncate(m[1].replace(/\\'/g, "'"), PREVIEW_MAX);
    // meta.phases is the only place `title:` literals appear in the meta block.
    const pm = head.match(/phases:\s*\[([\s\S]*?)\]\s*[,}]/);
    if (pm) {
      for (const tm of pm[1].matchAll(/title:\s*'((?:\\.|[^'\\])*)'/g)) {
        declaredPhases.push(tm[1].replace(/\\'/g, "'"));
        if (declaredPhases.length >= 8) break; // defensive cap
      }
    }
  } catch {
    /* no script head → summary/declaredPhases stay empty */
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
  return { workflowName, summary, declaredPhases };
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

/** Reset both parse caches + parse counter. Test-only. */
export function _resetWorkflowCache() {
  _wfCache.clear();
  _wfNewCache.clear();
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
