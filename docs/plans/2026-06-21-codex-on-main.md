---
feature: codex-on-main
design: TBD
pass: 1
planner-version: 2.4.1
tier: epic
tier-locked: false
meta: false
autonomous: true
confidence: 90
direction_score: 100
approach_score: 95
complexity-budget:
  files: 21
  loc-delta: 1500
adopted-patterns:
  - lib/match.js assignTranscripts (agent-agnostic matcher — zero change)
  - lib/transcript.js parseRecord swap-by-parser param (additive seam)
  - lib/prompt.js parsePanePrompt (existing numbered-picker detector — extend)
  - server.js prompt/promptkey/promptselect capture-pane answer channel (existing)
  - lib/config.js readConfig/writeConfig key pattern (mirror claudeBin)
  - web/src/lib/convert.ts block-kind-driven converter (logic-stable — zero change)
  - feat/phone-suite lib/agents/codex.js + codex-pending.js (port pure logic)
---

# Plan — Codex CLI Agent Parity on current `main`

## Context (pass 1)

`claude-control` watches/drives Claude Code sessions running in tmux: discovers them
by matching panes to transcripts, tails the transcript JSONL live, streams a normalized
message model to a React UI, answers Claude's interactive prompts via tmux keystrokes,
and spawns new sessions from the rail. The user wants **full parity for OpenAI Codex
CLI**: discover Codex sessions, stream their transcripts, spawn Codex (and Claude) via a
full picker, and answer Codex approval prompts with parity to Claude's AskUserQuestion.

A prior attempt built this on a stale `v0.1.0` branch (`feat/phone-suite`) with an
`AgentAdapter` abstraction in `lib/agents/`. That attempt is discarded. **Its Codex-domain
logic is sound and codebase-agnostic — it ports.** Its integration design is invalid:
current `main` is ~6× larger and already grew seams the stale base lacked. This plan
re-integrates the *ported Codex logic* against main's *real* module boundaries.

The Codex feasibility gate is **already PASSED** (Phase 0a spike on Codex CLI
`v0.131.0-alpha.4`; evidence in `test/fixtures/codex/APPROVAL-SHAPES.md` +
`approval-prompts.spec.json` + captured panes + `sample-rollout.jsonl`). The approval
modal is a stable, anchorable numbered-select surface; the rollout JSONL taxonomy is
documented; approvals are TUI-only (pending = capture-pane, history = JSONL). **No
Codex-domain unknown remains.** Residual risk is purely integration-against-main, which
this pass has substantially mapped and de-risked.

## Goal

Codex CLI reaches functional parity with Claude in `claude-control` — discovery,
live transcript streaming, full spawn picker (session + cwd + agent-type), and full
answer parity for approval prompts — with `npm test` (server) and `cd web && npm test`
(vitest) green and the Claude path behaviorally unchanged.

## Success signals

- A `codex` session running in tmux appears in the rail with a `codex` agent badge, its
  transcript streams live (exec_command + apply_patch + reasoning rendered), and the
  existing 355 server/vitest tests stay green plus new Codex unit tests pass.  [known]
- A live Codex approval modal ("Would you like to run…/make edits?/trust dir?") surfaces
  in the UI as an actionable prompt and is answerable from the browser (number-key →
  tmux), confirmed against the captured `pane-exec-approval.txt` /
  `pane-edit-approval.txt` fixtures.  [known]
- The spawn control launches either `claude` or `codex` into a new tmux window at a
  chosen cwd; Claude spawn (`claude --name <n>`) remains byte-identical to today.  [known]
- `web/src/lib/convert.ts` (the frontend converter) has **zero logic change** — the
  server emits the identical `NormalizedMessage` shape for Codex.  [known]

## Approach (pass 1)

**Chosen: thin per-agent strategy threaded through main's existing agnostic seams —
port the pure Codex logic, reuse the capture-pane answer channel, no `lib/agents/` layer.**

The investigation established that main already did most of the abstraction work the stale
base lacked. Four seams are already agent-agnostic or pre-wired:

