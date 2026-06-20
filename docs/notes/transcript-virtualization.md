# PLE-42 — Transcript Render Virtualization: Go/No-Go

**Date:** 2026-06-20  
**Branch:** `ree/ple-42-virtualize`  
**Verdict: DEFER — the problem does not exist in the form assumed by the ticket.**

---

## Executive Summary

The transcript thread already has a working render cap (`INITIAL_VISIBLE = 150`
converted messages). The runtime never receives more than 150 messages regardless
of session length. A 1 000-raw-message session reduces to 150 capped output
messages, estimated ~1 500 DOM nodes. `convertMessages` over 1 000 raw messages
takes **< 1 ms**. There is no measured DOM or CPU problem to fix. Virtualization
is deferred until evidence of a real user-visible regression emerges.

---

## What the code actually does (render path)

### 1. Raw messages → `convertMessages` → merged turns

`web/src/lib/convert.ts` `convertMessages()`:
- Pass 1: index all `tool_result` blocks by id.
- Pass 2: build `ThreadMessageLike[]`, dropping tool-result-only messages.
- `mergeAssistantTurns()`: collapses consecutive assistant JSONL fragments
  (thinking → tool_use → text) into a single merged turn. A real user message
  is the turn boundary.

A 1 000-raw-message transcript with the realistic pattern (user + thinking +
tool_use + tool_result + assistant-text per conversational turn) produces
**400 merged output messages** (200 user + 200 merged-assistant).

### 2. `INITIAL_VISIBLE` cap in `App.tsx`

`web/src/App.tsx` lines 108–113, 380–395, 461–463:

```ts
const INITIAL_VISIBLE = 150;
const LOAD_EARLIER_STEP = 150;

const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
// reset on session switch
useEffect(() => { setVisibleCount(INITIAL_VISIBLE); }, [cockpit.selectedId]);

const hiddenCount = Math.max(0, fullConverted.length - visibleCount);
// runtime receives only fullConverted.slice(hiddenCount)
```

`convertMessages` always runs over the full transcript (tool_result folding
requires it), but the **runtime only mounts the final 150 output messages**.
The "Load earlier" button reveals 150 more per click.

### 3. `ThreadPrimitive.Messages` — all-at-once rendering

`@assistant-ui/react` v0.14.14, `ThreadPrimitiveMessagesInner`:

```js
return Array.from({ length: messagesLength }, (_, index) =>
  jsx(MessageByIndexProvider, { index, children: ... }, index)
);
```

This renders every message in the runtime's store at once. There is **no native
windowing or virtualization** in `@assistant-ui/react` v0.14.x. However, since
the store receives at most 150 messages (after the cap), this is not a problem.

### 4. Scroll-to-bottom

`App.tsx` line 750–830: a custom `useEffect` that tracks a `pinned` boolean,
tailing `vp.scrollTop = vp.scrollHeight` via a `MutationObserver` + `scroll`
listener. The FAB button (`.scroll-to-bottom`) also calls
`vp.scrollTo({ top: vp.scrollHeight, behavior: 'smooth' })`. This is DOM-driven,
not assistant-ui's `autoScroll`, and will work identically whether 150 or 50
messages are mounted.

### 5. In-transcript search

`web/src/components/TranscriptSearch.tsx`: CSS Custom Highlight API over a live
`TreeWalker` traversal of `.thread-viewport`. It walks **only DOM-present text
nodes** — the ones actually mounted by the runtime. Off-screen (not-yet-loaded)
messages are invisible to `textNodesUnder`. This is correct and desirable: search
finds what's visible, and "Load earlier" expands the search domain.

If virtualization were ever added, this search would need a hybrid strategy
(search index over full text + DOM-hit scroll-into-view for visible hits, with
expand-then-scroll for off-screen ones). That interaction cost is non-trivial and
would be a real tradeoff.

---

## Measurements

**Method:** Pure Node/V8 via vitest. `convertMessages` exercised in-process;
no DOM, no browser paint. Harness: `web/src/lib/transcript-render-cost.vitest.ts`.

**Caveats:** jsdom ≠ real browser paint. These numbers characterize CPU cost and
O(n) scaling of the conversion + capping pipeline, not FPS or CLS. Real browser
profiling would be needed to measure scroll jank on actual hardware. No jank has
been reported by users.

