# Pane→Transcript Binding: PLE-41 Root Cause & Fix

## Root Cause

`lib/match.js`'s `prefer(pane, c, best)` function selects among same-cwd transcript candidates using two signals:

1. **Recency** — if activities differ by more than `RECENCY_TIE_MS` (2 min), the more-recently-active candidate wins.
2. **Birthtime vs. procStart** — if activities are within 2 min AND the pane's `procStartMs` is known, the candidate born closest to the pane's claude process start wins.

When **both signals are absent** — `procStartMs` is null (ps unavailable or process not found) and both candidates have identical or very close `lastActivityMs` — `prefer` falls through to `ca > ba`, which is `false` when activities are equal. This means the first candidate encountered in iteration order wins.

In a two-session same-cwd scenario where both sessions are actively being written (both recently active), the "busier" one is not necessarily encountered first, so the binding is effectively arbitrary. The pane can silently bind to its sibling's transcript.

## Three Options Considered

### Option A: Content-fingerprint tiebreak (CHOSEN)

**How**: Add optional `capturedText` to `MatchPane` (from the already-running `_pollThinking` capture) and optional `recentText` to `MatchCandidate` (from the transcript JSONL tail). When timing signals tie, compute word-token overlap between the pane's visible text and each candidate's recent assistant messages. Higher overlap wins.

**Why chosen**: Purely additive — activates only when the existing signals produce a genuine tie AND both sides provide text. The pane capture is already being done (no new tmux calls on the critical path), and transcript text is already being read (adds ~3 extra JSONL line parses per tail read). No changes to the registry path. No new dependencies.

**Limitation**: Requires at least one `_pollThinking` cycle to run before the first `refresh()` to have `capturedText` populated. On first boot, the cache is empty so the tiebreak is a no-op (falls back to existing behavior). This is acceptable: the window is short and subsequent refreshes (every 4s) have cached data.

### Option B: Session-ID binding at the registry level

**How**: Record the Claude `sessionId` (UUID emitted in each transcript line) at session start via the `record-pane.mjs` hook. Store it in `~/.claude-control/panes/`. On binding, match by `sessionId` instead of inferring by timing.

**Why deferred**: Requires the `SessionStart` hook to be installed on the user's machine. The tiebreak in `match.js` is the fallback path for panes with no hook record. Long-running sessions started before hook installation are not covered. Also requires Claude to emit its `sessionId` at startup, which is only guaranteed in newer versions.

### Option C: Periodic re-verification

**How**: After binding, periodically re-check whether the pane's visible text still matches the assigned transcript. Evict and re-bind if consistency drifts below a threshold.

**Why deferred**: Higher complexity, continuous overhead, and harder to make safe (risk of flapping). Better suited as a self-healing layer once a clean binding mechanism exists (Option B fully deployed).

## What Remains for Legacy Pre-Hook Long-Runners

Sessions started before the `record-pane.mjs` hook was installed have no registry entry. The content-fingerprint tiebreak helps when the pane has accumulated visible text. However, if both sessions have nearly identical visible text (e.g. two similar refactor sessions), the tiebreak may not fire or may pick the wrong one.

**Self-heal: Explicitly deferred.** The operator's manual recovery step is: use the existing manual-pin UI (the pin button in the session row) to force-bind the pane to the correct transcript. This is a one-time action per session. Automatic periodic re-verify (Option C) is the long-term solution and is out of scope for PLE-41.

## Files Changed

| File | Change |
|------|--------|
| `lib/match.js` | Added `fingerprintScore()` export; extended `MatchPane` with `capturedText?`, `MatchCandidate` with `recentText?`; added fingerprint tiebreak as the last fallback in `prefer()` |
| `lib/sessions.js` | Added `recentText` field to `extractTailRecord` (collects last 3 assistant message snippets); added `_paneTextCache` map; caches raw capture in `_pollThinking`; passes `capturedText` from cache into `assignTranscripts` pane objects |
| `test/match.test.js` | 8 new tests: 4 `fingerprintScore` unit tests + 4 `assignTranscripts` tiebreak tests including the PLE-41 regression |
