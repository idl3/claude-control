import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { authFetch } from '../lib/api';
import { isValidAppErrorBeacon } from '../lib/appBeacon';
import { resolveMediaUrl } from '../lib/mediaUrl';
import { appNameFromUrl } from '../lib/appVersion';
import { appArtifactId, useArtifactPanel } from './ArtifactContext';
import { AppReloadButton, AppPinButton } from './EmbeddedApp';
import { useIsNarrow } from '../hooks/useIsNarrow';

/** Phase C, C3: title for a freshly-pinned app artifact — last path segment
 * of its url, falling back to the full url for a bare filename or a
 * trailing-slash edge case. */
function basename(url: string): string {
  const seg = url.split('/').filter(Boolean).pop();
  return seg && seg.length > 0 ? seg : url;
}

/**
 * Hoists <embedded-app> iframes out of the transcript row DOM into one
 * always-mounted layer, portaled to document.body and positioned over each
 * app's in-flow placeholder (rendered by EmbeddedApp in EmbeddedApp.tsx).
 *
 * Why: A2's churn-survival spike (docs/plans/cockpit-pinned-artifacts/phase-a-tasks.md)
 * measured that assistant-ui remounts message row DOM on nearly every
 * transcript update regardless of message object identity — a stable-refs
 * variant showed the same iframe reload count as a fully-rebuilt-refs
 * variant (18-22 reloads over a 24-step churn run each; reference stability
 * alone gave zero protection). An <iframe> reloads whenever it is detached
 * and reattached to the DOM (spec behavior on any node move), so as long as
 * the live iframe element lives inside row DOM that churns, no amount of
 * React identity/memo work saves it. The fix: never let the iframe live
 * inside row DOM. EmbeddedApp now renders only a lightweight placeholder
 * (same reserved-box dimensions as before, zero layout shift) — cheap to
 * remount. This layer tracks one persistent <iframe> per url, keyed by url
 * so React never tears it down across this component's own re-renders, and
 * repositions it over its current placeholder's live bounding rect.
 *
 * ponytail: DOM-attribute scan + rAF poll (mirrors the existing
 * HotkeyHints.tsx precedent: scan a data-attribute, portal, position:fixed)
 * rather than a context/registry — a transcript realistically carries a
 * handful of concurrent embedded apps at most, and polling sidesteps any
 * race between a placeholder's mount/unmount effects and this layer's
 * registry. Swap to a MutationObserver if profiling ever shows this
 * mattering. A brief placeholder absence (a same-tick churn remount) is
 * bridged by GRACE_MS; a placeholder gone past that window (session switch)
 * drops its iframe and re-fetches if it ever comes back.
 *
 * A3 audit follow-ups (CP3-A) layered on top of the above, unchanged design:
 * FIX 1 clips each iframe to its scroll pane + gives it an explicit stacking
 * position so it can never bleed over the header/composer; FIX 2 treats a
 * hidden-ancestor placeholder (mobile back-nav's `display:none` on the whole
 * detail pane — elements stay mounted) as NOT FOUND so it evicts through the
 * same grace path as a truly-removed one instead of leaking forever; FIX 3
 * gates the rAF loop itself so it only runs while there's a slot or a
 * placeholder to track, per the HotkeyHints precedent this file already
 * cites above. See the doc comments on the helpers below for each.
 *
 * B2 (reload + crash beacon) layers on top of the above, also unchanged
 * design: `reload(url)` is the only path that ever clears `slot.html` /
 * bumps `slot.iframeKey` outside of the initial fetch — it fires exclusively
 * from an explicit `cockpit:app-reload` window CustomEvent (dispatched by
 * AppReloadButton, EmbeddedApp.tsx), never from tick()'s positioning/polling
 * loop, so a reload is always an INTENTIONAL, user-requested reload and
 * never a side effect of the churn/repositioning this layer exists to
 * survive — the never-reload seam above is preserved. A `message` listener
 * marks a slot `crashed` when the app iframe itself posts a validated
 * `{type:'cc-app-error'}` beacon (see lib/appBeacon.ts) — `event.origin` is
 * always the literal string 'null' for an opaque-origin (sandbox, no
 * allow-same-origin) srcdoc iframe, so `event.source === slot.win` (the
 * iframe's own contentWindow, captured via ref) is the only usable trust
 * discriminator. The beacon is entirely optional: manual reload via
 * AppReloadButton works identically whether or not an app ever posts one.
 *
 * B audit follow-ups (CP3-B) layer on top of B2, also unchanged design:
 * FIX 1 (clampChromeInsets) fixes the corner reload button and the crashed
 * strip's CTA rendering out of reach when FIX 1's clip (above) is partial —
 * both used to position against the un-clipped placeholder box, so a
 * partial clip could land them in the invisible, non-hit-testable region;
 * FIX 2 stores the validated crash beacon's own `message` on the slot and
 * renders it as plain text content (never markup) in the crashed strip, so
 * an app's actual crash reason is visible instead of just its url.
 *
 * Phase C, C2 (always-mounted panel bodies + multi-placeholder arbitration)
 * layers on top of B/B2, also unchanged design elsewhere: a url can now have
 * MORE THAN ONE placeholder in the DOM at once — one in the transcript
 * (EmbeddedApp, context='transcript') and one in the panel's always-mounted
 * app stack (ArtifactPanel, context='panel', rendered for every open app
 * artifact regardless of which tab is active). Still exactly one live iframe
 * per url (SLOT_SELECTOR/Slot are unchanged), so tick() now groups found
 * placeholders by url and picks a single deterministic HOST per url each
 * frame: panel-context always wins over transcript, else first in document
 * order (readSlotEls/querySelectorAll already yields document order) — see
 * pickHost. The host's own rect/context/explicit-hidden attribute drive the
 * slot exactly as before (this is a strict generalization: the pre-Phase-C
 * single-placeholder-per-url case has exactly one candidate, so pickHost
 * always returns it unchanged). Non-host ("shadow") placeholders for the
 * same url don't get their own iframe — instead their live rects are tracked
 * separately (shadowsRef) and rendered as a quiet "open in panel ↗" chip
 * (see the render function below) so the transcript position isn't left as a
 * silent empty box once the app is pinned into the panel.
 *
 * The panel's inactive-tab placeholders declare themselves hidden via
 * `data-embed-app-hidden="true"` (EmbeddedApp's `hidden` prop) rather than
 * `display:none`, specifically so their rect stays non-zero and FIX 2's
 * zero-rect eviction never fires on a tab switch — tick() folds this
 * explicit flag into the same `paneHidden` (hide via visibility, never
 * evict) treatment FIX 1 already uses for a scrolled-out-of-pane
 * placeholder, so switching panel tabs (or scrolling the transcript
 * placeholder out of view) never reloads the iframe either way.
 *
 * Scroll-lag fix layers on top of everything above, also unchanged design
 * elsewhere: two problems with the pre-existing positioning, both about
 * WHEN and HOW the hoist span moves, not WHETHER it should (computePaneClip/
 * pickHost/tick()'s discovery-eviction-GC loop are all untouched).
 *  - Timing: tick() is an rAF loop — it only re-measures+repositions once
 *    per animation frame, but the browser can paint a native (trackpad/
 *    wheel/momentum) scroll before that next frame runs, so the hoisted
 *    iframe visibly trailed the transcript content underneath it by up to a
 *    frame on every scroll frame. Fixed by adding a SYNCHRONOUS fast path
 *    (syncPositions, this file's useEffect) driven by passive, capture-phase
 *    `scroll`/`resize` listeners on `window` — capture phase because scroll
 *    events don't bubble but DO propagate during capture, so one listener
 *    catches every nested scroll container (`.thread-viewport`, a panel
 *    body, any future nested pane) without enumerating them. tick() keeps
 *    doing discovery/arbitration/eviction/GC exactly as before, refreshing
 *    each slot's `hostEl` every frame so syncPositions always has a current
 *    element to re-measure without its own DOM query.
 *  - Paint cost: repositioning used to write `style.top`/`style.left`
 *    directly — both layout-triggering. Both the rAF loop's render and the
 *    new sync path now write only `transform: translate3d(x, y, 0)`
 *    (compositor-only) against a hoist span whose own top/left are fixed at
 *    0 from mount. See hoistTransform's doc comment for why this is pixel-
 *    identical to the old top/left positioning, and therefore why
 *    computePaneClip's clip-inset math needs no coordinate changes of its
 *    own.
 * Neither change touches the never-reload seam this file exists for: the
 * <iframe> element itself is still never reparented/remounted by either
 * path — only the wrapping hoist span's own inline style changes.
 *
 * Generic elevation hook (fullscreen-panel follow-up) also layers on top,
 * unchanged design elsewhere: PANEL_SHEET_HOIST_Z_INDEX's mobile-sheet
 * special case (`context === 'panel' && narrow`) is now
 * `context === 'panel' && (narrow || elevate)` — see
 * PANEL_SHEET_HOIST_Z_INDEX/shouldElevateHoist's doc comments — so any
 * future panel placeholder can ask for the same chrome-piercing z-index via
 * `data-embed-app-elevate="true"` without adding another bespoke breakpoint
 * check here. EmbeddedApp.tsx doesn't emit the attribute yet; this is
 * forward-compatible plumbing only.
 */