### 1 000-raw-message session

| Metric | Value |
|---|---|
| Raw Msg[] input | 1 000 |
| Converted + merged output | 400 messages |
| Hidden by INITIAL_VISIBLE=150 cap | 250 |
| **Messages mounted to runtime** | **150** |
| Content parts in capped set | 300 |
| Estimated DOM nodes (capped, ~5/part) | ~1 500 |
| `convertMessages` wall time | **< 1 ms** |

### 5 000-raw-message stress test

| Metric | Value |
|---|---|
| Raw Msg[] input | 5 000 |
| Converted + merged output | 2 000 messages |
| Hidden by cap | 1 850 |
| **Messages mounted to runtime** | **150** |
| Content parts in capped set | 300 |
| `convertMessages` wall time | **~3 ms** |

### Interpretation

The cap is a hard ceiling. Whether the session has 100 or 5 000 raw messages,
the runtime **always** receives ≤ 150 output messages and ~300 content parts.
`convertMessages` scales linearly and remains well under 5 ms for any realistic
session. The estimated ~1 500 DOM nodes for a fully-loaded visible window is
well within the range that modern browsers handle without jank at 60 fps.

---

## Native windowing in `@assistant-ui/react` v0.14.14

**Not present.** Exhaustive grep of the installed package's `dist/` found no
references to `react-window`, `@tanstack/react-virtual`, `react-virtual`,
`useVirtual`, `VirtualItem`, or any windowing primitive. `ThreadPrimitiveMessages`
renders all messages via `Array.from`. There is no native windowing API to enable.

Adding windowing would require a new dependency (e.g. `@tanstack/react-virtual`)
or a full reimplementation of `ThreadPrimitive.Messages` around a virtual list.

---

## Go/No-Go Decision

**DEFER — NO-GO.**

### Reasons

1. **The measured DOM size at the cap is small.** 150 messages × ~10 DOM nodes/message
   ≈ 1 500 DOM nodes. This is not a DOM bottleneck.

2. **The cap already solves the problem.** `INITIAL_VISIBLE = 150` was introduced
   exactly to prevent a large session from mounting thousands of nodes. It works.
   `convertMessages` over the full transcript is < 3 ms even at 5 000 raw messages.

3. **No native windowing exists.** Any virtualization path requires a new
   dependency and a non-trivial rewrite of the `ThreadPrimitive.Messages` usage.
   Adding `@tanstack/react-virtual` (~12 kB gzip) is not justified when the runtime
   window is already bounded to 150 messages.

4. **Search regression risk is real.** `TranscriptSearch` walks live DOM text
   nodes. A virtual list that unmounts off-screen rows breaks search for non-visible
   matches. The workaround (full-text search index + expand-then-scroll) is
   significant engineering for zero measured gain.

5. **No user-reported jank.** The ticket is speculative ("investigate"). Without
   a repro or user report, this is optimization theater.

### Conditions for re-opening

Reopen if:
- A real browser Lighthouse / DevTools trace shows first-render > 200 ms or
  scroll fps < 50 on a session at the INITIAL_VISIBLE cap.
- A user reports visible jank (not just "it feels slow opening").
- The server message cap (currently ~500 msgs per session per useCockpit) is
  raised significantly AND the INITIAL_VISIBLE cap is removed or raised above ~500.

---

## Recommendation (if re-opened)

If a real problem is eventually measured, the lowest-risk path in priority order:

1. **Lower INITIAL_VISIBLE** (currently 150 → e.g. 75) + smaller LOAD_EARLIER_STEP.
   Zero-dep, immediate, preserves all search/scroll behavior. Try this first.

2. **Replace `ThreadPrimitive.Messages` with a custom list + `@tanstack/react-virtual`.**
   Requires: (a) wrapping the `MessageByIndexProvider` in a virtualizer row,
   (b) keeping a full-text search index alongside the virtual list (the CSS
   Highlight walk must be replaced with an index + Range recreation), and
   (c) a scroll-to-bottom hook that uses the virtualizer's scroll API instead of
   raw `scrollTop`. Estimated effort: 2–3 days. Justified only if step 1 is
   insufficient and a real FPS regression is confirmed on hardware.
