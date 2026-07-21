# Design — claude-control-prototype-studio

> Scaffolded by /100x:commit-plan from the plan's Risk candidates. TODO: prose as phases land.

## Threat model
| # | Threat | Mitigation | Status |
|---|---|---|---|
| T1 | Grown postMessage surface (props-set/capture/outline) | source-identity + strict shape per message family (appBeacon pattern); size caps; no eval; bridge never touches parent DOM | [known] |
| T2 | Captures endpoint = new authed write path | NAME_RE, size cap (8MB), atomic temp+rename, media-root-only, constant-time bearer | [known] |
| T3 | docgen on complex TS types (unions/generics/ReactNode) | un-inferable props degrade to rawType + JSON input; manifest optional; build never blocks on docgen failure | [assumed] |
| T4 | Hotkey suppression fail-safe | capture-phase interceptor; scoped to studio-open; suppression released EAGERLY at close-request (not animation-gated — CP3-A HIGH) with unmount cleanup as backstop; Escape carve-out; Cmd+C/V/X pass (Cmd+A currently suppressed — revisit if studio content needs select-all) | [known] |

## Performance findings
| # | Concern | Target | Measured |
|---|---|---|---|
| P1 | Oversized device preset on small screens | dynamic gating (mode hidden when screen < preset) | by construction |
| P2 | In-sandbox capture on large components | async + progress + 10s timeout → error chip | Phase D: implemented as designed; +13.5KB raw / +5.0KB gzip bundle growth (well under the 80KB budget); live-probe round-trip (capture → annotate → save → fetch) confirmed in a real browser |

## Simplicity findings
| # | Temptation | What we do instead |
|---|---|---|
| S1 | Generic devtools/remote-inspector protocol | read-only DOM outline + reserved console slot |
| S2 | Manifest DSL with control/layout config | types in → typed inputs out; raw JSON escape hatch |

## Principles & Seams
Seam: programmable artifacts — producer-baked bridge (manifest + validated postMessage) is the single contract between claude-control tooling and sandboxed component code. Studio hosting = third arbitration tier (studio > panel > transcript); enter/exit is a placeholder move (never-reload).

## Unwind cost
Bridge contract wrong → freeze protocol v1-deprecated; studio A/B chrome survives; C/D/E degrade to "no manifest" paths (~6-8 files).

## Artifact contract

> E3. Everything a third party needs to build a conforming artifact: the manifest file, the full bidirectional postMessage protocol, validation rules, and how each surface degrades when a producer build is absent, stale, or misbehaving. Producer-side helpers live in `web/src/lib/ccBridgeRuntime.tsx` (bundled INTO the artifact) and its outside-git twin `~/.claude/skills/prototype-component/scripts/cc-bridge-template.tsx`; claude-control-side counterparts live in `web/src/lib/appBridge.ts` and `web/src/lib/appBeacon.ts`.

### Manifest schema v1

One `<name>.manifest.json` alongside the built `<name>.html` under the media root's `apps/` directory (`~/.claude-control/media/apps/<name>.manifest.json` on a real deploy). Optional — Studio never blocks on its absence (S2/T3 below).

