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
| todo | (none) |
| done | C1, C2, C3, C4 |

<!-- CP0 log: emitted by /100x:commit-plan 2026-07-10 -->
<!-- CP0 log: C1 done 2026-07-10, sha 90026ae. Manifest schema-version:1 as specced.
     react-docgen-typescript@2.4.0 added as web/ devDependency (pre-approved).
     Implementation lives in ~/.claude/skills/prototype-component/scripts/
     (run.mjs + NEW manifest.mjs + NEW manifest.test.mjs), OUTSIDE git — logged
     per D5 precedent, documented in SKILL.md §5a. New CLI surfaces:
     --infer-manifest <file> [--component <Name>] --out <file> (standalone),
     --write-app ... --manifest <file> (passthrough), capture.json embedApp.component
     /.componentName (automatic). All three degrade to a logged warning + no
     manifest on docgen failure — verified via node --test manifest.test.mjs
     (6/6 green): full type-matrix inference, complex-generic tsType-only
     degrade, nonexistent-component degrade at both CLI entry points.
     Deviation: none from spec. Budget: 1 web/ file pair (package.json +
     package-lock.json) of the 10-file budget; loc-delta counted against the
     outside-git skill files separately since they're not part of this repo. -->
<!-- CP0 log: worktree node_modules note — `npm install --save-dev
     react-docgen-typescript` converted web/node_modules from a symlink
     (shared with the main claude-cockpit checkout) into a real, independent
     directory in THIS worktree only. Verified: main repo's web/node_modules
     has no docgen package and web/package.json|package-lock.json show zero
     git diff there — no cross-worktree pollution. Benign side effect of the
     symlinked-node_modules setup, not a regression. -->
