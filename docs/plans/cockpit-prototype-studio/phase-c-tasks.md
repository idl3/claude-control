---
feature: cockpit-prototype-studio
phase: c
tier: feature
autonomous: true
complexity-budget: { files: 10, loc-delta: 1100 }
adopted-patterns: [cc-app-error beacon validation, prototype-component producer, react-docgen-typescript (NEW)]
umbrella-branch: feat/cockpit-prototype-studio-integration
---

# Phase C — Manifest + cc-bridge + props editor (the seam)

> **Scope**: build-time prop manifest, in-sandbox bridge runtime, studio props tab, dogfood rebuilds. Producer work spans the repo (web/) AND the global skill (~/.claude/skills/prototype-component — outside git, log loudly like pinned-artifacts D5).
> **Design**: docs/design/cockpit-prototype-studio.md
> **Branch**: feat/cockpit-prototype-studio-phase-c

## Status
| state | tasks |
|---|---|
| todo | C1, C2, C3, C4 |
| done | — |

<!-- CP0 log: emitted by /100x:commit-plan 2026-07-10 -->

## Audit item coverage
| Task | Rubric |
|---|---|
| C1 | T3 |
| C2 | T1 |
| C3 | S2 |

## Task list

### C1 — Manifest emission (docgen in the producer)
> **Goal**: the embedApp build path infers props via react-docgen-typescript and writes apps/<name>/<stamp>.manifest.json (schema v1: {schema-version:1, component, props:[{name, tsType, required, default?, enumOptions?, example?}]}); --write-app gains --manifest <file> passthrough; docgen failure degrades to NO manifest (build never blocks).
> **Files**: web/package.json (devDep), ~/.claude/skills/prototype-component/scripts/run.mjs + SKILL.md (outside git — log), web/scratch fixtures, test via a node --test or scratch verify script exercising docgen on a fixture component
> **Acceptance**: manifest emitted for a typed fixture (string/number/boolean/union-enum/optional cases all inferred); un-inferable prop appears with tsType only; a component that breaks docgen still builds HTML with a logged warning.
> **Verification**: fixture build run + cd web && npx vitest run && npx tsc -b --pretty false
> **Depends on**: none
> **Reversibility**: clean-revert

### C2 — cc-bridge runtime (producer-injected)
> **Goal**: artifacts built with a component entry embed the bridge: announces cc-bridge-ready{manifestVersion}; handles cc-props-set (merge into a state wrapper spreading onto the root — React reconciliation preserves component state; Reset = key bump), reserves cc-capture-request/cc-dom-outline-request/cc-console-entry message names; ALL inbound validated by source identity (parent) + strict shape, mirroring appBeacon.
> **Files**: producer bridge template (skill scripts dir), web/src/lib/appBridge.ts (cockpit-side protocol lib, new) + appBridge.vitest.ts
> **Acceptance**: unit: spoofed-source rejected, malformed shapes rejected, props-set round-trip re-renders fixture w/ preserved internal state, reset remounts; bridge adds <15KB pre-capture-lib.
> **Verification**: cd web && npx vitest run && npx tsc -b --pretty false
> **Depends on**: C1
> **Reversibility**: load-bearing

### C3 — Studio props tab
> **Goal**: form generated from the manifest (typed inputs, enum selects, example chips, required markers) + per-prop raw-JSON override for invalid-value testing + reset-to-defaults; manifest-less artifacts show the degrade message with the rebuild command; injection debounced ≤150ms.
> **Files**: web/src/components/StudioModal.tsx (props tab), web/src/lib/appVersion.ts or new manifest fetch helper, web/src/styles.css, StudioModal.vitest.ts
> **Acceptance**: editing a prop re-renders in-app ≤500ms without iframe reload (load-count); invalid JSON injects and the app's own error path fires (beacon → crash strip → reload recovers); degrade path renders for the old counter artifact pre-rebuild.
> **Verification**: cd web && npx vitest run && npm run build
> **Depends on**: C2
> **Reversibility**: clean-revert

### C4 — Server manifest listing + dogfood rebuilds
> **Goal**: /api/media-apps/<name>/versions rows expose manifest presence/url; counter + composer artifacts rebuilt WITH manifests + bridge (composer's props: disabled/sessionId/etc. as inferred).
> **Files**: lib/media-apps.js, test/media-apps.test.js, web/scratch/counter-app + composer-app build runs, artifact outputs (media root)
> **Acceptance**: listing shows manifest:true for new versions; studio props tab drives BOTH dogfoods live; server tests green (927+).
> **Verification**: npm test && curl the listing + a live studio probe
> **Depends on**: C1, C2
> **Reversibility**: clean-revert
> **E2E test**: live probe — edit a counter prop in the studio, see it re-render

## Dependencies between tasks
C1 → C2 → C3; C4 needs C1+C2 (parallel-safe with C3).

## Review sign-off checklist
- [ ] Invalid-value injection exercises app error path, never cockpit crash
- [ ] Manifest-less degrade path proven
- [ ] Skill-file changes logged (no git there)
- [ ] PR targets umbrella branch