```json
{
  "schema-version": 1,
  "component": "Counter",
  "props": [
    {
      "name": "label",
      "tsType": "string",
      "required": false,
      "default": "react counter — own root, own boundary",
      "example": "react counter — own root, own boundary"
    },
    { "name": "initialCount", "tsType": "number", "required": false, "default": "0", "example": "0" }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `schema-version` | number | Must be `1`. Studio ignores/degrades a manifest with any other value the same as a missing one. |
| `component` | string | Display name only — never used to resolve a script path or eval anything. |
| `props[].name` | string | Must match a key the artifact's `withCcBridge(RootComponent, exampleProps)` call actually accepts; unmatched names are harmless (merged onto `overrides`, ignored by `RootComponent` if it doesn't read that prop). |
| `props[].tsType` | `"string" \| "number" \| "boolean"` | Anything else (union, generic, `ReactNode`, …) degrades to the raw-JSON escape hatch (T3/S2) — Studio still renders the prop row, just as a raw-JSON textarea instead of a typed input. |
| `props[].required` | boolean | Cosmetic only in v1 — Studio does not block sending a `cc-props-set` that omits a required prop; the artifact keeps its own `exampleProps` default for any key never overridden. |
| `props[].default` / `props[].example` | string (stringified) | `example` seeds the typed input's placeholder; `default` is documentation only — the artifact's own `exampleProps` argument to `withCcBridge` is the actual runtime default, not this file. |

**No manifest present**: Studio's Props tab renders every prop as a raw-JSON textarea with no type hints, keyed off whatever `cc-bridge-ready` and prior `cc-props-set` traffic imply exists — S2's "raw JSON escape hatch" is not just for un-inferable types, it's the entire fallback when there's no manifest at all.

### Bridge protocol — message catalog

Every message is a `window.postMessage(payload, '*')` call across the `srcdoc` sandbox boundary (`sandbox="allow-scripts"`, no `allow-same-origin`). `event.origin` is always the literal string `'null'` on both sides and is **never consulted** — see Validation rules below.

| Type | Direction | Payload (beyond `type`) | Correlation | Sent when |
|---|---|---|---|---|
| `cc-bridge-ready` | artifact → claude-control | `{ manifestVersion: number }` | none | Once, on `CcBridgeRoot` mount (`useEffect`, empty deps) — fires again after every full iframe reload (crash-recovery), never on a `cc-props-set`/`cc-props-reset` round-trip (those reconcile in place, no remount of `CcBridgeRoot` itself). |
| `cc-props-set` | claude-control → artifact | `{ props: Record<string, unknown> }` | none | Studio's Props panel, debounced (`PROPS_DEBOUNCE_MS`) per edited field. Merges onto existing `overrides` state — `RootComponent` reconciles in place, its own internal state survives. |
| `cc-props-reset` | claude-control → artifact | *(bare — only `type`)* | none | Studio's Reset action. Clears `overrides` **and** bumps the wrapper's `key`, forcing a full remount of `RootComponent` — internal state is discarded too, not just prop overrides. |
| `cc-capture-request` | claude-control → artifact | `{ requestId: string }` | `requestId`, claude-control-minted | Screenshot button click. `requestId` is required (unlike props-set/reset) because capture is a one-shot request/response racing a client-side timeout — see below. |
| `cc-capture-result` | artifact → claude-control | success: `{ requestId, ok: true, dataUrl: string }` · failure: `{ requestId, ok: false, error: string }` | echoes the request's `requestId` | After `html-to-image`'s `toPng(document.body, { skipFonts: true })` resolves or rejects. `ok` is a discriminant — a payload with `ok: true` but an `error` key (or vice versa) is rejected outright, not coerced. |
| `cc-dom-outline-request` | claude-control → artifact | *(bare)* | none | Inspector tab's auto-request-on-activate, or its Refresh button. |
| `cc-dom-outline-result` | artifact → claude-control | `{ tree: CcDomOutlineNode \| null, truncated: boolean }` | none — no `requestId` | A stale-but-valid outline is not a correctness hazard the way a stale capture would be (nothing is persisted from it), so no correlation/timeout machinery exists here. `tree: null` is the producer's own walk having thrown (e.g. a hostile/buggy `id`/`className` getter) — a valid degrade case, not a shape-check rejection. |
| `cc-app-error` | artifact → claude-control | `{ message?: string }` | none | Any uncaught render error inside an artifact's own error boundary (e.g. `CounterBoundary`'s `componentDidCatch`). Handled by `AppFrameLayer.tsx`, not Studio-specific — the same beacon a normal (non-studio) embed uses. |
| `cc-console-entry` | *(reserved — E2)* | *(unspecified)* | — | **Type constant exported, no producer emits it, no claude-control handler exists.** The Console tab renders disabled ("coming soon"). Do not emit this message from a producer build expecting it to do anything yet. |

`CcDomOutlineNode` (recursive): `{ tag: string; id: string \| null; className: string \| null; textPreview: string \| null; childCount: number; children: CcDomOutlineNode[] }`. `textPreview` is **direct** text-node children only (not `el.textContent`, which would recursively duplicate every descendant's text into every ancestor's preview), trimmed, hard-capped at 40 chars. `childCount` is the real live-DOM child-element count even when `children` was truncated by the depth/node budget — the truncation notice can say "12 children (showing 8)" honestly.

### Validation rules

- **Source identity, never origin.** `event.origin` is the opaque `'null'` on both sides of a `sandbox="allow-scripts"` srcdoc boundary and carries zero information — every validator (`isTrustedCcBridgeSource` / `isTrustedCcBridgeParent` / `isTrustedAppBeaconSource`) checks `event.source` by **reference equality** against the specific tracked window (the iframe's `contentWindow` on the claude-control side, `window.parent` on the artifact side) instead.
- **Exact-shape checks, not duck-typing.** Every inbound message is validated by a dedicated `isCc*Shape` function that enumerates the full allowed key set and rejects anything with extra or missing keys — an accidental shape drift on the emitting side fails loud (message silently dropped) rather than being coerced into a partially-valid read.
- **Outbound sends are unvalidated.** `sendCcCaptureRequest` / `sendCcDomOutlineRequest` / `sendCcPropsSet` / `sendCcPropsReset` (claude-control → artifact) and `captureCcBridgeSnapshot` / `postCcDomOutlineResult` (artifact → claude-control, once triggered by an already-validated inbound request) apply no shape checks of their own — the sender in each direction is the trusted party; only the *receiver* validates.
- **DOM outline: budget re-enforced on both sides, not just trusted once.** `CC_DOM_OUTLINE_MAX_DEPTH=12` / `CC_DOM_OUTLINE_MAX_NODES=2000` are enforced by the producer's own `serializeCcDomOutline` walk AND independently re-walked by claude-control's `isCcDomOutlineResultShape` before acceptance — defense against a buggy or compromised producer build claiming a smaller tree than it actually sent, not just a source-identity check. A tree that is honestly within budget is never rejected by the re-walk (same numbers on both sides); an oversize tree is rejected outright (not silently re-truncated) so a producer-side bug is caught, not masked.
- **Capture result size ceiling, checked outside the shape function.** `MAX_CC_CAPTURE_DATA_URL_LENGTH = 15 * 1024 * 1024` (chars of base64 text — a decoded-8MB PNG base64-encodes to ~10.9MB, this leaves headroom) is checked by `StudioModal.tsx`'s `onMessage` handler directly, deliberately **not** folded into `isCcCaptureResultShape` itself: folding it in would make an oversize result fail shape validation and get silently dropped by the caller's early-out — the existing capture-failed error chip must fire instead, so the size check runs after the shape check passes, as a separate explicit branch.
- **Server-side capture write re-validates independently.** `lib/media-captures.js`'s `MAX_CAPTURE_BYTES = 8 * 1024 * 1024` is the DECODED-bytes ceiling enforced again server-side (`isOversizeCapture`) when a capture is saved — the client-side base64-text ceiling above is a UI-responsiveness guard, not a substitute for the server's own authority over what gets written to disk. Save target: `mediaRoot/captures/<name>/<isoStamp>.png`, `<name>` validated against `NAME_RE = /^[a-z0-9-]+$/` (`isValidAppName`), written atomically (temp file + rename, same-directory so POSIX rename is atomic) — a concurrent read or a crash mid-write can never observe a truncated PNG.

### Degrade rules

| Condition | Degrade behavior |
|---|---|
| No manifest file, or `schema-version` ≠ 1 | Every prop renders as an untyped raw-JSON textarea (S2) instead of a typed input; Studio never blocks opening the artifact. |
| Prop's `tsType` isn't `string`/`number`/`boolean` (union, generic, `ReactNode`, …) | That single prop's row degrades to raw-JSON input; other, simply-typed props on the same manifest keep their typed inputs (T3 — degrade is per-prop, not whole-manifest). |
| DOM outline exceeds depth 12 or 2000 nodes | `truncated: true` on the result; `StudioInspector` shows a truncated-notice banner. Rejected outright (not silently shortened further) if the producer's own claimed tree still exceeds the SAME budget on claude-control-side re-validation — see Validation rules. |
| Producer's own outline walk throws (hostile/buggy DOM getter) | `postCcDomOutlineResult` catches and posts `{ tree: null, truncated: false }` — a valid, non-error degrade case; Inspector shows an empty tree, Refresh remains available. |
| Capture (`toPng`) rejects (e.g. tainted cross-origin image in the artifact) | `cc-capture-result` with `ok: false, error: <message>` — Studio's error chip surfaces the message; Screenshot button re-enables for retry. |
| No `cc-capture-result` arrives within 10s (`CAPTURE_TIMEOUT_MS`) | Studio's own client-side timeout fires — `{ kind: 'error', message: 'capture timed out' }` — independent of whether the artifact ever attempts a response (covers a stale/pre-D1 producer build with no capture handler at all, or a bridge listener that never mounted). |
| Capture result's `dataUrl` exceeds 15MB of base64 text | Treated as a capture failure (error chip), checked after shape validation passes — see Validation rules. |
| Capture save exceeds 8MB decoded on the server | Server rejects the write; the save step surfaces as a failure the same as a capture-generation failure (both funnel through the same save-error path in `StudioCapture`). |
| Artifact throws during render (crash) | `cc-app-error` beacon → `AppFrameLayer.tsx` marks the slot crashed, shows `.embed-app-crashed`. **Studio Phase E CP3, FIX 1**: the crashed strip now renders a Reload button for a studio host too (dispatches the same `cockpit:app-reload` window `CustomEvent` the transcript/panel reload button uses, remounting the shared url-keyed iframe fresh — `crashed:false`) — the `isStudioHost` gate in `AppFrameLayer.tsx` only still suppresses Pin/Fullscreen in Studio (both remain redundant/self-referential in-studio regardless of crash state); the healthy and failed branches are unchanged from Studio Phase B CP3 (no corner chrome at all). Closing the studio (✕) and reopening also recovers a crashed slot — the eviction GC drops the stale slot after `GRACE_MS` (250ms) once its placeholder is gone, so a reopen past that window remounts fresh; a reopen WITHIN ~250ms instead reuses the still-tracked, still-crashed slot (the placeholder never disappeared long enough to evict), so the in-studio Reload button above is the reliable recovery path, not a fallback of last resort. |
| Full iframe reload (crash recovery, or any other cause of a fresh `<iframe>` mount) | **All previously-applied `cc-props-set` overrides are discarded** — the artifact remounts via a genuinely new DOM `<iframe>` element, re-executing its bundle from scratch with only its own `exampleProps` defaults. Studio's Props panel inputs retain their last-typed text client-side but do **not** automatically resend a `cc-props-set` to the freshly-mounted iframe — re-applying an override after a reload currently requires re-editing the field (verified live, E3 harness run: `desktop-05-recovered.png` shows the label reverted to the manifest default while the Props panel's input still showed the pre-crash edit). |
| Host viewport narrower than a device-mode preset's own gated width | `StudioModal.tsx` gates **every** device-mode button — including the smallest preset, Mobile — via `useMinWidth(preset.width + STUDIO_BODY_CHROME_WIDTH(50))`, not just the larger ones: Mobile itself requires ≥440px, iPad ≥818px, Desktop ≥1330px (chrome-inset accounts for `.studio-body`'s padding + `.studio-frame`'s border). At a real ≤389px host viewport **all three** buttons are disabled, not just the larger presets — a naive assumption that "the smallest preset stays enabled down to its own raw width" is wrong (verified directly against source this phase, E3 CP0 log). Studio still renders and functions at any width via `.studio-body`'s `overflow: auto` scrollbar fallback; the mode-init `useState` initializer falls through to `'mobile'` as a last resort even when Mobile itself is currently disabled — never a dead/blank state. |
| `cc-console-entry` emitted by a producer build | No-op — no claude-control handler is wired to this reserved type yet (E2). The disabled Console tab is the only UI surface; nothing consumes the message today. |