const GRACE_MS = 250;
const SLOT_SELECTOR = '[data-embed-app-url]';
// Fade-during-scroll (operator follow-up to the scroll-lag fix below): a
// scroll "settles" once this many ms pass with no further scroll event —
// mirrors this file's existing GRACE_MS pattern (a debounce window, not a
// throttle). Kept in sync with styles.css's `.embed-app-hoist` opacity
// transition comment if this value ever changes.
const SCROLL_SETTLE_MS = 150;
// Require this many scroll events in a row, each within SCROLL_SETTLE_MS of
// the last, before engaging the fade. A single wheel notch or a 1-2-event
// nudge produces 1-2 events total (then goes quiet) — not worth a visible
// opacity flash for a scroll that's basically already over. Sustained scroll
// motion (trackpad flick, held-down wheel) fires many events in rapid
// succession well before it ends, so real scroll gestures cross this
// threshold almost immediately. Chosen empirically: low enough to engage
// well before a fast flick's midpoint, high enough that idle-scroll noise
// (a stray 1-2px wheel tick) never triggers it.
const SCROLL_FADE_MIN_STREAK = 3;
// Matches styles.css's `.embed-app-hoist { transition: opacity ... }` —
// duplicated as a named constant here (not read by CSS) purely so this
// file's own doc comments/tests have one canonical number to point at.
// Exported so the vitest suite can assert it stays in lockstep with the
// CSS transition duration instead of the two silently drifting apart.
export const SCROLL_FADE_DURATION_MS = 100;
// B audit follow-up (CP3-B, FIX 2): cap the beacon's app-controlled crash
// message so a misbehaving app can't blow up the crashed strip's layout.
const CRASH_MESSAGE_MAX_LEN = 200;
// Mobile-sheet fix: a panel-hosted app's hoisted iframe must paint ABOVE the
// mobile bottom sheet (styles.css `.artifact-panel[data-mode='sheet']`,
// z-index: 200). The sheet is `position: fixed` with its own z-index, so its
// own stacking context — opaque background, tab strip, and the in-flow
// placeholder span the iframe stands in for — paints as one atomic layer
// above this file's document.body-portaled hoist (default z-index: 1 from
// styles.css, chosen to stay below `.detail-head`/`.composer` at z-index: 2
// for the transcript case) regardless of either side's own transparency.
// Bug: pinning an app on mobile showed the sheet's tab bar + version picker
// but never the live iframe, even though the hoist's geometry (rect,
// visibility, clip-path) was entirely correct — confirmed via
// document.elementFromPoint() hit-testing, which returned the sheet's own
// placeholder span instead of the iframe. Desktop never hit this because
// `.artifact-panel` there is `position: static` with no z-index of its own.
// 210 clears the sheet's 200 with headroom while staying well below
// `.sa-backdrop`/`.sa-panel` (899/900) and `.lightbox` (1000), so the
// sub-agent drawer and image lightbox still cover a pinned app. Scoped to
// context === 'panel' AND narrow (same `useIsNarrow()` breakpoint
// ArtifactPanel.tsx uses to switch into sheet mode) so a transcript-hosted
// iframe keeps the default z-index: 1, and a desktop panel-hosted iframe
// doesn't jump above desktop modals (.config-overlay etc., z-index 50-100)
// that currently correctly cover it.
//
// Generalized (fullscreen-panel follow-up): the mobile-sheet case above was
// the only caller, hard-coded as `context === 'panel' && narrow`. A
// placeholder may now instead opt in directly via
// `data-embed-app-elevate="true"` (any future "put this app's iframe above
// chrome" case — e.g. a desktop fullscreen panel — without adding another
// bespoke breakpoint check here). Scoped to panel-context hosts only, same
// as before: a transcript embed must NEVER pierce chrome (it's meant to stay
// clipped inside the scroll pane, see FIX 1 above) even if some future
// placeholder mistakenly carries the attribute — see shouldElevateHoist.
const PANEL_SHEET_HOIST_Z_INDEX = 210;

/**
 * Generic elevation gate: a panel-context host either matches the existing
 * mobile-sheet breakpoint (`narrow`) or explicitly opts in via
 * `data-embed-app-elevate="true"` (`elevate`, read by readSlotEls below).
 * Transcript-context hosts never elevate, full stop — the `context ===
 * 'panel'` guard is unconditional, not folded into the `||`, so a stray
 * elevate attribute on a transcript placeholder can never bump it above the
 * header/composer chrome FIX 1 exists to keep it under.
 */
export function shouldElevateHoist(
  context: 'panel' | 'transcript',
  narrow: boolean,
  elevate: boolean,
): boolean {
  return context === 'panel' && (narrow || elevate);
}

// ── FIX 1 + FIX 3 pure helpers ──────────────────────────────────────────
// DOM-free so they're unit-testable without a real layout engine — jsdom
// implements no layout at all, so these can't be exercised by mounting
// components (see AppFrameLayer.vitest.ts, which unit-tests these directly;
// the DOM-dependent end-to-end behavior is exercised by the churn-spike
// harness instead, a real browser via the prototype-component runner).
export type RectLike = { top: number; left: number; width: number; height: number };
type ClipInsets = { top: number; right: number; bottom: number; left: number };

/**
 * FIX 1 (pane clipping): intersects an app placeholder's live bounding rect
 * against its clipping scroll pane's rect (`.thread-viewport`, or the layout
 * viewport as a fallback when no such ancestor exists) and reports how the
 * hoisted iframe standing in for it should be visually clipped so it can
 * never bleed over chrome that sits outside the scroll pane (header,
 * composer, modals).
 *  - paneHidden: true when the two rects don't overlap at all — the
 *    placeholder has scrolled fully out of its pane. The caller must hide
 *    the iframe (visibility + pointer-events) WITHOUT evicting its slot:
 *    scrolling back into view must not reload it — that's the whole seam.
 *  - clip: non-null CSS `inset()` values (px, top/right/bottom/left order,
 *    relative to the placeholder's own box) to apply when the overlap is
 *    partial; null when the placeholder sits entirely inside the ancestor
 *    (no clip needed) or is fully hidden (clip is moot — visibility covers
 *    it).
 */
export function computePaneClip(
  rect: RectLike,
  ancestor: RectLike,
): { paneHidden: boolean; clip: ClipInsets | null } {
  const rectRight = rect.left + rect.width;
  const rectBottom = rect.top + rect.height;
  const ancestorRight = ancestor.left + ancestor.width;
  const ancestorBottom = ancestor.top + ancestor.height;

  const ixLeft = Math.max(rect.left, ancestor.left);
  const ixTop = Math.max(rect.top, ancestor.top);
  const ixRight = Math.min(rectRight, ancestorRight);
  const ixBottom = Math.min(rectBottom, ancestorBottom);

  if (ixRight <= ixLeft || ixBottom <= ixTop) {
    return { paneHidden: true, clip: null };
  }

  const top = ixTop - rect.top;
  const right = rectRight - ixRight;
  const bottom = rectBottom - ixBottom;
  const left = ixLeft - rect.left;
  if (top === 0 && right === 0 && bottom === 0 && left === 0) {
    return { paneHidden: false, clip: null };
  }
  return { paneHidden: false, clip: { top, right, bottom, left } };
}

