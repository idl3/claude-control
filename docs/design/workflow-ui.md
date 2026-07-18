---
design-schema-version: 1
slug: workflow-ui
intent: Make a running Claude Code Workflow (multi-agent, phased fan-out) a first-class, legible, live surface in the cockpit — so the operator can watch phases + agents progress and read each agent's result without hunting through raw JSON or transcript.
jtbd:
  trigger: A session invokes the `Workflow` tool to plan/build, fanning out many subagents grouped into phases.
  task: The operator wants to see — at a glance AND in detail — which phases exist, which agents are queued/running/done, what each running agent is doing right now, and each finished agent's result.
  outcome: So they can trust the orchestration, catch a stuck/failed agent early, and read results in place.
  current-workaround: The `/workflows` CLI progress tree (terminal-only, not in the cockpit) plus hand-reading `wf_<runId>.json` and per-agent JSONL.
heuristics:
  - rule: "While a workflow's status is running, its live progress is reachable without scrolling — a persistent dock sits above the composer."
    fail-condition: "A workflow is running but scrolling to the composer shows no workflow status anywhere on screen."
    severity: high
  - rule: "Agents are visually grouped under their phase using a labeled common-region (Gestalt), never a flat undifferentiated list."
    fail-condition: "Agent rows render with no phase header / boundary between phaseIndex groups."
    severity: high
  - rule: "Every agent/workflow state is encoded by at least TWO channels (icon-shape + text label), never hue alone."
    fail-condition: "queued vs running vs done is distinguishable only by color (fails greyscale/colorblind check)."
    severity: high
  - rule: "Large fan-outs stay bounded: phases beyond a threshold render collapsed-by-default and the mounted agent-row DOM is capped (virtualized/summarized)."
    fail-condition: "A 40-agent workflow mounts 40+ fully-expanded rows on first paint."
    severity: high
  - rule: "Text over any ring/tint stays legible (contrast >= 4.5:1); accents are 1px strokes, never filled gradients behind text."
    fail-condition: "Any agent label/caption has contrast < 4.5:1, or a status pill is a filled gradient behind its own text."
    severity: high
  - rule: "A live state change (queued->running->done, phase completes) animates IN PLACE with ~zero layout shift."
    fail-condition: "Playwright shows the card's other rows jump/reflow (CLS > 0.1) when one agent completes."
    severity: medium
  - rule: "Every interactive row/control has designed hover + focus-visible + active states and a >= 44px touch target on mobile."
    fail-condition: "A tappable agent row is < 44px tall on 390px width, or has no focus-visible outline."
    severity: medium
  - rule: "The collapsed card never dominates the transcript — its resting height is bounded; deep detail is user-initiated."
    fail-condition: "A completed workflow card is taller than ~60% viewport before any expansion."
    severity: medium
adopted-from:
  - SubAgentStrip pill grammar (running=amber+pulse, done=green, ~0.75 idle opacity, hover quick-view)
  - meta chip conventions (--meta-* : model / effort / ctx pills in SessionRail)
  - single sub-agent transcript viewer (reused for the Agent View full transcript)
  - cosmos theme tokens (--glass-panel, thin 1px --*-ring accents, --term-glow red->yellow family)
  - existing above-composer docked surface pattern (SubAgentStrip mounts there today)
  - manual transcript windowing (INITIAL_VISIBLE / LOAD_EARLIER_STEP) — the perf discipline the card must honor
---

# Design — Workflow UI (card · live dock · agent view · rail indicator)

Placement decision (operator-locked): **inline canonical card + persistent live dock** — the Workflow Card renders inline in the transcript at the `Workflow` tool block (canonical, historical + live), AND whenever a workflow's `status === running` a compact live dock is pinned above the composer so progress is watchable without scrolling. Four surfaces below.

## Surfaces in scope

1. **Workflow Card** — inline transcript block: header + phase-grouped agent tree.
2. **Live Dock** — compact progress strip above the composer while running (mirrors the active phase + current agent); tap → scroll to / expand the inline card.
3. **Agent View** — expanded single agent: `resultPreview` inline → full transcript overlay (reuses sub-agent viewer).
4. **Rail indicator** — per-session at-a-glance glyph + `N/M`.

## Hierarchy