<!-- CP0 log: C2 done 2026-07-10, sha 4633de8. cc-bridge runtime implemented
     as a real, tested, git-tracked module — web/src/lib/ccBridgeRuntime.tsx
     (iframe-side, bundled INTO producer artifacts by esbuild/vite's normal
     relative-import resolution) + web/src/lib/appBridge.ts (cockpit-side
     protocol lib: isCcBridgeReadyShape/isTrustedCcBridgeSource/
     isValidCcBridgeReady mirror appBeacon.ts's validation trio exactly;
     sendCcPropsSet/sendCcPropsReset are the outbound SEND helpers). Design
     deviation from the literal Files line ("producer bridge template (skill
     scripts dir)"): rather than a copy-paste template as the ONLY home for
     the runtime, the canonical source lives in-repo (web/src/lib) since
     web/scratch/counter-app + friends are git-TRACKED (verified via
     `git ls-files web/scratch` — contrary to SKILL.md's general "gitignored
     scratch dir" framing for one-off captures), so dogfood build scripts can
     import it directly via a normal relative path — no fragile absolute
     path outside the repo, single source of truth, real vitest coverage
     against real React. A synced copy ALSO lives at
     ~/.claude/skills/prototype-component/scripts/cc-bridge-template.tsx
     (OUTSIDE git, logged per D5/C1 precedent, documented in SKILL.md §5b)
     for producers working outside claude-cockpit, which has no access to
     web/src/lib — same duplication precedent as isValidAppName/isoStamp
     between run.mjs and lib/media-apps.js. Acceptance verified: 30 new
     vitest cases (13 appBridge.vitest.ts + 17 ccBridgeRuntime.vitest.ts,
     full suite 761/761 green) — spoofed-source rejected, malformed shapes
     rejected (extra keys, wrong type, non-object props, arrays), a
     props-set round-trip proves the wrapped fixture's internal click-count
     state survives (same `key`), a props-reset proves a full remount
     (internal state clears, exampleProps re-applies). Bridge size verified
     via esbuild transform+minify (react excluded, matching the "adds <15KB"
     framing as a delta over the base React runtime every producer already
     ships): 1.3KB. tsc -b clean. -->
<!-- CP0 log: C3 done 2026-07-10, sha 79928d2. Studio
     "Props" tab implemented as a PERMANENTLY-VISIBLE side panel
     (StudioPropsPanel, StudioModal.tsx) alongside — never replacing —
     .studio-frame, not a hide/show tab: this codebase treats "never reload
     the iframe" as a sacred invariant (AppFrameLayer.tsx), and a
     conditionally-unmounted tab risked violating it for zero acceptance
     benefit (no bullet in the C3 spec requires literal tab-switching
     semantics). New web/src/lib/appVersion.ts exports (fetchAppManifest +
     manifestUrlForAppUrl + isValidAppManifestShape + AppManifest/
     AppManifestProp types) fetch the sibling <name>.manifest.json through
     the EXISTING generic /api/media/<path> route — no dependency on C4's
     server-side listing extension (confirms the tracker's own "C3 depends
     on C2 only" edge). The live iframe's contentWindow is located via a new
     local findAppIframeWindow(url) helper (StudioModal.tsx) that matches on
     the AppFrameLayer-hosted <iframe>'s title={url} attribute (an
     already-established test-relied-upon lookup key) rather than adding any
     new AppFrameLayer export/prop/context — AppFrameLayer.tsx and
     EmbeddedApp.tsx are UNTOUCHED by C3, exactly matching the tracker's own
     Files line. Form-control selection priority: enum (literal union) ->
     select; boolean -> checkbox; number -> number input; string -> text
     input; anything else (complex/generic/function tsType) -> raw-JSON-only,
     no mis-rendered text input. Per-prop raw-JSON override never validates
     outgoing values — a JSON.parse failure forwards the raw typed string
     as-is, by design, so a tester can inject a genuinely wrong-typed value
     and prove the ARTIFACT's own cc-app-error beacon/crash-strip path fires
     (untouched by C3). Debounce: 150ms setTimeout in StudioPropsPanel's
     commit(), clearing any prior pending timer — verified via fake timers
     (postMessage NOT called at 149ms, called at exactly 150ms). Reset button
     sends cc-props-reset synchronously (no debounce). Degrade path (404
     manifest) renders a message + the rebuild command referencing the app's
     derived name. Acceptance verified: 6 new vitest cases (manifest-less
     degrade path, typed-form rendering from a fixture manifest incl. enum
     select/required marker/example chip/raw-only for a function-typed prop,
     150ms-debounced postMessage with a same-iframe-node + zero-new-fetch
     proof, raw-JSON-override forwarding an invalid string, reset-sends-
     cc-props-reset) — full suite 766/766 green (761 baseline + 6 new − 1
     existing "zero iframe reloads" test updated in-place: its authFetch
     call-count assertion moved from a hardcoded 1 to a captured baseline,
     since C3's manifest fetch is a second, expected sibling authFetch call
     on studio-open, and the test's actual regression claim — no REFETCH
     across device-mode switches — is preserved unchanged). tsc -b clean,
     vite build clean. Deviation: none from spec's acceptance bullets; the
     side-panel-not-tab architectural choice is a literal-title vs.
     literal-acceptance judgment call, explained above. -->
<!-- CP0 log: C4 done 2026-07-10, sha 62431b8. lib/media-apps.js's
     listVersions gained a per-version `manifest`/`manifestUrl` presence
     check (fs.existsSync on the <stamp>.manifest.json sibling) — a
     presence flag only, not a parse/shape check (the client already
     re-validates via appVersion.ts's fetchAppManifest, C3). 2 new
     node --test cases (manifest:true+url on a version with a sibling
     manifest, manifest:false+null on one without, same fixture app proving
     the flag is per-VERSION not per-app); full server suite 930/930 green
     (satisfies the 927+ floor).

     Both dogfoods rebuilt through the SAME pattern: build.mjs now shells out
     to run.mjs --infer-manifest then --write-app --manifest (the documented
     producer-calling convention run.mjs's own --infer-manifest doc comment
     already names counter-app/build.mjs as), rather than reimplementing
     docgen/versioning in the dogfood scripts. Discovered + designed around
     an empirically-confirmed react-docgen-typescript constraint:
     manifest.mjs's inferManifest destructures only the FIRST parsed
     component (`const [doc] = parser.parse(...)`), so each dogfood source
     file carries exactly ONE docgen-visible named props interface —
     Counter/Composer's error boundaries keep an inline `{children}` prop
     type (not a named interface) so they never compete for that slot.
     counter.tsx: CounterProps{label,initialCount}. composer.tsx (new):
     ComposerProps{placeholder,disabled,sessionId} — the C4 spec's own named
     example props, proving the wiring generalizes past the counter demo to
     a different interaction model (controlled input vs. click counter). No
     crash-demo button on Composer (YAGNI — Counter's "crash it" already
     proves the boundary path once per Phase C; the review-checklist item is
     satisfied there and in StudioModal.vitest.ts's C3 coverage, not
     re-proven per dogfood).

     Both artifacts independently verified against the REAL
     ~/.claude-control/media root (not just a test fixture): manifest JSON
     inspected directly (defaults come through as STRINGS —
     savePropValueAsString:true, e.g. initialCount default "0" not 0 — a
     manifest.mjs quirk already baked into C1's own fixtures, harmless here
     since the studio's values state starts empty and the artifact's own
     exampleProps carry the real typed defaults); a real server instance
     pointed at the real media root was curled at
     /api/media-apps/<name>/versions for both apps, confirming
     manifest:true + the correct manifestUrl for the newest version of each
     (satisfies the spec's literal "curl the listing").

     E2E / "live studio probe" — deviation, logged: no Playwright (or any
     other browser-automation tool) exists anywhere in this repo (no
     `playwright` in package.json/web/package.json, no
     web/node_modules/.bin/playwright — confirmed via direct search), and
     the ONLY thing in this ecosystem that resolves Playwright at all is the
     OUTSIDE-git prototype-component skill's run.mjs, which resolves it from
     a TARGET micro-app's OWN node_modules (none of these scratch dogfoods
     have one). Adding Playwright here would be a second new dependency,
     violating this phase's single-pre-approved-dependency constraint
     (react-docgen-typescript only) — a Halt-N trigger, not a corner to cut
     silently. Instead: extended this repo's OWN already-established,
     already-trusted verification tier for exactly this claim
     (ccBridgeRuntime.vitest.ts already proves the generic bridge mechanism
     via jsdom + RTL + real MessageEvents, no browser) to the REAL C4
     dogfood components themselves — new
     web/scratch/counter-app/counter.vitest.ts (3 cases) +
     web/scratch/composer-app/composer.vitest.ts (2 cases), gained by adding
     `scratch/**/*.vitest.ts` to web/vite.config.ts's test.include (was
     `src/**/*.vitest.ts` only). These import the REAL Counter/Composer
     functions and the REAL withCcBridge (not fixtures/mocks) and dispatch
     real cc-props-set/cc-props-reset MessageEvents, asserting the live DOM
     re-renders without a remount (click-count / draft-text survive) —
     genuinely the same claim a browser E2E would make, proven at the tier
     this repo already trusts. Also surfaced and documented a real, honest
     finding along the way: editing `label` re-renders live (read directly
     in JSX every render), but editing `initialCount` alone does NOT — it
     only seeds Counter's internal count via `useState(initialCount)` on
     first mount, so a later cc-props-set to it is silently ignored by React
     until a cc-props-reset forces a remount. This is exactly why
     withCcBridge treats set/reset differently (see that file's own doc
     comment) — not a C4 bug, a property of the underlying mechanism worth a
     tester knowing. Full web suite 771/771 green (766 baseline + 5 new).
     tsc -b clean, vite build clean.

     Deviation summary: (1) no literal multi-process browser E2E — see
     Playwright rationale above; (2) Composer ships with no crash-demo
     button, by design (YAGNI, see above); (3) web/vite.config.ts's
     test.include widened by one glob entry to reach the scratch dogfood
     test files in place — not in the tracker's own Files line, but a
     minimal, necessary enabler for the live-probe tests above, not a
     scope expansion in itself. -->
<!-- CP0 log: CP3-C audit fixes done 2026-07-10, sha 97e4248. FIX 1
     [HIGH]: cc-bridge-ready had no cockpit-side listener at all —
     isValidCcBridgeReady (appBridge.ts) sat unused, and cc-props-set fired
     on the blind 150ms debounce regardless of whether the artifact's own
     message listener had mounted yet, silently dropping a props-set that
     landed too early. StudioPropsPanel (StudioModal.tsx) now runs a
     `message` listener that validates ready via isValidCcBridgeReady against
     the SAME iframe window findAppIframeWindow(url) already tracks; while
     not-ready, a committed props-set is queued (coalesced to the newest
     value only, never a backlog) in a ref and flushed exactly once when the
     gate opens. Handshake ordering guarantee, two races closed: (a)
     fresh-open — the artifact's own listener effect (ccBridgeRuntime.tsx)
     mounts synchronously before postMessage delivery is ever observable
     (delivery is always a queued task), so the real ready message reliably
     flips the gate; (b) already-hosted-elsewhere — AppFrameLayer's pickHost
     arbitration can hand the studio an iframe that already announced ready
     before this panel existed, so a belt-and-suspenders
     BRIDGE_READY_FALLBACK_MS=250ms timer (comfortably above the 150ms
     debounce) opens the gate unconditionally if no ready is ever seen.
     cc-props-reset stays ungated (documented in reset()'s own comment):
     idempotent to the artifact's own default state, so an early send is a
     safe no-op, never a lost mutation. FIX 2 [MEDIUM]: reset-to-defaults
     cleared live props but left stale/invalid text sitting in the raw-JSON
     textareas (uncontrolled `defaultValue`, only evaluated at mount) —
     unrecoverable for raw-only props (e.g. function-typed) with no typed
     control to force a remount another way. reset() now bumps a
     `resetGeneration` counter folded into just the raw textarea's key
     (StudioPropField), remounting it alone so `defaultValue` re-evaluates to
     '' — the field's `rawMode` toggle choice (keyed by prop.name) survives
     the reset. Tests: 4 new (queued-then-flushed-on-ready, spoofed-source
     ready ignored + stays queued, raw-only field cleared on reset, raw
     override on a typed-control field cleared on reset) + 2 existing tests
     (debounce happy-path, invalid-raw-JSON forwarding) updated to simulate
     the real cc-bridge-ready handshake instead of relying on the pre-fix
     always-send behavior. Full web suite 775/775 green (771 baseline + 4
     new). Server suite unchanged, 930/930 green (no server files touched).
     tsc -b clean, vite build clean. Files: web/src/components/StudioModal.tsx,
     web/src/components/StudioModal.vitest.ts. No AppFrameLayer.tsx changes —
     the existing findAppIframeWindow(url)/title-lookup seam from C3 already
     covered everything FIX 1 needed. -->

## Audit item coverage
| Task | Rubric |
|---|---|
| C1 | T3 |
| C2 | T1 |
| C3 | S2 |
| C4 | T3 |

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