1. **Discovery/matching** — `lib/match.js` `assignTranscripts(panes, candidates)` is a pure,
   deterministic, timing+scope matcher with no Claude/JSONL coupling (it imports only
   `isCwdConsistent`). Codex candidates merge by **appending to the candidate array** built
   in `lib/sessions.js`. `match.js` needs **zero changes**.
2. **Normalization** — `lib/transcript.js` has a single `parseRecord(line)` seam and an
   agent-agnostic tail/offset/watch loop. A `{ parser }` constructor param + a sibling
   `parseCodexRecord` (ported) emits the identical `{uuid,role,ts,blocks,rawType}` shape.
3. **Answering** — main **already has** the capture-pane answer channel for TUI prompts
   that never reach the transcript: `startPromptPoller` → `parsePanePrompt` (`lib/prompt.js`)
   → `prompt` WS frame → a UI prompt component (App.tsx:1637), answered by
   `promptkey` (a whitelisted number-key sender, server.js:1557) / `promptselect`. This is
   *exactly* Codex's situation (approvals are TUI-only). The ported `buildAnswerProgram`
   returns `[digit,'Enter']` — a drop-in for `promptkey`.
4. **Frontend** — `web/src/lib/convert.ts` is block-kind-driven and agnostic; `types.ts`
   already carries `agentType: string|null`. exec_command/apply_patch/reasoning all map to
   existing block kinds. Converter logic change = **none** (the locked decision holds).

So the seam is **narrow**: a per-agent recognition+discovery+parse+launch strategy that
`SessionRegistry` and `server.js` select on by `kind`, plus extending `parsePanePrompt`
for the Codex modal and `NewSessionForm` for the full picker.

**...and not the stale plan's `AgentAdapter` interface in `lib/agents/`** because main's
seams already provide the polymorphism points (parser param, candidate array, capture
channel) without a new module layer; a heavyweight adapter interface would re-abstract
code main already factored and fight its module boundaries (S1).

**...and not routing Codex answers through the transcript `answer` handler** (as the stale
base did) because Codex approvals are never in JSONL — `getPending()` from the tailer is
always empty for them. The capture-pane `prompt`/`promptkey` channel is the correct and
already-built seam (T2).

**...and not a `reply-only` MVP fallback** because full answer parity is locked AND the
capture channel already supplies numbered-select answering, so parity is the *cheaper*
path, not the harder one.

## Phases

### Phase A — Config + discovery (Codex sessions appear in the rail) — `specialist`
Scope: Codex sessions discovered, matched to panes, surfaced with a `codex` kind.
- `lib/config.js`: add `codexLaunchCommand` (default `'codex'`) + `codexBin` (default `''`),
  mirroring the `claudeBin` validation block (`CLAUDE_BIN_MAX`); add to `defaults()`,
  `readConfig`, `writeConfig`. Add Codex sessions dir to `server.js` CONFIG as
  `env('CODEX_SESSIONS') || ~/.codex/sessions` (mirrors the `projectsRoot` precedent;
  env names `CLAUDE_CONTROL_CODEX_SESSIONS` / `COCKPIT_CODEX_SESSIONS`).
- New `lib/codex.js` (port from `feat/phone-suite:lib/agents/codex.js`, drop JSDoc
  `import('./adapter.js')` typedefs): `matchesProcess(cmd)`, `parseCodexRecord(line)`,
  `buildTranscriptIndex({codexSessionsRoot}, now)` (date-sharded today+yesterday walk,
  **head-read** `session_meta` cwd), `detectPendingFromCapture` (or fold into
  `parsePanePrompt`, see Phase C), `buildAnswerProgram`, `buildSpawnCommand`.
- `lib/sessions.js`: (1) recognize codex panes — add `CODEX_COMM_RE = /(^|\/)codex$/` and a
  codex branch to `_buildPaneProc`/pane classification; (2) in `_buildCandidates`, also call
  the Codex discovery walk and **append** its candidates (set `projectDir:null` so they fall
  to the `isCwdConsistent` scope path in match.js); (3) extend session assembly (`:583`) to
  set `kind:'codex'`; (4) gate the Claude-TUI pollers (`tui.js` ctx/model/thinking) by `kind`
  so codex panes don't get garbage status.
