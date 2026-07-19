---
feature: ask-protocol
phase: b
tier: epic
milestone: M1
autonomous: false
complexity-budget:
  files: 4
  loc-delta: 550
adopted-patterns:
  - AskInline picker chrome + cosmos tokens
  - MarkdownText + hljs (#303) for previews
  - React.memo per-row
---

> **Scope**: The shared renderer — refactor `AskInline` to consume the DSL: multi-question card, per-kind rendering, markdown + code previews (scheme-filtered; mermaid optional+pinned; wireframe DEFERRED to Phase G), all interaction + lifecycle states, mobile flush.
> **Design**: docs/design/ask-protocol.md
> **Branch**: feat/ask-protocol-m1

## Status

| state | count |
|---|---|
| todo | 3 |
| done | 0 |

<!-- CP0 log
- committed 2026-07-19 on docs/ask-protocol; M1. Depends on Phase A (lib) + its round-trip gate. B6 elided: Out of scope (see README).
-->

## Audit item coverage

| Rubric | Task | Reuse-ref |
|---|---|---|
| T2 preview XSS (escaped, no dangerouslySetInnerHTML) | B1/B2 | MarkdownText hljs node-parse (#303) |
| OQ16 scheme-filtered previews | B2 | ProseLink scheme allowlist |
| OQ15 mermaid pinned/optional | B2 | securityLevel:'strict' |
| P3 per-row memo | B1 | React.memo |

## Task list

### B1 — AskInline → DSL renderer (multi-question, states)
> **Goal**: Refactor `AskInline.tsx` to render from the DSL (via A1 + A2 adapter): multi-question card, single/multi/free-text/confirm kinds, recommended affordance, all interaction + lifecycle states, mobile flush; per-row React.memo.
> **Files**: web/src/components/AskInline.tsx, web/src/styles.css
> **Acceptance**: renders the design's multi-question reference set; native AskUserQuestion (via A2 adapter) renders identically to today; state by shape+text (greyscale-safe); one option's change re-renders one row.
> **Verification**: `npm --prefix web run test -- AskInline` && `npm --prefix web run build`
> **Depends on**: A1, A2
> **Reversibility**: load-bearing
> **Regression surfaces**: existing AskInline native rendering
> **Integration-test**: n/a

### B2 — preview renderer (markdown + code; scheme-filtered)
> **Goal**: Preview DSL renderer for markdown + code (reuse MarkdownText + hljs), with a RESTRICTED subset (no embeds; http/https-only hrefs — scheme-filter ProseLink); mermaid only if available + pinned (`securityLevel:'strict'`, htmlLabels:false, interactions off). Wireframe NOT in M1.
> **Files**: web/src/components/AskInline.tsx (preview sub-renderer), web/src/components/MarkdownText.tsx (scheme filter)
> **Acceptance**: markdown + code previews render escaped (no dangerouslySetInnerHTML); a `javascript:`/`data:` href in a preview is neutralized; an unknown preview type degrades to a safe text fallback.
> **Verification**: `npm --prefix web run test -- preview`
> **Depends on**: B1
> **Reversibility**: clean-revert
> **Regression surfaces**: MarkdownText (shared with main transcript — ensure the scheme filter doesn't break existing links)
> **Integration-test**: n/a

### B3 — render tests
> **Goal**: Vitest covering multi-question render, all states, escaped previews, unknown-preview-type fallback, native-adapter parity.
> **Files**: web/src/components/AskInline.vitest.ts (extend)
> **Acceptance**: green; includes an XSS-attempt preview fixture (asserts neutralized).
> **Verification**: `npm --prefix web run test -- AskInline`
> **Depends on**: B1, B2
> **Reversibility**: clean-revert
> **Regression surfaces**: none
> **Integration-test**: n/a

## Dependencies between tasks
- B1 depends on A1+A2; B2 depends on B1; B3 depends on B1+B2. Phase B gated on A3 (round-trip gate) passing.

## Cross-phase regression checks
- Native AskInline rendering unchanged (A2 adapter parity) — existing native tests green.
- MarkdownText scheme filter must not regress main-transcript links (#303 tests green).

## Rollback rehearsal
- Revert the AskInline refactor to the native-only body; the DSL renderer is additive.

## Review sign-off checklist
- [ ] Previews escaped; XSS fixture neutralized (T2).
- [ ] Scheme filter applied; main-transcript links unregressed.
- [ ] Native-adapter parity confirmed.
- [ ] Wireframe correctly NOT present (Phase G).