// B audit follow-up (CP3-B, FIX 1): matches .embed-app-reload-btn's CSS
// top/right (styles.css) — the base corner offset before any clip is
// accounted for.
const RELOAD_CORNER_OFFSET = 6;

type ChromeClamp = {
  cornerTop: number;
  cornerRight: number;
  cornerLeft: number;
  crashedInset: ClipInsets;
};

/**
 * FIX 1 (clamp chrome into the visible clip): computePaneClip's clip insets
 * describe how much of the placeholder's edges are clipped away by its
 * scroll pane, but the corner reload button (.embed-app-reload-btn,
 * top:6/right:6), the corner pin button (.embed-app-pin-btn, top:6/left:6 —
 * Phase C, C3), and the crashed strip's CTA (.embed-app-crashed) all
 * position against the FULL, un-clipped placeholder box in the render
 * below — with a partial clip, any of them can land entirely inside the
 * clipped-away (invisible, non-hit-testable) region. This maps a clip into
 * where each piece of chrome should actually render:
 *  - cornerTop/cornerRight/cornerLeft: the reload/pin buttons' offset from
 *    the top-right/top-left corner respectively, pushed inward by however
 *    much of the top/right/left edge is clipped away. Used for the
 *    healthy-iframe and failed-fetch corner buttons, both of which sit
 *    directly in the un-clipped hoist box.
 *  - crashedInset: the .embed-app-crashed strip's own inset, shrunk from
 *    the default 0 (full box) down to the clip — its flex-centered message
 *    then centers within the VISIBLE slice, and its own reload/pin buttons
 *    (also top:6/right:6 and top:6/left:6, but now relative to this shrunk
 *    box) land in their visible corners too, with no separate offset needed.
 * Returns the identity result (no adjustment) when there's no clip.
 */
export function clampChromeInsets(clip: ClipInsets | null): ChromeClamp {
  const c = clip ?? { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    cornerTop: RELOAD_CORNER_OFFSET + c.top,
    cornerRight: RELOAD_CORNER_OFFSET + c.right,
    cornerLeft: RELOAD_CORNER_OFFSET + c.left,
    crashedInset: c,
  };
}

// ── Scroll-lag fix pure helpers ─────────────────────────────────────────
// Same DOM-free rationale as computePaneClip/clampChromeInsets above. The
// hoist span used to be repositioned by writing `style.top`/`style.left`
// directly — both layout-triggering properties — from inside tick()'s rAF
// loop. Two problems: (1) the loop only re-measures+repositions once per
// animation frame, so a native browser-driven scroll (which the compositor
// can paint before the next rAF fires) visibly ran the transcript content
// ahead of the iframe hoisted over it, one frame of lag on every scroll
// frame; (2) top/left forces layout even when nothing but the element's own
// screen position moved. Fix: the hoist span's own `top`/`left` are now
// fixed at 0 (set once, in the render below) and every reposition — both the
// rAF loop's and the new synchronous scroll/resize path below — writes only
// `transform: translate3d(x, y, 0)`, a compositor-only property. Positioning
// an unmoved (top:0/left:0) fixed-position box via translate3d(rect.left,
// rect.top, 0) lands it at the exact same viewport pixel a
// top:rect.top/left:rect.left box would have, so computePaneClip's clip
// insets (already relative to the placeholder's own border-box-local
// top-left — see its doc comment) need no coordinate adjustment: the box
// they describe is identical either way.
export function hoistTransform(r: RectLike | null): string {
  return r ? `translate3d(${r.left}px, ${r.top}px, 0)` : 'translate3d(-99999px, -99999px, 0)';
}

// Pulled out of the render below so the imperative scroll/resize sync path
// (tick()'s useEffect) can apply the identical clip-path string without
// duplicating the null/hidden tri-state logic inline — the two paths must
// never be able to drift from each other.
export function hoistClipPath(
  r: RectLike | null,
  paneHidden: boolean,
  clip: ClipInsets | null,
): string | undefined {
  return r && !paneHidden && clip
    ? `inset(${clip.top}px ${clip.right}px ${clip.bottom}px ${clip.left}px)`
    : undefined;
}

// Fade-during-scroll pure helpers — same DOM-free rationale as the rest of
// this section. `count` is consecutive scroll events seen so far this
// gesture; a gap of more than `settleMs` since the last event resets the
// streak to 1 (the gap itself means the previous gesture already settled,
// so this event starts a new one) instead of continuing to accumulate.
export type ScrollStreak = { count: number; lastT: number };

export function nextScrollStreak(prev: ScrollStreak, now: number, settleMs: number): ScrollStreak {
  const withinGesture = now - prev.lastT <= settleMs;
  return { count: withinGesture ? prev.count + 1 : 1, lastT: now };
}

export function shouldEngageScrollFade(streakCount: number, minStreak: number): boolean {
  return streakCount >= minStreak;
}