Tests: port `feat/phone-suite:test/codex-adapter.test.js` (matchesProcess, discovery against
`sample-rollout.jsonl`, parseCodexRecord 13 cases) — re-point imports to `lib/codex.js`.

### Phase B — Transcript normalization + streaming (Codex transcripts render) — `specialist`
Scope: a subscribed Codex session tails and streams the normalized model.
- `lib/transcript.js`: add `{ parser = parseRecord }` to the `TranscriptTailer` constructor;
  store `this._parse`; route the parse call-sites (`:343`, `:417`) through `this._parse`.
  Strictly additive — default preserves all Claude behavior. `_trackPending`/`_syncPending`
  stay untouched (they key off normalized blocks; for Codex they simply never fire, which is
  correct — Codex pending comes from capture, not the tailer).
- `server.js` subscription path: select `parseCodexRecord` vs `parseRecord` by the session's
  `kind` when constructing the tailer.
- Frontend: confirm `web/src/lib/convert.ts` + `MessageParts.tsx` render exec_command
  (tool_use/tool_result), apply_patch (tool_use named `apply_patch`), reasoning (thinking
  placeholder) with **no logic change**. Optional polish (out of scope this plan): a diff
  highlighter for apply_patch.
Tests: `transcript.js` parser-param test (Claude default unchanged + Codex parser routes);
streaming smoke against `sample-rollout.jsonl`.

### Phase C — Approval detection + answering (full parity) — `specialist`
Scope: Codex approval modals surface and are answerable.
- `lib/prompt.js`: extend `parsePanePrompt` to recognize the three Codex headings
  ("Would you like to run the following command?" / "…make the following edits?" /
  "Do you trust the contents of this directory?") and the `N. label (key)` option form with
  `›` (U+203A) highlight + "Press enter to confirm or esc to cancel" footer. The existing
  detector is already 90% there (numbered options + cursor + esc-footer anchors); the delta
  is the Codex heading set, the `(key)` shortcut capture, and U+203A as a cursor glyph.
  Port `detectPendingFromCapture`'s heading/option/footer logic as the Codex branch.
- Pending→question mapping: port `codexPendingToFrontend` (from
  `feat/phone-suite:lib/agents/codex-pending.js`) — synthesizes a deterministic `toolUseId`
  (`codex:<kind>:<hash>`) and a single-question `{question, header, multiSelect:false,
  options:[{label, description}]}`. Confirm shape matches the `prompt`-frame
  `PanePrompt`/`PanePromptOption` type OR the `Pending`/`Question` type in
  `web/src/lib/types.ts`.
- Answer routing (**DECISION — see OQ1**): route Codex answers through the existing
  `promptkey` handler. Widen the `promptkey` ALLOWED set (server.js:1563) only if Codex
  letter-shortcut answering is wanted (number-key + Enter already covered). Port
  `buildAnswerProgram` to resolve a selection → `[digit,'Enter']`.
Tests: port `feat/phone-suite:test/codex-answer.test.js` sections 1–3 (detect exec/edit
fixtures, `codexPendingToFrontend`, answer routing). Drop section 4 (it tests Claude's
`lib/answer.js`, not Codex — re-home or omit).

### Phase D — Spawn full picker (session + cwd + agent-type) — `officer`-designed, `specialist`-built
Scope: spawn either agent into a new tmux window at a chosen cwd.
- `server.js` `handleSessionNew` (`:680`): accept `{ cwd?, name?, agent? }` on
  `POST /api/session/new`; branch the launch string on `agent` — Claude keeps
  `${launchCommand} --name <name>` byte-identical; Codex uses `codexLaunchCommand` with
  Codex's flags (`-C <cwd>` per `buildSpawnCommand`; **no `--name`** — Codex lacks it).
  `tmux.createWindow` is agent-neutral; the launch line is typed via `sendText` so shell
  aliases resolve (preserve that behavior).
- `web/src/components/NewSessionForm.tsx`: extend the collapsed name-only form into the full
  picker — agent-type toggle (Claude/Codex) + cwd field (default `config.defaultCwd`) + name
  (name disabled/omitted when agent=codex). POST the new payload via `createSession`.