### Workflow Card (inline)
| Position | Element | Why this order |
|---|---|---|
| F1 | Status + progress (`● running · 4/6` or `✓ 6/6`) | Visibility-of-system-status is the whole point; the operator's first question is "is it working / how far." |
| F2 | Workflow name + one-line summary | Identifies WHICH workflow (a session can host several runs). |
| F3 | Phase groups → agent rows | The detail, progressively disclosed; collapsed-by-default when large. |
| F4 | Aggregate meta (agents · tokens · elapsed) | Cost/scale context, right-aligned in header; secondary. |

### Live Dock (above composer, running only)
| Position | Element | Why this order |
|---|---|---|
| F1 | Active phase + bar `▓▓▓▓░░ 4/6` | The single most-wanted live fact. |
| F2 | Current running agent + `lastToolName` caption | "What is it doing right now" — recognition over recall. |
| F3 | Tap-to-expand chevron | Route to the full inline card. |

### Agent View (expanded)
| Position | Element | Why this order |
|---|---|---|
| F1 | Agent identity (label / agentType) + state | Confirms which agent you opened. |
| F2 | `resultPreview` (done) or live `lastToolName` + elapsed (running) | The payload. |
| F3 | model · tokens · toolCalls · duration | Provenance/cost. |
| F4 | "Open full transcript" → overlay | Deep dive, user-initiated. |

## Interaction states

| Element | default | hover | focus | active/pressed | disabled | loading/running | success/done | error | empty |
|---|---|---|---|---|---|---|---|---|---|
| Card header | collapsed summary, status chip | subtle lift (bg +4%) | 1px focus ring | toggles collapse | n/a | status chip amber, thin pulsing ring | status chip green, static | status chip red "failed", summary shows failed count | n/a (card only exists if a run exists) |
| Phase group header | title · detail · `k/n` · chevron | bg +4%, chevron hint | focus ring | collapse/expand phase | n/a | amber dot if any agent running | green check when all done | red if any agent errored | "no agents yet" (queued phase) |
| Agent row | state dot + label + model chip + meta | bg +4%, quick-view of `promptPreview` | focus ring, row outlined | expand inline (Agent View) | n/a | ◐ amber pulse dot + `lastToolName` caption | ● green dot + "done · {dur}" | ✕ red dot + short error | — |
| Agent row (queued) | ○ grey dot, label dimmed 0.6, "queued" | tooltip "waiting for a slot" | focus ring | (non-expandable until started) | visually inert | — | — | — | — |
| Live-dock strip | phase + bar + current agent | (desktop) bg +4% | focus ring | tap → expand card | n/a | amber bar fills as `k/n` grows | flips to "✓ done · {dur}" for ~4s then dismisses | red "failed" + tap to card | hidden when no running workflow |
| "Open transcript" | text button ↗ | underline | focus ring | opens overlay | n/a | spinner while first bytes load | transcript renders | "transcript unavailable" inline | — |
| Rail indicator | ⚙ + `N/M` | tooltip name | (part of row focus) | selects session | n/a | ⚙ amber + subtle pulse | ⚙ fades out shortly after done | ⚙ red | absent when no workflow |

Empty/edge states are first-class:
- **Queued phase (no agents started):** phase header shows "queued" + a hairline placeholder, NOT a blank region.
- **Workflow with a single phase (the common case, e.g. specimen):** the phase header is de-emphasized (no redundant chrome) — the card reads as "name → 6 agents."
- **Multi-run session:** each `wf_<runId>.json` is its own card at its own tool-block position; the live dock shows only the most-recently-active running run, with a `+N more` affordance if two run concurrently.
- **Failed/errored:** the failing agent's row is pinned to the top of its phase (recognition), card status = red, summary names the failure count.

## Responsive & a11y