function clipEquals(a: ClipInsets | null, b: ClipInsets | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

function viewportRect(): RectLike {
  return { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
}

/**
 * FIX 3 (gated rAF loop): pure arm/disarm decision for the polling loop —
 * keep polling only while there is something to track: a live slot (mid-
 * fetch, mid grace-window, or simply on-screen) or at least one currently-
 * visible placeholder in the DOM. Deliberately excludes hidden-ancestor
 * placeholders (FIX 2 already treats those as NOT FOUND) so a permanently
 * `display:none` pane with an evicted slot doesn't keep the loop spinning
 * at ~60fps forever with nothing left to do — the deviation the audit
 * flagged against the HotkeyHints gating precedent.
 */
export function shouldKeepPolling(slotCount: number, presentPlaceholderCount: number): boolean {
  return slotCount > 0 || presentPlaceholderCount > 0;
}

// ── D2 pure helper ──────────────────────────────────────────────────────
/**
 * D2 (track-latest hot reload): pure gate deciding whether an incoming
 * `media-app-changed` WS frame should trigger reload() for one tracked slot.
 *
 * DESIGN RULE (authoritative): auto-reload applies ONLY when the slot's
 * current winning host (see pickHost) is panel-context. A transcript embed
 * is a reading surface — the agent's own turn narrated against a specific
 * build — so a live rebuild silently swapping its content out from under a
 * user mid-read would be surprising; a manual reload button already exists
 * there (AppReloadButton) for that. Panel tabs are where "give me the live
 * app" lives, so a track-latest panel slot hot-reloads; a track-latest
 * transcript-only slot does not, and a D4 pin-version slot (`trackLatest:
 * false`) never reloads from a frame regardless of context.
 *
 * H3 (Codex review): matching is by app NAME, not exact path equality. The
 * bug this fixes — a producer that only ever writes `apps/<name>/<stamp>.html`
 * + refreshes the `latest` pointer (never re-touching the flat compat alias
 * file's own mtime in the same write... well, it does refresh the alias too,
 * see below) used to never match a flat-url track-latest slot's exact-path
 * check, so that tab's "Latest (auto-reload)" mode silently never reloaded.
 * `appNameFromUrl` (web/src/lib/appVersion.ts) already extracts the same
 * name from any of the three frame shapes a version write can broadcast — a
 * concrete version file, the `latest` pointer file, or the flat alias — and
 * from either url shape a slot can legally be embedded with (bare relative
 * or `/api/media/`-prefixed, per M3's normalization). A track-latest PANEL
 * slot now reloads whenever the frame's name matches the slot's own name,
 * regardless of which of those three files the frame names.
 *
 * On a name-matching reload for a flat-url slot, the caller (onMediaAppChanged
 * below, via reload()/fetchHtml) re-fetches the FLAT url exactly as before —
 * deliberately not the version-file/latest url the frame itself named. This
 * is safe (not stale) because the D5 producer contract (documented at
 * docs/plans/cockpit-pinned-artifacts/phase-d-tasks.md D5) refreshes the flat
 * compat alias on EVERY version write, so `cache:'reload'`-fetching the flat
 * url always returns current bytes; wiring the async D3 listing endpoint
 * (GET /api/media-apps/<name>/versions) into this synchronous WS-frame path
 * instead would add a network round-trip and a real race window for no
 * benefit over the alias the producer already guarantees.
 */
export function shouldReloadOnFrame(
  slot: { context: 'panel' | 'transcript'; trackLatest: boolean; lastMtime: number | null },
  slotUrl: string,
  frame: { path: string; mtime: number },
): boolean {
  if (slot.context !== 'panel') return false;
  if (!slot.trackLatest) return false;
  const slotName = appNameFromUrl(slotUrl);
  const frameName = appNameFromUrl(frame.path);
  if (slotName == null || frameName == null || slotName !== frameName) return false;
  if (slot.lastMtime != null && frame.mtime <= slot.lastMtime) return false;
  return true;
}

type Slot = {
  height: number;
  rect: DOMRect | null;
  // FIX 1: is the placeholder currently scrolled fully outside its clipping
  // ancestor? Render-only — never affects eviction. See computePaneClip.
  paneHidden: boolean;
  clip: ClipInsets | null;
  html: string | null;
  failed: boolean;
  // B2: set only by a validated cc-app-error beacon (see lib/appBeacon.ts)
  // or cleared by an explicit reload() — never touched by tick().
  crashed: boolean;
  // B audit follow-up (CP3-B, FIX 2): the beacon's own `message`, if it sent
  // one (capped to CRASH_MESSAGE_MAX_LEN). null when no beacon has fired
  // (crashed via some other path never exists today, but keeps the type
  // honest) or after reload() clears it. Rendered as plain text content —
  // never markup — in the crashed strip.
  lastCrashMessage: string | null;
  // B2: the live iframe's own contentWindow, captured via ref so the
  // `message` listener can check `event.source === win` — the only trust
  // discriminator available for an opaque-origin srcdoc iframe. null
  // whenever no iframe is currently mounted for this slot (loading/failed/
  // crashed/mid-reload).
  win: Window | null;
  // B2: bumped by reload() only. Used as part of the iframe's React key so
  // a reload always mounts a genuinely new iframe element rather than
  // mutating srcDoc on the existing one.
  iframeKey: number;
  lastSeen: number;
  // D2: the winning host's context this tick (see pickHost) — the input to
  // shouldReloadOnFrame's panel-only gate. Kept on the slot (not derived at
  // frame-handling time) because by the time a frame arrives, tick() may not
  // have run again since the last host change.
  context: 'panel' | 'transcript';
  // D2/D4: whether this slot should hot-reload on a matching frame. Mirrors
  // the winning host's data-embed-app-track-latest (default true).
  trackLatest: boolean;
  // D2: mtime of the last frame (or explicit reload) applied to this slot —
  // guards against reloading again for a stale/duplicate/out-of-order frame.
  lastMtime: number | null;
  // H1 (Codex review): the mtime a reload() wants to become `lastMtime`
  // once ITS generation's fetch actually commits — never applied early. See
  // fetchGen below for why "early" was the bug.
  pendingMtime: number | null;
  // H1 (Codex review): bumped by reload() only. fetchHtml tags each request
  // with the slot's gen at launch time and, on resolve, commits (html +
  // pendingMtime -> lastMtime) ONLY if the slot's CURRENT gen still equals
  // the request's gen. The bug this fixes: a frame-triggered reload landing
  // while an earlier fetch for the same url was still in flight used to hit
  // fetchHtml's `fetchingRef.current.has(url)` early-return and get silently
  // dropped — yet reload() had already advanced `lastMtime` to the new
  // frame's mtime, so the (never-fetched) newer content was lost AND a
  // future identical frame would be suppressed by the already-advanced
  // watermark. Now: a reload always bumps the gen (cheap, no network call by
  // itself); if a fetch is already in flight, that in-flight fetch's own
  // `.finally()` notices the gen no longer matches what it launched with and
  // re-fetches itself — no reload is ever lost, and `lastMtime` only moves
  // when the generation that owns it actually lands.
  fetchGen: number;
  // Scroll-lag fix: the current winning host element (see pickHost),
  // refreshed every tick() alongside rect/context/trackLatest above. The
  // synchronous scroll/resize sync path (this component's useEffect) reads
  // this directly to re-measure+reposition WITHOUT waiting for the next rAF
  // frame — it never re-queries the DOM itself (that stays tick()'s job:
  // discovery, multi-placeholder arbitration, eviction). null only in the
  // instant before a slot's first tick() (never actually observable outside
  // that render, since a slot is always created with its host already known).
  hostEl: HTMLElement | null;
  // Mirrors the winning host's data-embed-app-hidden — the sync path folds
  // this into paneHidden exactly like tick() does, so an inactive panel tab
  // scrolling (rare, but the DOM stays live) can't accidentally un-hide.
  explicitlyHidden: boolean;
  // Generic elevation hook — see shouldElevateHoist above. Render-only,
  // not part of the scroll/resize sync path (structural, not scroll-driven).
  elevate: boolean;
};

type SlotEl = {
  url: string;
  height: number;
  el: HTMLElement;
  context: 'panel' | 'transcript';
  explicitlyHidden: boolean;
  trackLatest: boolean;
  // H2 (Codex review): true for the marker placeholder EmbeddedApp renders
  // for a cap-suspended app (`suspended` prop -> data-embed-app-suspended).
  // See tick()'s per-url loop below for what this bars.
  suspended: boolean;
  // Generic elevation hook (see PANEL_SHEET_HOIST_Z_INDEX/shouldElevateHoist
  // above): a placeholder may carry `data-embed-app-elevate="true"` to ask
  // for the chrome-piercing z-index outside the mobile-sheet breakpoint.
  // EmbeddedApp.tsx doesn't emit this yet — forward-compatible plumbing for
  // whichever placeholder wires it up next (e.g. a fullscreen panel mode).
  elevate: boolean;
};

function readSlotEls(): SlotEl[] {
  const out: SlotEl[] = [];
  document.querySelectorAll<HTMLElement>(SLOT_SELECTOR).forEach((el) => {
    const url = el.dataset.embedAppUrl;
    if (!url) return;
    const height = Number.parseInt(el.dataset.embedAppHeight ?? '', 10);
    const context = el.dataset.embedAppContext === 'panel' ? 'panel' : 'transcript';
    const explicitlyHidden = el.dataset.embedAppHidden === 'true';
    const trackLatest = el.dataset.embedAppTrackLatest !== 'false';
    const suspended = el.dataset.embedAppSuspended === 'true';
    const elevate = el.dataset.embedAppElevate === 'true';
    out.push({
      url,
      height: Number.isFinite(height) ? height : 360,
      el,
      context,
      explicitlyHidden,
      trackLatest,
      suspended,
      elevate,
    });
  });
  return out;
}

/**
 * Multi-placeholder host arbitration (C2): given every placeholder currently
 * in the DOM for one url (in document order), pick the single one whose rect
 * the live iframe follows this frame. Panel-context always wins over
 * transcript — once an app is pinned, the panel is the durable home for it
 * regardless of which panel tab happens to be active right now (an inactive-
 * but-pinned tab still hosts; its transcript placeholder shows the "open in
 * panel" chip instead of a live, invisible-anyway iframe). Falls back to
 * first-in-document-order, which is the only candidate in the pre-Phase-C
 * (single placeholder) case, so this is a strict generalization.
 */
function pickHost(entries: SlotEl[]): SlotEl {
  return entries.find((e) => e.context === 'panel') ?? entries[0];
}

// C2/L1 (Codex review): a shadow (non-host) placeholder's overlay chip. L1
// fix — this used to be a single DOMRect per url, so a second transcript
// duplicate of the same url silently lost its chip (Map.set overwrote the
// first). Now an array per url, one entry per non-host placeholder that
// currently wants a chip. `suspended` (H2) swaps the chip's label from
// "open in panel ↗" to "suspended in panel" — see the tick() suspendedMarker
// branch below.
type ShadowEntry = { rect: DOMRect; suspended: boolean };

function shadowRectEquals(a: DOMRect, b: DOMRect): boolean {
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

function shadowArraysEqual(a: ShadowEntry[] | undefined, b: ShadowEntry[]): boolean {
  if (!a) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].suspended !== b[i].suspended || !shadowRectEquals(a[i].rect, b[i].rect)) return false;
  }
  return true;
}

