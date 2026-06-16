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
 * Layered passes (each claims candidates so no transcript is used twice):
 *   1. Title match — a pane's tmux window name uniquely equals a candidate's
 *      customTitle (set by /rename) or aiTitle, cwd-consistent. Strongest:
 *      survives restarts and is independent of timing.
 *   2. Start-time match — candidate birthtime closest to the pane's claude
 *      process start (cwd-consistent). A claude proc creates its transcript at
 *      launch, so this binds same-cwd siblings that started at different times.
 *   3. Recency — most-recently-active remaining cwd-consistent candidate.
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

  const available = (pane) =>
    candidates.filter(
      (c) =>
        !claimed.has(c.transcriptPath) && isCwdConsistent(c.cwd, pane.cwd),
    );

  const claim = (pane, cand) => {
    result.set(pane.target, cand);
    claimed.add(cand.transcriptPath);
  };

  // Pass 1 — unique title match.
  for (const pane of ordered) {
    if (result.has(pane.target)) continue;
    const name = String(pane.windowName || '').trim();
    if (!name) continue;
    const hits = available(pane).filter(
      (c) => c.customTitle === name || c.aiTitle === name,
    );
    if (hits.length === 1) claim(pane, hits[0]);
  }

  // Pass 2 — nearest start-time ↔ birthtime.
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

  // Pass 3 — most-recently-active remaining candidate.
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
      // Apply temporal gate only when pane start time is known.
      if (pane.procStartMs != null) {
        const candActive = c.lastActivityMs ?? c.mtime ?? c.birthtimeMs ?? null;
        if (candActive != null && candActive < pane.procStartMs - startSlackMs) continue;
      }
      if (!best || (c.lastActivityMs ?? 0) > (best.lastActivityMs ?? 0)) best = c;
    }
    if (best) claim(pane, best);
  }

  return result;
}
