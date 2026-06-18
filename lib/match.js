/**
 * lib/match.js — deterministic pane↔transcript assignment.
 *
 * Why this exists: multiple Claude sessions can run in the SAME directory (e.g.
 * two panes both in ~/Projects). Claude Code names a transcript's project
 * directory after the cwd, so directory alone cannot tell two same-cwd sessions
 * apart. The previous "newest transcript in the dir → the active window" rule
 * therefore mis-routed: a reply typed into one pane surfaced under another.
 *
 * This module assigns at most ONE transcript to each pane, 1:1, using layered
 * signals (strongest first). It is pure and deterministic so the cross-send case
 * is unit-testable.
 */

import { isCwdConsistent } from './sessions.js';

const DEFAULT_START_SLACK_MS = 5 * 60_000; // proc-start vs transcript-birth tolerance

/**
 * @param {string|null} etime  macOS `ps -o etime` value: "[[dd-]hh:]mm:ss"
 * @returns {number|null} elapsed seconds, or null if unparseable
 */
export function parseEtime(etime) {
  const s = String(etime || '').trim();
  if (!s) return null;
  // optional "dd-" prefix, then hh:mm:ss or mm:ss
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s);
  if (!m) return null;
  const days = Number(m[1] || 0);
  const hours = Number(m[2] || 0);
  const mins = Number(m[3] || 0);
  const secs = Number(m[4] || 0);
  return ((days * 24 + hours) * 60 + mins) * 60 + secs;
}

/**
 * @typedef {Object} MatchPane
 * @property {string}      target       "session:window.pane"
 * @property {string}      windowName
 * @property {string}      cwd
 * @property {number|null} procStartMs  claude process start (ms epoch), or null
 *
 * @typedef {Object} MatchCandidate
 * @property {string}      transcriptPath
 * @property {string|null} cwd            cwd recorded inside the transcript
 * @property {number|null} birthtimeMs
 * @property {number|null} mtimeMs
 * @property {number|null} lastActivityMs
 * @property {string|null} customTitle
 * @property {string|null} aiTitle
 */

/**
 * Assign transcripts to panes 1:1.
 *
 * This is the FALLBACK matcher for panes with no SessionStart-hook record (see
 * lib/pane-registry.js). It uses only deterministic timing signals — title
 * matching was removed because stale window names mis-routed the chat.
 *
 * Layered passes (each claims candidates so no transcript is used twice):
 *   1. Start-time match — candidate birthtime closest to the pane's claude
 *      process start (cwd-consistent). A claude proc creates its transcript at
 *      launch, so this binds same-cwd siblings that started at different times.
 *   2. Recency — most-recently-active remaining cwd-consistent candidate.
 *
 * Panes are processed in a stable (target-sorted) order so results are
 * deterministic regardless of tmux listing order.
 *
 * @param {MatchPane[]} panes
 * @param {MatchCandidate[]} candidates
 * @param {{ startSlackMs?: number }} [opts]
 * @returns {Map<string, MatchCandidate>} target -> candidate
 */
export function assignTranscripts(panes, candidates, opts = {}) {
  const startSlackMs = opts.startSlackMs ?? DEFAULT_START_SLACK_MS;
  const result = new Map();
  const claimed = new Set();
  const ordered = [...panes].sort((a, b) => a.target.localeCompare(b.target));

  // A candidate is in scope for a pane only if it lives in the pane's OWN
  // project dir (the slug folder Claude names after the launch cwd). This is the
  // precise signal: the recorded cwd alone can't tell a legit "session cd'd into
  // a subdir" from a DIFFERENT deeper session (a git worktree), since both look
  // like a descendant cwd — that ambiguity let a parent-dir pane steal a child
  // worktree's transcript. When projectDir isn't supplied (older callers / unit
  // tests), fall back to the recorded-cwd consistency check.
  const inScope = (c, pane) => {
    if (c.projectDir != null && pane.projectDir != null) {
      return c.projectDir === pane.projectDir;
    }
    return isCwdConsistent(c.cwd, pane.cwd);
  };
  const available = (pane) =>
    candidates.filter((c) => !claimed.has(c.transcriptPath) && inScope(c, pane));

  const claim = (pane, cand) => {
    result.set(pane.target, cand);
    claimed.add(cand.transcriptPath);
  };

  // A transcript can only belong to a pane if it was active at/after the pane's
  // claude process started (minus slack). Skipped when the pane's start time is
  // unknown. --resume is safe: resuming appends a record, bumping activity above
  // the pane start. This is what stops a stale transcript binding to a pane.
  const temporallyPlausible = (pane, c) => {
    if (pane.procStartMs == null) return true;
    const candActive = c.lastActivityMs ?? c.mtime ?? c.birthtimeMs ?? null;
    return candActive == null || candActive >= pane.procStartMs - startSlackMs;
  };

  // NOTE: title matching was intentionally removed. A window keeps a stale name
  // when a pane is reused or /rename'd, so binding on title mis-routed the chat
  // to an old transcript ("transcript drift"). The exact pane→transcript link now
  // comes from the SessionStart hook (lib/pane-registry.js), applied in
  // sessions.js BEFORE this matcher runs; assignTranscripts is the fallback for
  // panes with no hook record, using only deterministic timing signals below.

  // Pass 1 — nearest start-time ↔ birthtime.
  for (const pane of ordered) {
    if (result.has(pane.target)) continue;
    if (pane.procStartMs == null) continue;
    let best = null;
    let bestDelta = Infinity;
    for (const c of available(pane)) {
      if (c.birthtimeMs == null) continue;
      const delta = Math.abs(c.birthtimeMs - pane.procStartMs);
      // Prefer transcripts born around/after the proc started; reject ones born
      // long before the proc (those belong to an earlier session in this dir).
      if (c.birthtimeMs < pane.procStartMs - startSlackMs) continue;
      if (
        delta < bestDelta ||
        (delta === bestDelta &&
          (c.lastActivityMs ?? 0) > (best?.lastActivityMs ?? 0))
      ) {
        best = c;
        bestDelta = delta;
      }
    }
    if (best) claim(pane, best);
  }

  // Pass 2 — most-recently-active remaining candidate.
  // Gate: when the pane's process start time is known, only consider candidates
  // whose last known activity (lastActivityMs, falling back to file mtime or
  // birthtime) is at or after the pane started (minus startSlackMs). A transcript
  // that was never touched after the pane launched cannot belong to it — that is
  // the "fresh pane inherits old transcript" bug. When procStartMs is unknown,
  // skip the gate so we don't regress panes with missing timing data.
  // NOTE: --resume is safe: Claude appends a record to the old transcript on
  // resume, bumping its mtime/lastActivityMs above the pane's start time.
  for (const pane of ordered) {
    if (result.has(pane.target)) continue;
    let best = null;
    for (const c of available(pane)) {
      if (!temporallyPlausible(pane, c)) continue;
      if (!best || (c.lastActivityMs ?? 0) > (best.lastActivityMs ?? 0)) best = c;
    }
    if (best) claim(pane, best);
  }

  return result;
}
