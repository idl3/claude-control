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
// Two candidates active within this window count as a recency "tie", so the
// start-time ↔ birthtime signal breaks it (concurrent sessions in one cwd).
// Beyond it, the more-recently-active transcript always wins (resume-safe).
const RECENCY_TIE_MS = 2 * 60_000;

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
 * @property {string}      target        "session:window.pane"
 * @property {string}      windowName
 * @property {string}      cwd
 * @property {number|null} procStartMs   claude process start (ms epoch), or null
 * @property {string|null} [capturedText] recent visible text captured from the pane
 *
 * @typedef {Object} MatchCandidate
 * @property {string}      transcriptPath
 * @property {string|null} cwd            cwd recorded inside the transcript
 * @property {number|null} birthtimeMs
 * @property {number|null} mtimeMs
 * @property {number|null} lastActivityMs
 * @property {string|null} customTitle
 * @property {string|null} aiTitle
 * @property {string|null} [recentText]   recent assistant message text from the transcript tail
 */

// Minimum number of word tokens that must overlap for the content-fingerprint
// tiebreak to fire a decision. Prevents noise from short/common words.
const FINGERPRINT_MIN_OVERLAP = 3;

/**
 * Score how well a candidate's transcript text matches a pane's captured text.
 * Returns the count of distinct word tokens present in both strings (case-folded,
 * alpha-only, ≥4 chars). Returns 0 when either input is absent or empty.
 *
 * @param {string|null|undefined} paneText
 * @param {string|null|undefined} candidateText
 * @returns {number}
 */
export function fingerprintScore(paneText, candidateText) {
  if (!paneText || !candidateText) return 0;
  const tokenise = (s) => {
    const tokens = new Set();
    for (const m of s.matchAll(/[a-zA-Z]{4,}/g)) tokens.add(m[0].toLowerCase());
    return tokens;
  };
  const paneTokens = tokenise(paneText);
  if (paneTokens.size === 0) return 0;
  let overlap = 0;
  for (const m of candidateText.matchAll(/[a-zA-Z]{4,}/g)) {
    if (paneTokens.has(m[0].toLowerCase())) overlap++;
  }
  return overlap;
}

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

  const activity = (c) => c.lastActivityMs ?? c.mtime ?? c.birthtimeMs ?? 0;

  // Choose between two candidates for a pane: RECENCY is primary (the actively-
  // written transcript wins), and start-time ↔ birthtime only breaks ties when
  // two candidates were active at nearly the same time (genuinely concurrent
  // sessions in one cwd). This is what fixes resumed sessions: a resumed
  // transcript is born long ago but is the most-recently-active, so it must beat
  // a freshly-BORN but stale sibling whose birth merely coincides with the
  // resume time (the old "start-time grabs the wrong transcript" bug).
  //
  // Content-fingerprint tiebreak (PLE-41): when timing signals still cannot
  // distinguish candidates (procStartMs unknown + activities within RECENCY_TIE_MS),
  // compare word-token overlap between the pane's captured text and each
  // candidate's recent transcript text. This is a NO-OP when either side lacks
  // text data, preserving all existing behavior.
  const prefer = (pane, c, best) => {
    const ca = activity(c);
    const ba = activity(best);
    if (Math.abs(ca - ba) > RECENCY_TIE_MS) return ca > ba;
    if (pane.procStartMs != null && c.birthtimeMs != null && best.birthtimeMs != null) {
      const cd = Math.abs(c.birthtimeMs - pane.procStartMs);
      const bd = Math.abs(best.birthtimeMs - pane.procStartMs);
      if (cd !== bd) return cd < bd;
    }
    // Content-fingerprint tiebreak: only fires when both candidates carry
    // recentText and the pane has capturedText, AND the scores differ by at
    // least FINGERPRINT_MIN_OVERLAP (avoids flipping on trivial noise).
    if (pane.capturedText && c.recentText && best.recentText) {
      const cs = fingerprintScore(pane.capturedText, c.recentText);
      const bs = fingerprintScore(pane.capturedText, best.recentText);
      if (Math.abs(cs - bs) >= FINGERPRINT_MIN_OVERLAP) return cs > bs;
    }
    return ca > ba;
  };

  for (const pane of ordered) {
    if (result.has(pane.target)) continue;
    let best = null;
    for (const c of available(pane)) {
      if (!temporallyPlausible(pane, c)) continue;
      if (!best || prefer(pane, c, best)) best = c;
    }
    if (best) claim(pane, best);
  }

  return result;
}