- `web/src/components/SessionRail.tsx`: add the `codex` agent badge; extend the rail filter
  from `all → claude → terminal` to include `codex`.
Tests: extend `test/create-session.test.js`-style coverage to assert the Codex launch string
built in `handleSessionNew` (the spawn argv) and the Claude path is unchanged; vitest for the
picker form.

## Breadth sweep (pass 1)

### Alternatives considered
- (a) **Thin strategy through existing seams (CHOSEN)** — blast radius: `lib/codex.js` new +
  `lib/prompt.js`/`sessions.js`/`config.js`/`transcript.js`/`server.js` edits +
  `NewSessionForm`/`SessionRail` edits. Why right: main already factored the polymorphism
  points (agnostic matcher, parser seam, capture answer channel, agentType in FE types);
  this rides them and ports the proven Codex logic with minimal new surface.
- (b) **Port the stale `AgentAdapter` interface into `lib/agents/`** — blast radius: a new
  module layer + a registry + re-routing discovery/parse/answer through one interface. Why it
  *might* be right: a single uniform contract per agent reads cleanly and the ported code
  already conforms to it. Why rejected: it re-abstracts code main already factored
  (`match.js`, the capture channel), adds indirection main doesn't need yet (two agents), and
  the stale interface assumed a transcript-`answer` path that main replaced with the capture
  channel — adopting it would import a wrong assumption. Revisit only at a 3rd agent.
- (c) **Inline Codex branches scattered at each call-site (no `lib/codex.js`)** — blast
  radius: `if (kind==='codex')` forks in sessions.js, transcript.js, prompt.js, server.js.
  Why it *might* be right: smallest file count. Why rejected: scatters Codex domain logic
  across 5 files, defeats porting the cohesive tested `codex.js`, and makes the Claude path
  harder to keep provably unchanged. The cohesive module (a) is both cleaner and lower-risk.