export function AppFrameLayer() {
  const [, forceRender] = useState(0);
  const slotsRef = useRef<Map<string, Slot>>(new Map());
  const fetchingRef = useRef<Set<string>>(new Set());
  // C2: non-host ("shadow") placeholder rects for the current frame, keyed by
  // url — purely presentational (the "open in panel ↗" / "suspended in
  // panel" chip overlay), no grace/eviction semantics of its own; recomputed
  // fresh every tick. L1: array per url (see ShadowEntry) so multiple
  // transcript duplicates of one url each keep their own chip.
  const shadowsRef = useRef<Map<string, ShadowEntry[]>>(new Map());
  // Scroll-lag fix: the hoist <span> DOM elements themselves, keyed by url —
  // populated/cleared by the render's own ref callback below. The scroll/
  // resize sync path (this component's useEffect) writes `style.transform`/
  // `style.clipPath`/`style.visibility`/`style.pointerEvents` on these
  // DIRECTLY, bypassing React's render/commit cycle entirely, which is what
  // lets a reposition land in the SAME frame a native scroll paints instead
  // of waiting for the next React-driven render. slotsRef stays the single
  // source of truth either way — the sync path updates it too, so a
  // subsequent React re-render (from tick(), a reload, etc.) never
  // reads/renders a stale rect.
  const hoistElsRef = useRef<Map<string, HTMLSpanElement>>(new Map());
  // Fade-during-scroll: consecutive-scroll-event streak (see
  // nextScrollStreak's doc comment), whether the fade is currently engaged,
  // and the pending settle timer id — all mutable, non-reactive, exactly
  // like the refs above (this is imperative DOM-sync state, not render
  // state).
  const scrollStreakRef = useRef<ScrollStreak>({ count: 0, lastT: 0 });
  const scrollFadedRef = useRef(false);
  const scrollSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { setActive, open, artifacts } = useArtifactPanel();
  // Mobile-sheet fix: see PANEL_SHEET_HOIST_Z_INDEX's doc comment.
  const narrow = useIsNarrow();

  // Phase C, C3: pin-to-panel — always an idempotent open({..., pinned:
  // true}), never a toggle-to-unpin (see AppPinButton's doc comment). `open`
  // is stable (useCallback in ArtifactPanelProvider); `height` comes from
  // the hosting slot's own tracked height so the panel reserves the same box
  // the transcript embed declared.
  function onPinClick(url: string, height: number) {
    open({
      id: appArtifactId(url),
      kind: 'app',
      title: basename(url),
      content: '',
      appUrl: url,
      appHeight: height,
      pinned: true,
    });
  }

  useEffect(() => {
    let alive = true;
    // null == not currently scheduled (FIX 3 gate). Distinct from the old
    // always-scheduled `number` — the loop now stops entirely when idle.
    let rafId: number | null = null;

    function fetchHtml(url: string) {
      // H1: an in-flight fetch for this url is never dropped by a reload
      // that lands mid-flight — reload() just bumps the slot's fetchGen,
      // and this in-flight request's own .finally() below notices the
      // mismatch and re-fetches itself once it clears the in-flight set.
      // Starting a second concurrent request here would race the first.
      if (fetchingRef.current.has(url)) return;
      const resolution = resolveMediaUrl(url);
      if (resolution.kind !== 'fetch') {
        const slot = slotsRef.current.get(url);
        if (slot) slot.failed = true;
        return;
      }
      const gen = slotsRef.current.get(url)?.fetchGen ?? 0;
      fetchingRef.current.add(url);
      // cache: 'reload' — the media route serves cache-control: max-age=3600
      // with no validators, so a same-URL re-fetch (reload button, D2 hot
      // reload of the flat alias) would happily return the browser's stale
      // copy for an hour. App HTML must always reflect the artifact on disk;
      // proven live by the capstone webwright run (rebuild -> reload served
      // old bytes). Images/videos keep normal caching — this is app-only.
      authFetch(resolution.fetchUrl, { cache: 'reload' })
        .then((res) => {
          if (!res.ok) throw new Error(`app fetch failed: ${res.status}`);
          return res.text();
        })
        .then((text) => {
          if (!alive) return;
          const slot = slotsRef.current.get(url);
          // H1: a newer reload() bumped fetchGen while this request was in
          // flight — never commit a stale response over content a
          // subsequent reload already superseded. The finally() below
          // re-fetches for the current generation instead.
          if (!slot || slot.fetchGen !== gen) return;
          slot.html = text;
          if (slot.pendingMtime != null) slot.lastMtime = slot.pendingMtime;
        })
        .catch(() => {
          if (!alive) return;
          const slot = slotsRef.current.get(url);
          // Same generation guard as the success path — a fetch failure for
          // an already-superseded generation must not flash "unavailable"
          // for content nobody's waiting on anymore; the retry below covers it.
          if (slot && slot.fetchGen === gen) slot.failed = true;
        })
        .finally(() => {
          fetchingRef.current.delete(url);
          if (!alive) return;
          const slot = slotsRef.current.get(url);
          if (slot && slot.fetchGen !== gen) {
            fetchHtml(url); // superseded while in flight — re-fetch for the current generation
            return;
          }
          forceRender((n) => n + 1);
        });
    }

    // B2: user-requested reload — re-fetch the url from scratch, drop the
    // current srcdoc/window/failed/crashed state, and bump iframeKey so the
    // render below mounts a genuinely new <iframe>. The intermediate render
    // (html: null) unmounts the current iframe first, so the remount happens
    // regardless of how fast the re-fetch resolves. Called from the
    // cockpit:app-reload listener (explicit AppReloadButton click, no
    // mtime) and — D2 — from the cockpit:media-app-changed listener below
    // (frame-triggered, passes the frame's mtime so slot.lastMtime tracks
    // it and a stale/duplicate frame doesn't reload again). That's what
    // keeps this exempt from, rather than a violation of, the never-reload
    // seam: every call here traces back to an explicit user action or an
    // explicit track-latest opt-in gated by shouldReloadOnFrame.
    function reload(url: string, mtime?: number) {
      const slot = slotsRef.current.get(url);
      if (!slot) return;
      slot.crashed = false;
      slot.lastCrashMessage = null;
      slot.failed = false;
      slot.html = null;
      slot.win = null;
      slot.iframeKey += 1;
      // H1: record the desired mtime but do NOT advance lastMtime yet — it
      // only moves once THIS generation's fetch actually commits (see
      // fetchHtml). Bumping fetchGen here is what makes this reload
      // impossible to silently lose: even if fetchHtml no-ops below because
      // a previous fetch for this url is still in flight, that in-flight
      // fetch's own .finally() will see the bumped gen and re-fetch itself.
      if (mtime != null) slot.pendingMtime = mtime;
      slot.fetchGen += 1;
      forceRender((n) => n + 1);
      fetchHtml(url);
    }

    function tick() {
      rafId = null;
      if (!alive) return;
      const now = performance.now();
      const found = readSlotEls();

      // C2: group by url (readSlotEls/querySelectorAll already yields
      // document order, which pickHost's fallback tier relies on) so
      // multi-placeholder arbitration can run before anything below treats
      // a url as having exactly one candidate rect.
      const byUrl = new Map<string, SlotEl[]>();
      for (const entry of found) {
        const list = byUrl.get(entry.url);
        if (list) list.push(entry);
        else byUrl.set(entry.url, [entry]);
      }

      // Placeholders matched by the selector AND not hidden-ancestor (FIX 2)
      // — the "genuinely present" set eviction/FIX-3-gating both key off.
      const presentUrls = new Set<string>();
      const nextShadows = new Map<string, ShadowEntry[]>();
      let changed = false;

      for (const [url, entries] of byUrl) {
        // H2 (Codex review): a suspended marker placeholder (ArtifactAppStack
        // rendering `<EmbeddedApp suspended />` for a cap-suspended app — see
        // EmbeddedApp.tsx's doc comment) BARS this url from hosting anywhere,
        // full stop — never call pickHost, never create/update a real slot,
        // never add url to presentUrls. Bug this fixes: previously the panel
        // tab claimed "suspended" while the transcript placeholder's
        // still-mounted iframe kept hosting the live app, defeating
        // LIVE_APP_CAP. Not adding to presentUrls means any EXISTING slot
        // ages out through the ordinary GRACE_MS eviction path just below —
        // no separate teardown logic needed. Transcript-context placeholders
        // for the same url still get a shadow chip (relabeled "suspended in
        // panel" by the render function) so there's a visible affordance to
        // wake it instead of a live iframe silently reappearing there.
        if (entries.some((e) => e.suspended)) {
          const arr: ShadowEntry[] = [];
          for (const e of entries) {
            if (e.context !== 'transcript') continue;
            const shadowRect = e.el.getBoundingClientRect();
            if (shadowRect.width === 0 && shadowRect.height === 0) continue;
            arr.push({ rect: shadowRect, suspended: true });
          }
          if (arr.length > 0) nextShadows.set(url, arr);
          continue;
        }

        const host = pickHost(entries);
        const rect = host.el.getBoundingClientRect();

        // FIX 2 (hidden-ancestor eviction): a zero-sized rect means some
        // ancestor collapsed this placeholder out of layout (mobile back-nav
        // hides the whole detail pane via `display:none` — the placeholder
        // itself stays mounted by design, so the selector above still
        // matches it). Treat it exactly like a genuinely-missing placeholder
        // so it flows through the same GRACE_MS eviction path below, rather
        // than leaking a slot (and its live iframe) forever. A zero-rect
        // check alone is sufficient: `offsetParent === null` would catch the
        // same `display:none` case for these in-flow placeholder spans, but
        // tells us nothing the rect we already measured doesn't (a
        // position:fixed element can legitimately have a null offsetParent,
        // but these placeholders never are one) — so this is the cheaper of
        // the two equivalent signals the audit flagged.
        //
        // CP3-C FIX 1: panel-context hosts are EXEMPT from this eviction —
        // don't `continue` on a panel zero-rect. The same mobile back-nav
        // `display:none` collapse zero-rects a pinned app's PANEL placeholder
        // too (it lives in the same collapsed `.detail` pane as any
        // transcript embed), and this loop used to evict it unconditionally,
        // silently destroying every pinned app's live iframe on every back
        // navigation. computePaneClip naturally returns `paneHidden: true`
        // for any zero-rect regardless of ancestor, so simply not skipping
        // here routes a panel zero-rect through the existing hide-not-evict
        // path below with no other logic changes. This is deliberate and
        // safe specifically because panel apps are pinned by explicit user
        // intent and bounded by LIVE_APP_CAP, so keep-alive is safe;
        // transcript embeds stay on the Phase-A evict path (unbounded,
        // leak-prone).
        if (rect.width === 0 && rect.height === 0 && host.context !== 'panel') continue;

        presentUrls.add(url);

        // C2: track every non-host placeholder's rect for the "open in
        // panel" chip overlay (render function below) — but only when the
        // host is genuinely IN the panel. Two transcript-context duplicates
        // of the same url (host = first-in-doc-order, per pickHost's
        // fallback tier) is a pre-existing, unremarkable edge case with no
        // panel to point at; showing "open in panel" there would be a lie.
        // A shadow with its own zero rect (e.g. scrolled/hidden-ancestor)
        // just doesn't get a chip this frame — no grace window needed, it's
        // purely decorative.
        if (host.context === 'panel') {
          const arr: ShadowEntry[] = [];
          for (const e of entries) {
            if (e === host) continue;
            const shadowRect = e.el.getBoundingClientRect();
            if (shadowRect.width === 0 && shadowRect.height === 0) continue;
            arr.push({ rect: shadowRect, suspended: false });
          }
          if (arr.length > 0) nextShadows.set(url, arr);
        }

        // FIX 1 (pane clipping): see computePaneClip's doc comment.
        const ancestorEl = host.el.closest('.thread-viewport');
        const ancestorRect = ancestorEl ? ancestorEl.getBoundingClientRect() : viewportRect();
        const { paneHidden: geometryHidden, clip } = computePaneClip(rect, ancestorRect);
        // C2: an explicitly-hidden host (inactive panel tab) hides exactly
        // like a geometrically-clipped-out placeholder — visibility only,
        // never eviction.
        const paneHidden = geometryHidden || host.explicitlyHidden;

        let slot = slotsRef.current.get(url);
        if (!slot) {
          slot = {
            height: host.height,
            rect,
            paneHidden,
            clip,
            html: null,
            failed: false,
            crashed: false,
            lastCrashMessage: null,
            win: null,
            iframeKey: 0,
            lastSeen: now,
            context: host.context,
            trackLatest: host.trackLatest,
            lastMtime: null,
            pendingMtime: null,
            fetchGen: 0,
            hostEl: host.el,
            explicitlyHidden: host.explicitlyHidden,
            elevate: host.elevate,
          };
          slotsRef.current.set(url, slot);
          fetchHtml(url);
          changed = true;
        } else {
          if (
            !slot.rect ||
            slot.rect.top !== rect.top ||
            slot.rect.left !== rect.left ||
            slot.rect.width !== rect.width ||
            slot.rect.height !== rect.height ||
            slot.paneHidden !== paneHidden ||
            !clipEquals(slot.clip, clip)
          ) {
            changed = true;
          }
          slot.rect = rect;
          slot.height = host.height;
          slot.paneHidden = paneHidden;
          slot.clip = clip;
          slot.lastSeen = now;
          // D2: the winning host can change context/trackLatest tick-to-tick
          // (e.g. a panel pin/unpin, or D4 flipping a tab's mode) — no re-
          // render needed for this alone, it only feeds shouldReloadOnFrame.
          slot.context = host.context;
          slot.trackLatest = host.trackLatest;
          // Scroll-lag fix: keep the sync path's cached host element/hidden
          // flag current every tick (~60fps while any slot exists — see FIX
          // 3's gate), same "cheap, no dedicated change-detection" treatment
          // as context/trackLatest just above.
          slot.hostEl = host.el;
          slot.explicitlyHidden = host.explicitlyHidden;
          slot.elevate = host.elevate;
        }
      }

      // Drop slots whose placeholder has been missing (or hidden-ancestor,
      // FIX 2) past the grace window (genuinely gone — session switch,
      // hidden pane — not a same-tick churn remount or a brief blip).
      for (const [url, slot] of slotsRef.current) {
        if (presentUrls.has(url)) continue;
        if (now - slot.lastSeen > GRACE_MS) {
          slotsRef.current.delete(url);
          changed = true;
        } else if (slot.rect !== null) {
          slot.rect = null; // hide until it reappears or the grace window drops it
          slot.paneHidden = false;
          slot.clip = null;
          changed = true;
        }
      }

      // C2: diff the shadow-chip map the same way slot rects are diffed
      // above, so a shadow placeholder appearing/moving/disappearing (e.g.
      // the transcript scrolls) re-renders the chip's overlay position.
      for (const [url, arr] of nextShadows) {
        if (!shadowArraysEqual(shadowsRef.current.get(url), arr)) {
          changed = true;
        }
      }
      if (!changed) {
        for (const url of shadowsRef.current.keys()) {
          if (!nextShadows.has(url)) {
            changed = true;
            break;
          }
        }
      }
      shadowsRef.current = nextShadows;

      if (changed) forceRender((n) => n + 1);

      // FIX 3: only keep polling while there's something left to track.
      if (shouldKeepPolling(slotsRef.current.size, presentUrls.size)) {
        rafId = requestAnimationFrame(tick);
      }
      // else: stop scheduling — the MutationObserver below re-arms the loop
      // next time the DOM changes (a new placeholder mounts, or a hidden
      // pane's ancestor flips back to visible).
    }

    // Scroll-lag fix: synchronous fast path, invoked directly by the
    // scroll/resize listeners below (NOT scheduled via rAF — a capture-phase
    // scroll/resize listener already runs before the browser paints the
    // frame that triggered it, so calling this straight from the listener is
    // what actually closes the 1-frame gap; wrapping it in another rAF would
    // reintroduce the exact lag this exists to remove). Bounded by however
    // many slots currently exist (LIVE_APP_CAP caps panel-context hosts at
    // 6; transcript-context concurrent embeds are realistically just as few
    // — see this file's module doc comment), so a getBoundingClientRect() +
    // a few style writes per slot on every scroll event is cheap.
    //
    // Deliberately narrower than tick(): only repositions slots whose cached
    // host element (slot.hostEl, kept current by tick() every frame) is
    // still attached to the document. tick() owns discovery (does a url's
    // placeholder exist at all right now?), multi-placeholder arbitration
    // (which placeholder wins?), and eviction (GRACE_MS bookkeeping,
    // slot.lastSeen) exclusively — this function never adds/removes a slot
    // and never touches slot.lastSeen, so it can't race tick()'s own grace-
    // window/eviction timing. A detached hostEl (churn remount replaced the
    // element, or the placeholder was genuinely torn down) is left entirely
    // alone here — tick()'s own querySelectorAll-driven pass on the very
    // next frame is the sole source of truth for "is this url still
    // present," exactly as before this fix.
    function syncPositions() {
      for (const [url, slot] of slotsRef.current) {
        const hostEl = slot.hostEl;
        if (!hostEl || !hostEl.isConnected) continue;
        const rect = hostEl.getBoundingClientRect();
        const ancestorEl = hostEl.closest('.thread-viewport');
        const ancestorRect = ancestorEl ? ancestorEl.getBoundingClientRect() : viewportRect();
        const { paneHidden: geometryHidden, clip } = computePaneClip(rect, ancestorRect);
        const paneHidden = geometryHidden || slot.explicitlyHidden;
        slot.rect = rect;
        slot.paneHidden = paneHidden;
        slot.clip = clip;

        const el = hoistElsRef.current.get(url);
        if (!el) continue;
        const hidden = paneHidden;
        el.style.transform = hoistTransform(rect);
        el.style.width = `${rect.width}px`;
        el.style.height = `${rect.height}px`;
        el.style.visibility = hidden ? 'hidden' : 'visible';
        el.style.pointerEvents = hidden ? 'none' : 'auto';
        const clipPath = hoistClipPath(rect, paneHidden, clip);
        if (clipPath) el.style.clipPath = clipPath;
        else el.style.removeProperty('clip-path');
      }
    }

    // Fade-during-scroll: toggles opacity/pointerEvents on every currently-
    // visible hoist span and injects/removes a `.embed-media-skeleton`
    // shimmer DIRECTLY into each slot's placeholder element (slot.hostEl) —
    // never into EmbeddedApp.tsx's own JSX (this file doesn't own that
    // component's markup; out of scope for this fix). The skeleton lands in
    // NORMAL DOCUMENT FLOW inside the placeholder (`.embed-media-frame` is
    // already `position: relative` + `overflow: hidden` in styles.css, and
    // currently renders no children), so it scrolls with the transcript with
    // zero JS involvement and cannot lag by construction — the whole point
    // of fading the (JS-repositioned) iframe out during motion instead of
    // just relying on syncPositions to keep chasing it. Skipped entirely for
    // a pane-hidden slot: nothing visible to fade, nothing to gain, and no
    // point reserving a skeleton box no one can see.
    function applyFadeState(faded: boolean) {
      for (const [url, slot] of slotsRef.current) {
        if (!slot.rect || slot.paneHidden) continue;
        const el = hoistElsRef.current.get(url);
        if (el) {
          el.style.opacity = faded ? '0' : '';
          el.style.pointerEvents = faded ? 'none' : 'auto';
        }
        const hostEl = slot.hostEl;
        if (!hostEl || !hostEl.isConnected) continue;
        const existing = hostEl.querySelector<HTMLElement>('[data-scroll-fade-skeleton]');
        if (faded && !existing) {
          const skeleton = document.createElement('span');
          skeleton.className = 'embed-media-skeleton';
          skeleton.setAttribute('aria-hidden', 'true');
          skeleton.setAttribute('data-scroll-fade-skeleton', 'true');
          hostEl.appendChild(skeleton);
        } else if (!faded && existing) {
          existing.remove();
        }
      }
    }

    // Wraps syncPositions with the fade-engagement streak/settle bookkeeping.
    // syncPositions itself ALWAYS runs first, on every scroll event,
    // regardless of fade state — the sync-follow fix above still matters for
    // slow scrolls (never crosses SCROLL_FADE_MIN_STREAK) and for the
    // final settle snap (see below), so position tracking never stops just
    // because the fade is engaged.
    function handleScroll() {
      syncPositions();
      const now = performance.now();
      scrollStreakRef.current = nextScrollStreak(scrollStreakRef.current, now, SCROLL_SETTLE_MS);
      // Re-applied on EVERY qualifying scroll event, not just the rising
      // edge into "faded" — applyFadeState is idempotent (skips a slot
      // that's already faded/already un-hidden), and a slot that's still
      // paneHidden when the streak first crosses the threshold (scrolled
      // out of view at the start of a long flick) only becomes eligible
      // partway through the SAME gesture once it scrolls into view; gating
      // on the rising edge alone would silently skip fading it for the rest
      // of that gesture. scrollFadedRef still exists purely to know whether
      // a reveal is owed on settle.
      if (shouldEngageScrollFade(scrollStreakRef.current.count, SCROLL_FADE_MIN_STREAK)) {
        scrollFadedRef.current = true;
        applyFadeState(true);
      }
      if (scrollSettleTimerRef.current !== null) clearTimeout(scrollSettleTimerRef.current);
      scrollSettleTimerRef.current = setTimeout(() => {
        scrollSettleTimerRef.current = null;
        scrollStreakRef.current = { count: 0, lastT: 0 };
        if (scrollFadedRef.current) {
          scrollFadedRef.current = false;
          // Snap to the truly-settled position before revealing — the scroll
          // that just ended may have landed after this timer's own last
          // syncPositions() call (compositor-driven smooth-scroll deceleration
          // can still be settling in the final ms).
          syncPositions();
          applyFadeState(false);
        }
      }, SCROLL_SETTLE_MS);
    }
    // passive (never calls preventDefault) + capture phase: scroll events
    // don't bubble, but DO propagate during the capture phase, so one
    // listener on window catches every nested scroll container (the
    // transcript's `.thread-viewport`, a panel body, any future nested pane)
    // instead of needing one listener per container.
    window.addEventListener('scroll', handleScroll, { passive: true, capture: true });
    window.addEventListener('resize', syncPositions, { passive: true });

    // FIX 3 (gated loop): arm/disarm via a MutationObserver on document.body
    // rather than polling unconditionally at ~60fps forever. The callback is
    // deliberately trivial — just "(re)start the loop if it's stopped" — NOT
    // a re-scan for `[data-embed-app-url]` itself; tick()'s own
    // querySelectorAll on the very next frame is the real, authoritative
    // check, and immediately re-stops the loop if nothing relevant actually
    // appeared. `attributes: true` is included (beyond the minimal
    // childList-only shape) because the mobile hidden-pane case this file's
    // FIX 2 targets is a pure CSS `display:none` driven by an ancestor
    // attribute toggle (no node is added/removed), so a childList-only
    // observer would never notice the pane — and therefore the now-visible-
    // again placeholder — coming back. Under heavy unrelated DOM/attribute
    // churn (e.g. transcript remounts) this costs at most one extra,
    // self-stopping rAF tick per observer-coalesced mutation batch —
    // nowhere near the unconditional 60fps this replaces — while a
    // genuinely idle DOM (no embeds, no mutations) schedules zero further
    // frames, which is the acceptance bar.
    const observer = new MutationObserver(() => {
      if (rafId === null && alive) rafId = requestAnimationFrame(tick);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });

    // B2: cockpit:app-reload is the only trigger for reload() — see reload's
    // doc comment above for why this keeps the never-reload seam intact.
    function onAppReload(ev: Event) {
      const url = (ev as CustomEvent<{ url?: string }>).detail?.url;
      if (typeof url === 'string') reload(url);
    }
    window.addEventListener('cockpit:app-reload', onAppReload);

    // D2: track-latest hot reload. useCockpit.ts relays the server's
    // 'media-app-changed' WS frame as this CustomEvent (same decoupling
    // idiom as cockpit:ack/cockpit:app-reload). Every tracked slot whose url
    // resolves to the frame's path gets shouldReloadOnFrame's panel-only,
    // track-latest-only gate applied — see that function's doc comment for
    // the authoritative design rule (transcript embeds never auto-reload).
    function onMediaAppChanged(ev: Event) {
      const frame = (ev as CustomEvent<{ path?: string; mtime?: number }>).detail;
      if (!frame || typeof frame.path !== 'string' || typeof frame.mtime !== 'number') return;
      const framePayload = { path: frame.path, mtime: frame.mtime };
      for (const [url, slot] of slotsRef.current) {
        if (shouldReloadOnFrame(slot, url, framePayload)) {
          reload(url, frame.mtime);
        }
      }
    }
    window.addEventListener('cockpit:media-app-changed', onMediaAppChanged);

    // B2: crash beacon. Checks every tracked slot's captured contentWindow
    // against event.source — see isValidAppErrorBeacon's doc comment for why
    // event.origin (always 'null' here) is never consulted.
    function onMessage(event: MessageEvent) {
      if (!alive) return;
      for (const slot of slotsRef.current.values()) {
        if (slot.crashed) continue;
        if (isValidAppErrorBeacon(event.source, slot.win, event.data)) {
          slot.crashed = true;
          // Shape-validated above (isAppErrorBeaconShape requires `message`,
          // if present, to be a string) — still narrow defensively here
          // rather than trusting the cast.
          const rawMessage = (event.data as { message?: unknown }).message;
          slot.lastCrashMessage =
            typeof rawMessage === 'string' ? rawMessage.slice(0, CRASH_MESSAGE_MAX_LEN) : null;
          forceRender((n) => n + 1);
          break;
        }
      }
    }
    window.addEventListener('message', onMessage);

    // Cheap initial guess (raw match, not the hidden-ancestor-filtered
    // "present" count tick() computes) — good enough to decide whether to
    // schedule the first tick at all; tick() re-evaluates precisely and
    // self-corrects within one frame either way.
    if (shouldKeepPolling(slotsRef.current.size, document.querySelectorAll(SLOT_SELECTOR).length)) {
      rafId = requestAnimationFrame(tick);
    }

    return () => {
      alive = false;
      observer.disconnect();
      window.removeEventListener('cockpit:app-reload', onAppReload);
      window.removeEventListener('cockpit:media-app-changed', onMediaAppChanged);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('scroll', handleScroll, { capture: true });
      window.removeEventListener('resize', syncPositions);
      if (rafId !== null) cancelAnimationFrame(rafId);
      // Fade-during-scroll: a settle timer can still be pending at unmount
      // (session switch mid-scroll, etc.) — clear it so a stale callback
      // never fires after teardown. The placeholder itself is React/
      // EmbeddedApp-owned and outlives this portal layer, so any injected
      // skeleton left in it (mid-fade unmount) would otherwise leak into the
      // transcript permanently; strip every marker this layer ever added.
      if (scrollSettleTimerRef.current !== null) clearTimeout(scrollSettleTimerRef.current);
      for (const el of document.querySelectorAll('[data-scroll-fade-skeleton]')) el.remove();
    };
  }, []);

  const slots = Array.from(slotsRef.current.entries());
  // L1: flatMap so multiple transcript duplicates of the same url each keep
  // their own chip (was a single Map<url, DOMRect>, so a second dupe's rect
  // silently overwrote the first's — see ShadowEntry's doc comment).
  const shadowChips = Array.from(shadowsRef.current.entries()).flatMap(([url, arr]) =>
    arr.map((entry, i) => ({ url, i, ...entry })),
  );
  if (slots.length === 0 && shadowChips.length === 0) return null;

  return createPortal(
    <>
      {shadowChips.map(({ url, i, rect, suspended }) => (
        <button
          key={`chip-${url}-${i}`}
          type="button"
          className="embed-app-panel-chip"
          style={{
            position: 'fixed',
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          }}
          onClick={() => setActive(appArtifactId(url))}
        >
          {suspended ? 'suspended in panel' : 'open in panel ↗'}
        </button>
      ))}
      {slots.map(([url, slot]) => {
        const r = slot.rect;
        // FIX 1: hidden whenever the placeholder isn't currently found
        // (pre-existing grace-hide behavior) OR it's found but scrolled
        // fully outside its pane (paneHidden) — either way, no eviction.
        const hidden = !r || slot.paneHidden;
        const clipPath = hoistClipPath(r, slot.paneHidden, slot.clip);
        // B audit follow-up (CP3-B, FIX 1): see clampChromeInsets' doc
        // comment — clamps the corner reload button and the crashed strip
        // into the visible slice of a partially-clipped placeholder.
        const chrome = clampChromeInsets(slot.clip);
        // Phase C, C3: whether this url is already pinned — drives the pin
        // button's filled-icon/aria-pressed visual only (see AppPinButton's
        // doc comment for why the click handler itself never toggles).
        const pinned = artifacts.some((a) => a.id === appArtifactId(url) && a.pinned);
        return (
          <span
            key={url}
            ref={(el) => {
              if (el) hoistElsRef.current.set(url, el);
              else hoistElsRef.current.delete(url);
            }}
            className="embed-app-hoist"
            data-embed-app-context={slot.context}
            style={{
              position: 'fixed',
              // Scroll-lag fix: fixed at 0/0, set once — every reposition
              // (this render AND the scroll/resize sync path above) moves
              // the box purely via `transform`, a compositor-only property.
              // See hoistTransform's doc comment for why this is pixel-
              // identical to the old top:r.top/left:r.left.
              top: 0,
              left: 0,
              transform: hoistTransform(r),
              width: r ? r.width : 1,
              height: r ? r.height : 1,
              visibility: hidden ? 'hidden' : 'visible',
              pointerEvents: hidden ? 'none' : 'auto',
              clipPath,
              zIndex: shouldElevateHoist(slot.context, narrow, slot.elevate)
                ? PANEL_SHEET_HOIST_Z_INDEX
                : undefined,
            }}
          >
            {slot.crashed ? (
              <div
                className="embed-app-crashed"
                style={{
                  top: chrome.crashedInset.top,
                  right: chrome.crashedInset.right,
                  bottom: chrome.crashedInset.bottom,
                  left: chrome.crashedInset.left,
                }}
              >
                <code className="embed-media-rejected embed-app-crashed-msg">app crashed: {url}</code>
                {/* B audit follow-up (CP3-B, FIX 2): the beacon's own message,
                    if it sent one — rendered as plain text content (React
                    escapes it same as any other child), never innerHTML, and
                    already capped to CRASH_MESSAGE_MAX_LEN at capture time. */}
                {slot.lastCrashMessage ? (
                  <code className="embed-app-crashed-detail">{slot.lastCrashMessage}</code>
                ) : null}
                <AppReloadButton url={url} quiet={false} />
                <AppPinButton pinned={pinned} quiet={false} onClick={() => onPinClick(url, slot.height)} />
              </div>
            ) : slot.failed ? (
              <>
                <code className="embed-media-rejected">app unavailable: {url}</code>
                <AppReloadButton
                  url={url}
                  quiet={false}
                  style={{ top: chrome.cornerTop, right: chrome.cornerRight }}
                />
                <AppPinButton
                  pinned={pinned}
                  quiet={false}
                  onClick={() => onPinClick(url, slot.height)}
                  style={{ top: chrome.cornerTop, left: chrome.cornerLeft }}
                />
              </>
            ) : slot.html != null ? (
              <>
                <iframe
                  key={slot.iframeKey}
                  ref={(el) => {
                    slot.win = el?.contentWindow ?? null;
                  }}
                  className="embed-app"
                  sandbox="allow-scripts"
                  srcDoc={slot.html}
                  title={url}
                />
                <AppReloadButton url={url} style={{ top: chrome.cornerTop, right: chrome.cornerRight }} />
                <AppPinButton
                  pinned={pinned}
                  onClick={() => onPinClick(url, slot.height)}
                  style={{ top: chrome.cornerTop, left: chrome.cornerLeft }}
                />
              </>
            ) : (
              <span className="embed-media-skeleton" aria-label="loading app" />
            )}
          </span>
        );
      })}
    </>,
    document.body,
  );
}
