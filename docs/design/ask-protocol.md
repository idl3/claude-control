---
design-schema-version: 1
slug: ask-protocol
intent: A harness-agnostic, hyper-efficient, deterministically-parseable protocol ("pleri.ask") for agent→user questions + user→answers, rendered identically by claude-control and the Olam SPA, replacing the fragile keystroke-puppeteering of Claude Code's native AskUserQuestion.
jtbd:
  trigger: An agent (any harness) needs a structured decision from the user — a plan picker, an OQ gate, a multi-question set, a confirm.
  task: Emit the question so BOTH the cockpit and the SPA render a rich, consistent picker, and get the answer back as structured data.
  outcome: So the round-trip is deterministic, tiny on the wire, and identical across surfaces — no TUI scraping, no synthesized keystrokes, no drift.
  current-workaround: claude-control mirrors the native AskUserQuestion tool_use (or screen-scrapes a numbered TUI menu) and delivers answers by synthesizing keystrokes into the live terminal picker (buildAnswerProgram/parsePicker) — the source of the answerSettling/pickerOpen/send-guard races.
heuristics:
  - rule: "The wire payload carries only codes, ids, and values — never field-definition or type metadata; all categorical fields are enum codes whose meaning lives in the versioned out-of-band schema."
    fail-condition: "Any wire payload contains an inline schema, a type name, or a verbose categorical bool (e.g. `multiSelect:false`, `kind:\"single-select\"`)."
    severity: high
  - rule: "A representative single-question / 4-option ask serializes ≥30% smaller than the equivalent native AskUserQuestion JSON, and any answer for it is ≤ ~40 bytes."
    fail-condition: "The benchmark ask (see Efficiency budget) is ≥ the native equivalent, OR an answer carries option labels/keys instead of positional indices."
    severity: high
  - rule: "An unknown enum value or an unrecognized key degrades gracefully (fallback render / ignore) and never throws."
    fail-condition: "A parser errors, drops the whole set, or crashes on `k:99`, an unknown preview type, or an extra key."
    severity: high
  - rule: "Every answer resolves to exactly one question-set via `qid`; late or duplicate answers are idempotent (last-wins, dups ignored)."
    fail-condition: "An answer with no/ambiguous `qid` is applied, or a duplicate answer double-applies / re-triggers the agent."
    severity: high
  - rule: "The answer round-trip is structured data (a next-turn message or a tool_result), never synthesized keystrokes into a TUI."
    fail-condition: "The new path calls buildAnswerProgram / send-keys / parsePicker to deliver an answer."
    severity: high
  - rule: "A per-question answer slot's JSON type maps 1:1 to intent: int=single pick, array=multi pick, string=free-text/Other, bool/0-1=confirm."
    fail-condition: "A construct exists where the same slot type is ambiguous between two intents."
    severity: high
  - rule: "Previews are a tagged union of renderable types (markdown / code / wireframe / diagram); heavy previews are lazy (fetched/expanded on demand), not eagerly serialized into every ask."
    fail-condition: "A preview is raw pre-formatted ASCII with no type tag, OR a large preview is inlined for an option the user hasn't focused."
    severity: medium
  - rule: "The renderer encodes selection/recommended/danger state by shape+text, not color alone, and stays legible (contrast ≥4.5:1) over any tint (1px rings, no filled gradients)."
    fail-condition: "State is distinguishable only by hue, or option/preview text contrast < 4.5:1."
    severity: medium