### Adjacent problems
- Codex panes get no SessionStart hook (Claude's `record-pane.mjs` writes `pane-registry`);
  they rely on the timing matcher only. — [in-scope] (acceptable for v1; matcher handles it).
- `tui.js` ctx%/model/thinking regexes are Claude-TUI-specific; codex panes would scrape
  garbage. — [in-scope] (gate the pollers by `kind` in Phase A).
- apply_patch renders as generic tool text, not a syntax-highlighted diff. — [out-of-scope]
  (parity is met by generic rendering; diff polish is a later enhancement).
- Codex `directory_trust` modal appears at session *start*, before any transcript exists —
  the prompt poller only runs on subscribed sessions. — [escalate→OQ3].
- Multi-turn `turn_context` cwd changes (Codex can change cwd per turn). — [out-of-scope]
  (discovery keys off the `session_meta` head cwd; per-turn cwd drift is rare and non-fatal).

### Invisible dependencies
- `CONTRACT.md` is the STALE v0.1.0 contract (says "only runtime dep: ws", `lib/answer.js`,
  vanilla `public/`). Main has diverged massively (React `web/`, `lib/match.js`,
  `lib/config.js` module, uploads/MLX/ttyd). **The live code is authoritative, not
  CONTRACT.md.** Flag for a docs-drift fix (out of scope to fix here; named so execute
  doesn't trust it).
- `match.js` correctness depends on `birthtimeMs ≈ procStartMs` ("agent writes transcript at
  launch in a cwd-scoped dir"). Codex writes date-sharded, not cwd-scoped, but the matcher
  uses cwd from the candidate (head-read), not the path — holds, but Codex candidates must
  carry an accurate `lastActivityMs`/`mtimeMs` for the recency tiebreak.
- `parsePanePrompt`'s strictness (requires `›`/`❯` cursor OR esc-footer to avoid false
  positives on numbered prose) must be preserved when adding the Codex branch — Codex modals
  satisfy both anchors, so this is compatible.
- The `prompt`-frame UI component (App.tsx:1637) currently renders Claude TUI prompts; it
  must render a Codex `PanePrompt` identically (it should — same shape).

### Null hypothesis
Do nothing: Codex sessions show up as plain `terminal` rows (no transcript, no answering),
because neither `isClaudeCmd` nor the process-tree walk recognizes `codex`. The user
explicitly wants parity, and a Codex user gets *nothing* today — so the null hypothesis is
clearly unacceptable. But it confirms the change is purely additive: doing nothing breaks
no Claude behavior, which bounds the blast radius (every Codex edit is gated by `kind` or a
new file).

### Codex findings
- [codex-n/a pass 1] The `/100x:plan-hard` Codex adversarial hook does not fire on
  slash/agent-invoked skills (documented upstream limitation, SKILL.md CP1 banner G1). This
  plan has **no irreversible side-effects** (local-only tmux/file reads + keystrokes into the
  user's own panes; no infra/secrets/money/public comms). Per G1 `[Mark Codex N/A + proceed]`
  is the correct resolution — Approach sub-score caps at 95 (lift, not penalty). Manual
  `/codex:rescue` is not warranted (no irreversible surface). Audit: Codex n/a-override.

## Risk candidates (for DESIGN.md)

- [known] T1: **Claude path regression.** Threading a per-agent strategy through shared
  modules (sessions.js, transcript.js, server.js) risks altering Claude behavior. Mitigation:
  every Codex branch gated by `kind`/new file; `parser` param defaults to `parseRecord`;
  Claude launch string asserted byte-identical; the full 355-test suite is the regression
  gate and must stay green at every phase boundary.
- [known] T2: **Answer routed to the wrong channel.** Sending Codex answers to the transcript
  `answer` handler (stale-base assumption) silently no-ops because `getPending()` is empty for
  Codex. Mitigation: route exclusively through `promptkey`/`promptselect` (capture channel);
  Phase C tests assert the keystroke path against the captured panes.
- [assumed] T3: **`parsePanePrompt` false-positive/negative on Codex modals.** The detector is
  Claude-tuned (BOTTOM_REGION=26, `[.)]` separators, checkbox markers). Codex uses `.`
  separators and `(key)` suffixes. Mitigation: add a Codex branch with the validated
  `approval-prompts.spec.json` regex; test against `pane-exec-approval.txt` /
  `pane-edit-approval.txt`. Target: both fixtures detect correctly; header-only slice does not
  false-positive.
- [assumed] P1: **Codex discovery walk cost.** Per refresh, walking
  `~/.codex/sessions/YYYY/MM/DD` (today+yesterday) + head-reading each rollout's first 64 KB.
  Target: bounded — only 2 date dirs, head-read (not full-file, files reach 200 MB+),
  parallel `Promise.all`; comparable to the existing Claude `findRecentJsonl` tail-read cost.
  Measured: assert no full-file reads in the walk; refresh stays within the existing
  ~4s-poll budget.
- [known] S1: **Over-abstraction temptation.** The stale `AgentAdapter` interface is
  available and conforms. Instead we use main's existing seams (parser param, candidate array,
  capture channel) and one cohesive `lib/codex.js` — no new module layer until a 3rd agent
  justifies it.
- [assumed] S2: **Picker scope creep in `NewSessionForm`.** "Full picker" could balloon into a
  cwd browser. Instead: agent toggle + a plain cwd text field (default `config.defaultCwd`) +
  name — matches the existing minimal-form aesthetic; no filesystem browser this pass.

## Significant decisions

| # | Decision | Considerations | Importance |
|---|---|---|---|
| 1 | Use main's existing `prompt`/`promptkey` capture-pane channel for Codex answers, not the transcript `answer` handler. | Codex approvals are TUI-only (APPROVAL-SHAPES.md); `getPending()` is always empty for them; `promptkey` already sends `[digit,'Enter']` which is exactly what ported `buildAnswerProgram` produces. Cross-ref T2. [ref: server.js:1557,1191] | Picks the correct, already-built answer seam; avoids a dead code path and large blast radius. |
| 2 | Add a `{parser}` param to `TranscriptTailer`; write `parseCodexRecord` as a sibling emitting the identical normalized shape. | Single existing parse seam (`parseRecord`); tail/offset logic is agent-agnostic; default param preserves Claude. Cross-ref T1. [ref: lib/transcript.js:123,199,343] | Smallest-blast-radius normalization seam; keeps the locked server-side decision and a logic-stable frontend. |
| 3 | Leave `lib/match.js` unchanged; merge Codex candidates by appending to the array with `projectDir:null`. | `assignTranscripts` is pure/agnostic; only `encodeCwd` slug + birthtime≈procStart assume Claude, both bypassed via the `isCwdConsistent` scope fallback. [ref: lib/match.js:140,157] | Zero-change to the riskiest deterministic-matching code; Codex rides the existing matcher. |
| 4 | Port Codex logic into one cohesive `lib/codex.js` (+ pending mapper), NOT a `lib/agents/` adapter layer. | Ported code is pure (only JSDoc typedef paths + 2 shape contracts couple to the stale base); main's seams already provide polymorphism. Cross-ref S1. | Minimizes new surface; keeps Claude path provably unchanged; defers an adapter layer until a 3rd agent. |
| 5 | Full spawn picker extends `NewSessionForm` (agent toggle + cwd + name), payload `{cwd,name,agent}`; Claude launch stays byte-identical. | A spawn form already exists; FE types already carry `agentType`; `launchCommand` is a config default typed via send-keys. [ref: server.js:704, NewSessionForm.tsx] | Delivers the locked FULL picker by extension, not greenfield; protects the Claude spawn contract. |

## Seam

**The single load-bearing bet: main's existing `prompt`/`promptkey`/`promptselect`
capture-pane channel is the correct and sufficient seam for Codex approval answering, and
`parsePanePrompt` is the correct place to add Codex modal detection** — i.e. Codex
approvals do NOT flow through the transcript `Pending`/`answer` path at all. Everything in
Phase C hangs on this. If it is wrong (e.g. the `prompt`-frame UI can't render a Codex
approval, or `promptkey`'s whitelist can't express a needed Codex answer), Phase C reroutes
to a Codex-specific answer handler.

## Unwind cost

- **Unwind scope:** revert is file-bounded. `lib/codex.js` is new (delete). `config.js`,
  `transcript.js` (param default), `match.js` (untouched) revert cleanly. The load-bearing
  bets live in `lib/prompt.js` (Codex branch in `parsePanePrompt`) + `server.js` (kind-branch
  in subscribe/spawn) + `sessions.js` (candidate append + pane recognition). Worst-case
  unwind = revert those branches + delete `lib/codex.js`; ~8 files, all additive/gated, so
  revert restores the Claude path exactly. No data migration, no persisted-state change.
- **Signals the seam is WRONG:** the `prompt`-frame UI can't render Codex options without a
  type change; `promptkey` answers don't land (Codex re-renders mid-keystroke); pending
  flaps because the 2s poller races the modal. → reroute to a dedicated Codex answer handler.
- **Signals the seam is RIGHT:** `pane-exec-approval.txt` / `pane-edit-approval.txt` detect
  through `parsePanePrompt`; a `[digit,'Enter']` via `promptkey` resolves a live modal;
  the existing `prompt`-frame component renders the Codex `PanePrompt` with no type change.

## Out of scope

- apply_patch syntax-highlighted diff renderer (generic tool rendering meets parity).
- Codex `directory_trust` auto-handling before subscription (see OQ3; default: surface once
  subscribed; pre-subscription trust is a later enhancement).
- A `lib/agents/` adapter layer / agent registry (deferred until a 3rd agent).
- Per-turn cwd drift handling for Codex (`turn_context` changes).
- `CONTRACT.md` docs-drift rewrite (flagged; separate chore).
- Codex attachments/images parity (the dispatch's locked scope is discovery + transcript +
  spawn + answer; attachments not named — deferred unless reprioritized).

## Open questions

| # | Question | Load-bearing | My lean | Why it matters | Cost if wrong |
|---|---|---|---|---|---|
| OQ1 | Answer-channel reconciliation: the locked decision says "FULL answer parity via AskModal", but main's real seam for TUI-only approvals is the `prompt`/`promptkey` capture channel + a separate prompt UI component, not `AskModal`. Route Codex approvals through the existing capture channel (recommended) or force them into `AskModal`? | true | Route through the existing `prompt`/`promptkey` channel; it already does numbered-select answering and the ported `buildAnswerProgram` is a drop-in. "Full parity" is satisfied functionally (UI surfaces + answerable from browser) even though the rendering component differs from `AskModal`. [assumed] | Determines Phase C's entire shape; AskModal-forcing would mean synthesizing transcript pending entries (fighting main's grain) vs riding a built channel. | High — wrong pick = Phase C rebuild. |
| OQ2 | Does the existing `prompt`-frame UI component (App.tsx:1637) render a Codex `PanePrompt` (flat numbered options + per-option `key`) without a `types.ts` change, or must the Codex pending be mapped to the `Pending`/`Question` shape instead? | true | The `PanePrompt`/`PanePromptOption` type already carries per-option `key`; the existing component should render it. Verify in Phase C; if not, map via the ported `codexPendingToFrontend` to the `Question` shape (also already supported). [assumed] | Decides whether Phase C needs any FE type/component change or is pure server-side. | Medium — at worst a small FE mapping. |
| OQ3 | The Codex `directory_trust` modal fires at session start, before subscription, so the prompt poller (subscribed-only) misses it. Handle it (poll unsubscribed codex panes briefly) or document as a known gap (user answers trust in tmux directly)? | false | Document as a known gap for v1; the trust prompt is a one-time per-directory event the user can answer in tmux. Adding unsubscribed polling violates the resource doctrine (capture only on demand). [assumed] | Edge-case completeness vs resource doctrine. | Low — cosmetic; user can resolve in-pane. |
| OQ4 | Should `promptkey`'s ALLOWED set widen to admit Codex letter-shortcuts (`y`/`p`/`a`/`esc`), or is number-key + Enter sufficient for full parity? | false | Number-key + Enter is sufficient (every Codex option is reachable by its number; `buildAnswerProgram` already emits digits). Skip widening the whitelist to keep the keystroke surface minimal. [assumed] | Minor robustness vs minimal attack surface on the keystroke whitelist. | Low — number-key covers all options. |

## Assumptions log
<!-- /100x:plan-hard appends a line each time CP3 auto-resolves a non-load-bearing OQ.
     /100x:execute appends a line each time CP2 makes a non-load-bearing call. -->
- pass 1 (2026-06-21): OQ3 "directory_trust pre-subscription" → assumed `document as known gap; do not poll unsubscribed panes` (not load-bearing; cost-if-wrong: cosmetic — user answers trust in tmux).
- pass 1 (2026-06-21): OQ4 "promptkey letter-shortcut whitelist" → assumed `number-key + Enter sufficient; do not widen whitelist` (not load-bearing; cost-if-wrong: minor robustness).

## Pass log
- Pass 1 (2026-06-21): Initial plan against current `main`. Mapped Codex onto four real seams via parallel investigation of `match.js`/`sessions.js`/`transcript.js`/`prompt.js`/`config.js`/`server.js` + the `feat/phone-suite` reference logic. Key findings: (1) `match.js` is agnostic — zero change; (2) main ALREADY has the capture-pane answer channel (`prompt`/`promptkey`/`promptselect`) that is exactly the Codex approval seam — major simplification vs the stale base's transcript-`answer` routing; (3) normalization seam = one `{parser}` param on `TranscriptTailer`; (4) frontend converter needs zero change (`types.ts` already has `agentType`); (5) reference logic ports ~verbatim (only JSDoc typedef paths + 2 shape contracts couple to the stale base). 4 phases A–D, tiers specialist/officer. Surfaced OQ1 (answer-channel reconciliation: capture channel vs literal AskModal) as the one load-bearing decision needing Ernest. Codex: n/a-override (hook doesn't fire on slash skills; no irreversible surface). cited_ratio = 5/5 decision rows cite refs = 1.0. Confidence 90 (Direction 100, Approach 95 [G1 n/a lift], OQ 85 [one load-bearing assumed], Constraints 100, Reuse 100; 2.4.0 weighted total normalizes ≥85; both Stage-1 gates PASS).