| Breakpoint | Layout | Touch target | Notes |
|---|---|---|---|
| 320–430 (phone) | Card full-bleed; phases collapsed by default; agent rows single-column, 48px tall; Agent View opens as a full-screen overlay (not inline accordion) to preserve reading space; live dock respects `visualViewport` and sits ABOVE the on-screen keyboard | >= 44px | Dock must never hide behind the keyboard (reuse the composer's visualViewport pinning) |
| 768 (tablet) | Card full-width; phases can default-expanded if total agents <= 12; Agent View = inline accordion + optional side peek | >= 40px | — |
| 1024–1440 (desktop) | Card max-width matched to transcript column; multi-phase runs may show phases side-by-side as columns if >= 2 active phases (pipelined) and width allows; Agent View = inline expand + transcript overlay | mouse | Pipelined phases read as parallel columns — Gestalt "these are concurrent" |

A11y:
- **Tab order:** card header → each phase header (in phase order) → agent rows within an expanded phase → "open transcript". Collapsed phases skip their (hidden) rows.
- **Focus-visible:** `--focus-ring` 2px, offset 2px, on every header/row/button.
- **aria-live:** the live dock is `aria-live="polite"` announcing phase/agent transitions ("Review: feasibility running", "Review complete, 6 of 6"); the inline card is NOT live (avoid double-announce) except its status chip.
- **SR announce strings:** "Workflow {name}, {status}, {done} of {total} agents." · "Agent {label}, {state}." · on completion: "Workflow {name} completed in {duration}."
- **Reduced motion:** pulses/bars become static state changes; no infinite animation (honor `prefers-reduced-motion`, already a codebase convention).
- **State is never color-only:** dot SHAPE differs (○ queued / ◐ running / ● done / ✕ error) + text label, so greyscale still parses.

## Design system tokens used

| Use case | Token | Why this token |
|---|---|---|
| Card + dock surface | `--glass-panel` | Matches composer/rail chrome; the card belongs to the app frame, not the message bubble. |
| Running accent | SubAgentStrip amber + `pulse` keyframe | Reuse the established "running" grammar operators already recognize. |
| Done accent | SubAgentStrip green (static) | Same recognition path as sub-agent pills. |
| Failed accent | `--term-glow` red family | Consistent "attention/danger" hue with the terminal theming. |
| Model chip | `--meta-model` chip | Identical to rail meta chips — model reads the same everywhere. |
| Progress bar | 1px-ring track + solid fill (NOT gradient) | Post-`mask-composite` lesson: no filled-gradient behind text; bar is a solid fill in a hairline track. |
| Phase group region | `--glass-panel` inset + 1px divider | Gestalt common-region without heavy borders. |
| Focus | `--focus-ring` | App-wide consistency. |

## User journey (emotional arc)

1. **Workflow starts** — dock appears above composer: "⚙ Review 0/6 starting". *Felt: acknowledged — "it heard me, it's spinning up."*
2. **Agents go running** — dots flip ◐ amber, captions show live tool names. *Felt: transparency/trust — "I can see it working, not a black box."*
3. **First agents finish** — dots flip ● green in place, bar advances, no reflow. *Felt: momentum — "progress is real."*
4. **A phase completes / pipelines** — phase header checks green; next phase's agents start. *Felt: comprehension — "I understand the shape of the plan."*
5. **Something stalls or errors** — the row pins up red with the error; dock turns red. *Felt: early-warning, not surprise — "I can intervene now."*
6. **Workflow done** — dock flips "✓ done · 12m" then dismisses; inline card is the durable record. *Felt: closure + a readable artifact — "I can go read the results."*
7. **Reading results** — tap an agent → resultPreview → full transcript. *Felt: depth on demand — "answers where I expect them, no JSON spelunking."*

## AI-slop check (mandatory)

Reviewed against the blacklist — none present in this design:
- No purple/violet default gradients (accents are the existing amber/green/red state grammar).
- No 3-column icon-circle feature grid.
- No decorative icons-in-colored-circles (the ⚙ glyph and state dots are functional status, not decoration).
- No centered-everything (left-aligned rows, data tables).
- No uniform bubbly radius (card uses the app's existing panel radius; rows are flush rows).
- No decorative blobs / wavy dividers (dividers are 1px functional separators).
- No emoji-as-primary-design (state is dot-shape + text; ⚙/✓ are functional glyphs, greyscale-safe).
- No colored-left-border-as-primary-differentiator (state is the dot + label, not a left stripe).
- No generic hero copy.
Filled-gradient risk explicitly guarded (heuristic H6) given the recent `mask-composite` regression.

## Performance notes (feeds /100x:plan-hard)

- **Bounded DOM:** collapsed phases render only their header (not rows). Expanded phase with > ~20 agents: windowed render (reuse the transcript's windowing discipline; do NOT mount all rows). A 40-agent run at rest = ~1 header + summary, not 40 rows.
- **Update without re-rendering the world:** the card subscribes to a per-run slice; each agent row is memoized on `(agentId, state, lastToolName, tokens)` so a single agent's tick re-renders one row, not the card. The transcript's `identityConvertMessage` stability constraint (App.tsx) must not be broken by workflow updates.
- **Polling:** backend re-reads `wf_<runId>.json` keyed by mtime (cheap; skip unchanged). Frontend receives the parsed `workflows` slice on the existing session-poll/WS — no new transport.
- **No CLS:** rows reserve their height across state changes; the progress bar animates width only (compositor-friendly), never reflows siblings.

## Unresolved design decisions

| # | Question | Load-bearing | My lean | Why it matters |
|---|---|---|---|---|
| D1 | `[design]` Live dock when TWO workflows run concurrently in one session — stack both, or show most-recent + `+1`? | possible | most-recent + `+1` tap-to-switch | Concurrent runs are rare; stacking eats composer space. Keep dock to one strip. |
| D2 | `[design]` Desktop pipelined phases: side-by-side columns, or always vertical stack? | possible | vertical stack v1; columns as a later enhancement | Columns are nicer for parallelism but add layout complexity + a responsive breakpoint; not worth blocking v1. |
| D3 | `[design]` Agent View full transcript on mobile: reuse sub-agent overlay as-is, or a workflow-scoped variant with "next/prev agent" paging? | possible | reuse as-is v1; add paging if operators ask | Reuse ships faster; paging is a real nicety for reviewing a fan-out but is additive. |
| D4 | `[design]` Auto-expand the phase that's currently running, or keep everything collapsed until tapped? | likely | auto-expand the single active phase, collapse completed ones | Balances "watch live" against bounded DOM; matches the emotional arc (focus on what's happening now). |
| D5 | `[design]` Does the inline card also self-dismiss/collapse to a one-line summary once done + scrolled past, to keep long transcripts light? | possible | collapse to one-line after done (tap to re-expand) | Protects the manual-windowing perf budget in long sessions. |

## Mockup references

Desktop — inline card, one running phase (specimen shape, mid-run):
```
┌─ ⚙  claudex-plan-review-fanout                 ● running · 4/6 ─┐
│    Pass-2 parallel reviewer fan-out          6 agents · 431k · 8m │
│                                                                   │
│  ▾ Review · six plan-aware reviewers in parallel     ▓▓▓▓░░  4/6  │
│      ● coherence     · plan-coherence     haiku   82k  10c  4m    │
│      ● patterns      · plan-pattern-refs  haiku   61k   7c  3m    │
│      ● scope         · plan-scope-guard   haiku   58k   6c  3m    │
│      ◐ feasibility   · plan-feasibility   sonnet  · StructuredOut…│
│      ◐ security      · plan-security      sonnet  · Grep · 2m     │
│      ○ decisions     · plan-decisions     — queued                │
└───────────────────────────────────────────────────────────────────┘
   (tap an agent row → expands result / open transcript)
```

Mobile (390) — collapsed phases + live dock:
```
┌ ⚙ claudex-plan-review-fanout   ● 4/6 ┐
│ Pass-2 parallel reviewer fan-out     │
│ ▸ Review              ▓▓▓▓░░ 4/6      │   ← tap to expand
│ 6 agents · 431k · 8m                  │
└──────────────────────────────────────┘
            … transcript …
┌ ⚙ Review     ▓▓▓▓░░ 4/6 ───── ▸ ┐        ← docked, above keyboard
│ ◐ feasibility · StructuredOutput  │
└───────────────────────────────────┘
[ composer ]
[ on-screen keyboard ]
```

Agent View (tap "feasibility", running):
```
┌ ◐ feasibility · plan-feasibility-reviewer · running ─┐
│ sonnet · 177k tok · 53 calls · 7m                    │
│ now: StructuredOutput                                │
│ prompt: "Review the plan at …/claudex-integration…"  │
│ ▸ Open full transcript ↗                             │
└──────────────────────────────────────────────────────┘
```

Rail indicator (session row):
```
●  claudex-plan-handoff      ⚙ Review 4/6
   opus · main
```