adopted-from:
  - claude-control AskInline picker chrome + cosmos tokens (--glass-panel, --meta-*, 1px accent rings)
  - the pill/state grammar (recommended=accent, danger=--term-glow red)
  - hljs syntax highlighting (from #303) for code previews
  - the SPA's existing ~85% AskUserQuestion UI (second consumer)
  - the fixed body.kbd-up mobile keyboard-flush machinery
---

# Design — pleri.ask (interactive question protocol)

Cross-surface protocol + shared renderer. Encoding decision (operator-locked at CP0): **Hybrid** — short-keyed enum objects for the ASK (readable, forward-compatible; prose dominates its bytes anyway), positional + type-discriminated for the ANSWER (tiny; the hot round-trip path).

## The DSL (v1)

### Out-of-band schema (keyed by `v`; NOT on the wire)
Enum tables both consumers ship:
- **`k` question kind:** `0` single-select · `1` multi-select · `2` free-text · `3` confirm
- **`f` option flag:** `0` plain · `1` danger (destructive)
- **`pt` preview type:** `0` markdown · `1` code · `2` wireframe · `3` diagram
- **`we` wireframe element:** `0` frame · `1` row · `2` col · `3` text · `4` button · `5` input · `6` badge · `7` divider · `8` spacer · `9` img
- **`wv` wireframe variant:** `0` default · `1` primary · `2` muted · `3` danger
- **`s` lifecycle status** (render-time only, never on the ask wire): `0` pending · `1` answered · `2` expired · `3` cancelled · `4` superseded

### Question envelope (short-key + enum)
```jsonc
{
  "v": 1,                       // schema version (enum tables + field meanings out-of-band)
  "qid": "a1",                  // question-set correlation id (agent-generated, session-unique, ~4 base36)
  "m": { "ttl": 900 },          // optional meta: ttl seconds, surface hint, etc. (omit when empty)
  "q": [                        // questions[] — MULTI-QUESTION is native (an array)
    {
      "h": "Auth",              // header chip
      "t": "Which auth method?",// prompt
      "k": 0,                   // kind enum
      "r": 0,                   // recommended option index (optional)
      "ft": 1,                  // allow free-text/"Other" on a select (optional; 1=yes)
      "o": [                    // options[] (omit for k:2 free-text)
        { "l": "OAuth", "d": "OAuth 2.0 flow" },              // l=label, d=description?
        { "l": "API key", "d": "Static env key", "f": 1 },   // f=flag (danger)
        { "l": "mTLS", "d": "Client certs", "p": { /* preview, see below */ } }
      ]
    }
  ]
}
```

### Answer envelope (positional, type-discriminated — tiny)
```jsonc
{ "v": 1, "qid": "a1",
  "a": [ 0 ] }                  // per-question, SAME order as q[]:
//        int      → single-select option index (or confirm 0/1)
//        [1,2]    → multi-select option indices
//        "text"   → free-text (k:2) OR "Other" on a select (ft:1)
// optional "x": 1 → the user cancelled/dismissed the whole set
```
Multi-question answer: `{"v":1,"qid":"a1","a":[0,[1,2],"custom"]}` — one slot per question, type discriminates intent. No keys, no labels — resolved to labels at render/log time via the (co-located) question set.

### Preview DSL (`p`) — richer than ASCII, still compact
Previews are a tagged union so options can show real mockups/wireframes/code/diagrams instead of monospace ASCII, without bloating the wire:
```jsonc
"p": { "pt": 0, "s": "**Recommended** — see [docs](…)" }      // markdown
"p": { "pt": 1, "g": "ts", "s": "const x = …" }               // code (g=lang; hljs-highlighted)
"p": { "pt": 3, "g": "mermaid", "s": "flowchart LR; A-->B" }  // diagram (flow/sequence/state)
"p": { "pt": 2, "w": [ /* wireframe nodes */ ] }              // wireframe mockup (below)
```
**Wireframe sub-DSL (`pt:2`)** — a compact enum-coded node tree; renders as styled boxes/buttons/inputs, not raw text. Node = `[we, a?, c?]` (element enum, short attrs, children):
```jsonc
"w": [
  [0, {}, [                                  // frame
    [3, {"x":"Which auth?"}],                //   text
    [1, {}, [                                //   row
      [4, {"x":"OAuth", "v":1}],             //     button (primary)
      [4, {"x":"API key"}]                   //     button (default)
    ]],
    [5, {"x":"key…", "g":1}]                 //   input (grow)
  ]]
]
// attrs a: x=text/label · v=variant enum (wv) · g=grow(0/1) · w=width-hint — all optional, omit when default
```
This gives "nicer mockups + wireframes, efficiently": the wireframe above is ~90 bytes and renders as a real UI sketch. Markdown/code/diagram cover the other preview needs. **Heavy previews are lazy** (H7): the ask carries a compact preview or a ref; large content expands on focus, not eagerly in every option.

## Envelopes (pluggable transport) + Answer channel

| Envelope | Reliability | Answer channel | Mid-turn? | Agnostic? | v1? |
|---|---|---|---|---|---|
| **Content-block** `<pleri:ask>…</pleri:ask>` at turn-end | prompt-adherence (lenient parse + re-ask) | next-turn `<pleri:answer>…</pleri:answer>` user message | no (turn-end) | ✅ any model/harness/API | **yes (primary)** |
| **MCP tool** `pleri_ask` | schema-enforced | `tool_result` from our handler | yes | ✅ any MCP harness | later |
| **Native AskUserQuestion → DSL adapter** | schema-enforced | (unchanged harness path) | n/a | ❌ Claude Code only | render-only |

**The decoupling:** for surfaces WE control (the `/100x` chain, plan-hard OQ gates, olam planning), emit `pleri:ask` so WE own the answer channel — structured data, deleting `buildAnswerProgram`/`parsePicker`/keystroke-puppeteering. The native adapter is read-only normalization so *uncontrolled* agents still render; migrate our own skills to `pleri:ask` over time.

## Hierarchy (renderer)
| Position | Element | Why |
|---|---|---|
| F1 | The prompt `t` + its options (the decision) | Visibility of the actual choice. |
| F2 | Recommended option (`r`) affordance + header `h` | Guides without hiding alternatives. |
| F3 | Description `d`, preview `p` (progressive disclosure — expand/focus) | Depth on demand; keeps the resting picker scannable. |

DSL field priority: `v`+`qid` (routing/correlation) → `q[].k`+`t` (what's asked) → `o[]` → `p` (heaviest, lazy).

## Interaction states
| Element | default | hover | focus | selected | recommended | danger | disabled | loading | done/answered | expired |
|---|---|---|---|---|---|---|---|---|---|---|
| Option (select) | pill, 1px ring | bg +4% | focus ring | filled dot + ring | "◆ recommended" tag | red ring/`f:1` | dimmed | — | read-only, shows pick | greyed |
| Multi checkbox | box | +4% | ring | ✓ | — | — | — | — | ✓ locked | greyed |
| Free-text / Other | input placeholder | — | ring | filled | — | — | — | — | shows text | greyed |
| Submit | enabled if valid | — | ring | pressed | — | — | no selection | answer in-flight (spinner) | ✓ then collapses | hidden |
| Question-set (lifecycle `s`) | pending (interactive) | — | — | — | — | — | — | — | answered (summary) | expired/cancelled/superseded (read-only banner) |

**Empty/edge states are features:** free-text with no input → submit disabled + hint; a set that `expired` → "This question expired" + (optional) re-ask affordance; `superseded` → "Replaced by a newer question" linking the new `qid`; multi-select with zero picks → disabled submit unless the question is optional.

**Multi-question render:** a single card with all `q[]` shown in order (scroll on mobile), each with its own state; ONE submit collects the full answer array. Long sets (≥N) get a compact progress affordance ("2 of 5 answered"); optional stepper on mobile.

## Responsive & a11y
| Breakpoint | Layout | Touch | Notes |
|---|---|---|---|
| 320–430 | full-bleed card; options stacked; previews expand inline/sheet; submit pinned above keyboard (reuse `body.kbd-up`) | ≥44px | previews as a bottom-sheet on tap |
| 768+ | card in column; previews side-peek; keyboard nav | ≥40px | recommended option pre-focused |
| 1024–1440 | inline; 1-9 quick-select + arrows + Enter | mouse | multi-question shown fully |

A11y: tab order = per-question (header→options→free-text)→submit; `aria-live=polite` announces the question + "answered/expired"; SR strings "Question 2 of 5, {header}, {kind}"; focus-visible `--focus-ring`; reduced-motion honored; state by shape+text not hue.

## Design system tokens used
| Use | Token | Why |
|---|---|---|
| Card/option surface | `--glass-panel`, 1px accent ring | Matches AskInline/composer chrome. |
| Recommended | accent pill + "◆" | Reuses the pill grammar; not color-only. |
| Danger option (`f:1`) | `--term-glow` red family | Consistent destructive hue. |
| Code preview | hljs theme (from #303) | Already in-app; escaped, no dangerouslySetInnerHTML. |
| Model/meta context | `--meta-*` chips | Cross-surface consistency. |

## User journey (emotional arc)
1. Question appears (rich, scannable, recommended pre-focused) → *clarity, not friction.*
2. Options carry real previews (a wireframe/code/diagram, not ASCII) → *confidence — "I can see what I'm choosing."*
3. Multi-question set shows all at once with progress → *control — "I know how much is left."*
4. Submit → answer is a tiny structured message; agent resumes → *smoothness — no lag, no drift.*
5. Later the set shows the chosen answer read-only → *trust — a legible record.*

## AI-slop check
Protocol: N/A. Renderer reuses cosmos tokens + pill grammar — no purple gradients, no icon-circle grids, no color-only state, no filled-gradient rings (carry the mask-composite + workflow-ui legibility lessons). PASS.

## Efficiency budget (benchmark for H1/H2)
Reference ask = 1 question, 4 options each with label + ~4-word description.
- Native AskUserQuestion JSON: ~180–220 B.
- pleri.ask Hybrid: ~120–140 B (short keys + `k`/`r` enums replace `question`/`header`/`multiSelect`/verbose labels-as-types). ≥30% smaller.
- Answer: native tool_result round-trip vs `{"v":1,"qid":"a1","a":[0]}` ≈ 26 B.
- A wireframe preview ≈ 80–120 B (vs an SVG mockup in the KB range).
Measured in plan-hard/execute against a fixture corpus; H1 fails if the benchmark ask ≥ native or the answer carries labels/keys.

## Unresolved design decisions
| # | Question | Load-bearing | My lean | Why it matters |
|---|---|---|---|---|
| D1 | Wire encoding | — | **Hybrid (RESOLVED at CP0)** | Drives the whole shape. |
| D2 | `qid` generation + collision | false | agent-side 4-char base36, session-scoped; on collision re-roll [assumed] | Correlation integrity. |
| D3 | Content-block answer INJECTION into the agent (claude-control sends `<pleri:answer>` as the next user turn into the tmux/agent session; SPA via its message channel) | **true** | send as a normal user message on the session's input channel — the seam that replaces keystroke-puppeteering [assumed] | The load-bearing round-trip; get it wrong and we've just moved the fragility. |
| D4 | Migrating the `/100x` skills off native AskUserQuestion → `pleri:ask` | true | phased dual-support: renderer accepts both; skills emit `pleri:ask` gradually [assumed] | Large surface; can't flip-day-one. |
| D5 | MCP `pleri_ask` (mid-turn) in v1? | false | defer; content-block covers turn-end (the 90% case) [assumed] | Scope control. |
| D6 | Preview types shipped in v1 | false | markdown + code + wireframe; diagram(mermaid) only if a renderer already exists in both surfaces [assumed] | Avoid shipping an unrenderable type. |
| D7 | Wireframe primitive set finality (the `we` enum) | false | freeze the 10 listed for v1; additive-only after [assumed] | Forward-compat of the sub-DSL. |
| D8 | Does this also replace claude-control's TUI-scrape prompts (permission/trust/numbered menus)? | false | no — those originate in the harness TUI, not our agent; separate concern [assumed] | Scope boundary. |
| D9 | How agents are reliably prompted to emit + parse `pleri:ask` (rule/skill injection) + malformed-emit fallback | true | inject a protocol rule; lenient parse + auto re-ask on malformed [assumed] | Content-block reliability hinges on prompt adherence. |

## Mockup references
Resting picker (multi-question, mobile), showing a wireframe preview expanded:
```
┌ Question 1 of 2 · Auth ─────────────────┐
│ Which auth method?                       │
│  ◆ OAuth        OAuth 2.0 flow      [rec]│  ← recommended, pre-focused
│  ○ API key      Static env key           │
│  ○ mTLS         Client certs        ⌄    │  ← tap ⌄ → preview sheet:
│     ┌ preview (wireframe) ──────────┐    │
│     │  [Which auth?]                 │    │
│     │  ( OAuth ) ( API key )         │    │
│     │  [ key… ................... ]  │    │
│     └────────────────────────────────┘   │
├ Question 2 of 2 · Scope ─────────────────┤
│ Grant scopes (multi):                    │
│  ☑ read   ☐ write   ☐ admin              │
│                          [ Submit 1/2 ▸ ]│
└──────────────────────────────────────────┘
```
Wire for that (abridged): `{"v":1,"qid":"a1","q":[{"h":"Auth","t":"Which auth method?","k":0,"r":0,"o":[{"l":"OAuth","d":"OAuth 2.0 flow"},{"l":"API key","d":"Static env key"},{"l":"mTLS","d":"Client certs","p":{"pt":2,"w":[[0,{},[[3,{"x":"Which auth?"}],[1,{},[[4,{"x":"OAuth","v":1}],[4,{"x":"API key"}]]],[5,{"x":"key…","g":1}]]]]}}]},{"h":"Scope","t":"Grant scopes (multi):","k":1,"o":[{"l":"read"},{"l":"write"},{"l":"admin"}]}]}` · answer: `{"v":1,"qid":"a1","a":[0,[0]]}`
