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

**Status: Shipped in PLE-44.** Implemented as a self-heal pass inside the existing `refresh()` loop (no second poller). See details below.

## What Remains for Legacy Pre-Hook Long-Runners

Sessions started before the `record-pane.mjs` hook was installed have no registry entry. The content-fingerprint tiebreak (PLE-41) helps when the pane has accumulated visible text. For the remaining case where drift goes undetected at binding time, PLE-44's self-heal pass re-verifies on every refresh cycle.

The operator's manual recovery step (pin button in the session row) is still available for edge cases where automatic re-binding is not desired.

## Self-Heal: PLE-44

### How it works

Inside `refresh()`, after the initial `assignTranscripts` call completes, a second pass walks every **matcher-bound** pane (those in `autoPanes` — not registry-hooked, not manually pinned):

1. Read the pane's cached text from `_paneTextCache` (already captured by `_pollThinking`).
2. Score the current binding against the pane text via `fingerprintScore`.
3. Score every other candidate in the same pool.
4. If `shouldRebind(currentScore, bestOtherScore)` returns true, replace the binding and log the heal.

### Thresholds (in `lib/match.js`)

| Constant | Value | Meaning |
|----------|-------|---------|
| `SELFHEAL_FLOOR` | 2 | Current score must be **below** this before a rebind is considered |
| `SELFHEAL_MARGIN` | 6 | Best other score minus current must be **at least** this; prevents near-tie flips |
| `SELFHEAL_DEBOUNCE_CYCLES` | 5 | Minimum `refresh()` cycles between consecutive rebinds for the same pane |

### Safety invariants

- **Registry-pinned panes are never touched.** Hook-bound (`hookByTarget`) and manually-pinned (`pinnedByTarget`) panes are excluded from `autoPanes` before the self-heal loop runs.
- **Hysteresis over sensitivity.** `SELFHEAL_MARGIN > FINGERPRINT_MIN_OVERLAP` — the content tiebreak alone cannot trigger a self-heal; the current binding must also be clearly bad.
- **Debounced.** Each pane can be re-bound at most once per 5 refresh cycles (~20 s at 4 s/cycle).
- **Always logged.** Every heal emits a `[pane-selfheal]` line with pane target, old→new transcript paths, and both scores.
- **No new dependency, no new timer.** The pass runs inside the existing `refresh()` call.

## Files Changed

| File | Change |
|------|--------|
| `lib/match.js` | (PLE-41) Added `fingerprintScore()` export; extended `MatchPane` with `capturedText?`, `MatchCandidate` with `recentText?`; added fingerprint tiebreak as the last fallback in `prefer()` |
| `lib/match.js` | (PLE-44) Added `SELFHEAL_FLOOR`, `SELFHEAL_MARGIN` constants and `shouldRebind()` export |
| `lib/sessions.js` | (PLE-41) Added `recentText` field to `extractTailRecord`; added `_paneTextCache` map; caches raw capture in `_pollThinking`; passes `capturedText` into `assignTranscripts` |
| `lib/sessions.js` | (PLE-44) Added `SELFHEAL_DEBOUNCE_CYCLES` constant, `_refreshCycle` counter, `_healLastCycle` map; self-heal re-verify pass at end of `refresh()` |
| `test/match.test.js` | (PLE-41) 8 new tests: 4 `fingerprintScore` unit tests + 4 `assignTranscripts` tiebreak tests |
| `test/match.test.js` | (PLE-44) 4 new tests: `shouldRebind` strong-drift case, near-tie hysteresis, registry-pin exclusion, floor-protection |
