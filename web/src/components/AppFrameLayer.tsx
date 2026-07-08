import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { authFetch } from '../lib/api';
import { isValidAppErrorBeacon } from '../lib/appBeacon';
import { resolveMediaUrl } from '../lib/mediaUrl';
import { appArtifactId, useArtifactPanel } from './ArtifactContext';
import { AppReloadButton } from './EmbeddedApp';

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
 * separately (shadowsRef) and rendered as a quiet "active in panel ↗" chip
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
 */

const GRACE_MS = 250;
const SLOT_SELECTOR = '[data-embed-app-url]';
// B audit follow-up (CP3-B, FIX 2): cap the beacon's app-controlled crash
// message so a misbehaving app can't blow up the crashed strip's layout.
const CRASH_MESSAGE_MAX_LEN = 200;

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

type ChromeClamp = { cornerTop: number; cornerRight: number; crashedInset: ClipInsets };

/**
 * FIX 1 (clamp chrome into the visible clip): computePaneClip's clip insets
 * describe how much of the placeholder's edges are clipped away by its
 * scroll pane, but the corner reload button (.embed-app-reload-btn,
 * top:6/right:6) and the crashed strip's CTA (.embed-app-crashed) both
 * position against the FULL, un-clipped placeholder box in the render
 * below — with a partial clip, either can land entirely inside the
 * clipped-away (invisible, non-hit-testable) region. This maps a clip into
 * where each piece of chrome should actually render:
 *  - cornerTop/cornerRight: the reload button's offset from the top-right
 *    corner, pushed inward by however much of the top/right edge is
 *    clipped away. Used for the healthy-iframe and failed-fetch corner
 *    button, both of which sit directly in the un-clipped hoist box.
 *  - crashedInset: the .embed-app-crashed strip's own inset, shrunk from
 *    the default 0 (full box) down to the clip — its flex-centered message
 *    then centers within the VISIBLE slice, and its own reload button
 *    (also top:6/right:6, but now relative to this shrunk box) lands in
 *    the visible corner too, with no separate offset needed.
 * Returns the identity result (no adjustment) when there's no clip.
 */
export function clampChromeInsets(clip: ClipInsets | null): ChromeClamp {
  const c = clip ?? { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    cornerTop: RELOAD_CORNER_OFFSET + c.top,
    cornerRight: RELOAD_CORNER_OFFSET + c.right,
    crashedInset: c,
  };
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
};

type SlotEl = {
  url: string;
  height: number;
  el: HTMLElement;
  context: 'panel' | 'transcript';
  explicitlyHidden: boolean;
};

function readSlotEls(): SlotEl[] {
  const out: SlotEl[] = [];
  document.querySelectorAll<HTMLElement>(SLOT_SELECTOR).forEach((el) => {
    const url = el.dataset.embedAppUrl;
    if (!url) return;
    const height = Number.parseInt(el.dataset.embedAppHeight ?? '', 10);
    const context = el.dataset.embedAppContext === 'panel' ? 'panel' : 'transcript';
    const explicitlyHidden = el.dataset.embedAppHidden === 'true';
    out.push({ url, height: Number.isFinite(height) ? height : 360, el, context, explicitlyHidden });
  });
  return out;
}

/**
 * Multi-placeholder host arbitration (C2): given every placeholder currently
 * in the DOM for one url (in document order), pick the single one whose rect
 * the live iframe follows this frame. Panel-context always wins over
 * transcript — once an app is pinned, the panel is the durable home for it
 * regardless of which panel tab happens to be active right now (an inactive-
 * but-pinned tab still hosts; its transcript placeholder shows the "active in
 * panel" chip instead of a live, invisible-anyway iframe). Falls back to
 * first-in-document-order, which is the only candidate in the pre-Phase-C
 * (single placeholder) case, so this is a strict generalization.
 */
function pickHost(entries: SlotEl[]): SlotEl {
  return entries.find((e) => e.context === 'panel') ?? entries[0];
}

export function AppFrameLayer() {
  const [, forceRender] = useState(0);
  const slotsRef = useRef<Map<string, Slot>>(new Map());
  const fetchingRef = useRef<Set<string>>(new Set());
  // C2: non-host ("shadow") placeholder rects for the current frame, keyed by
  // url — purely presentational (the "active in panel ↗" chip overlay), no
  // grace/eviction semantics of its own; recomputed fresh every tick.
  const shadowsRef = useRef<Map<string, DOMRect>>(new Map());
  const { setActive } = useArtifactPanel();

  useEffect(() => {
    let alive = true;
    // null == not currently scheduled (FIX 3 gate). Distinct from the old
    // always-scheduled `number` — the loop now stops entirely when idle.
    let rafId: number | null = null;

    function fetchHtml(url: string) {
      if (fetchingRef.current.has(url)) return;
      const resolution = resolveMediaUrl(url);
      if (resolution.kind !== 'fetch') {
        const slot = slotsRef.current.get(url);
        if (slot) slot.failed = true;
        return;
      }
      fetchingRef.current.add(url);
      authFetch(resolution.fetchUrl)
        .then((res) => {
          if (!res.ok) throw new Error(`app fetch failed: ${res.status}`);
          return res.text();
        })
        .then((text) => {
          if (!alive) return;
          const slot = slotsRef.current.get(url);
          if (slot) slot.html = text;
        })
        .catch(() => {
          if (!alive) return;
          const slot = slotsRef.current.get(url);
          if (slot) slot.failed = true;
        })
        .finally(() => {
          fetchingRef.current.delete(url);
          if (alive) forceRender((n) => n + 1);
        });
    }

    // B2: user-requested reload — re-fetch the url from scratch, drop the
    // current srcdoc/window/failed/crashed state, and bump iframeKey so the
    // render below mounts a genuinely new <iframe>. The intermediate render
    // (html: null) unmounts the current iframe first, so the remount happens
    // regardless of how fast the re-fetch resolves. Never called from tick()
    // — only from the cockpit:app-reload listener below, which only ever
    // fires from an explicit AppReloadButton click. That's what keeps this
    // exempt from, rather than a violation of, the never-reload seam.
    function reload(url: string) {
      const slot = slotsRef.current.get(url);
      if (!slot) return;
      slot.crashed = false;
      slot.lastCrashMessage = null;
      slot.failed = false;
      slot.html = null;
      slot.win = null;
      slot.iframeKey += 1;
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
      const nextShadows = new Map<string, DOMRect>();
      let changed = false;

      for (const [url, entries] of byUrl) {
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
        if (rect.width === 0 && rect.height === 0) continue;

        presentUrls.add(url);

        // C2: track every non-host placeholder's rect for the "active in
        // panel" chip overlay (render function below) — but only when the
        // host is genuinely IN the panel. Two transcript-context duplicates
        // of the same url (host = first-in-doc-order, per pickHost's
        // fallback tier) is a pre-existing, unremarkable edge case with no
        // panel to point at; showing "active in panel" there would be a lie.
        // A shadow with its own zero rect (e.g. scrolled/hidden-ancestor)
        // just doesn't get a chip this frame — no grace window needed, it's
        // purely decorative.
        if (host.context === 'panel') {
          for (const e of entries) {
            if (e === host) continue;
            const shadowRect = e.el.getBoundingClientRect();
            if (shadowRect.width === 0 && shadowRect.height === 0) continue;
            nextShadows.set(url, shadowRect);
          }
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
      for (const [url, rect] of nextShadows) {
        const prev = shadowsRef.current.get(url);
        if (
          !prev ||
          prev.top !== rect.top ||
          prev.left !== rect.left ||
          prev.width !== rect.width ||
          prev.height !== rect.height
        ) {
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
      window.removeEventListener('message', onMessage);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

  const slots = Array.from(slotsRef.current.entries());
  const shadows = Array.from(shadowsRef.current.entries());
  if (slots.length === 0 && shadows.length === 0) return null;

  return createPortal(
    <>
      {shadows.map(([url, rect]) => (
        <button
          key={`chip-${url}`}
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
          active in panel ↗
        </button>
      ))}
      {slots.map(([url, slot]) => {
        const r = slot.rect;
        // FIX 1: hidden whenever the placeholder isn't currently found
        // (pre-existing grace-hide behavior) OR it's found but scrolled
        // fully outside its pane (paneHidden) — either way, no eviction.
        const hidden = !r || slot.paneHidden;
        const clipPath =
          r && !slot.paneHidden && slot.clip
            ? `inset(${slot.clip.top}px ${slot.clip.right}px ${slot.clip.bottom}px ${slot.clip.left}px)`
            : undefined;
        // B audit follow-up (CP3-B, FIX 1): see clampChromeInsets' doc
        // comment — clamps the corner reload button and the crashed strip
        // into the visible slice of a partially-clipped placeholder.
        const chrome = clampChromeInsets(slot.clip);
        return (
          <span
            key={url}
            className="embed-app-hoist"
            style={{
              position: 'fixed',
              top: r ? r.top : -99999,
              left: r ? r.left : -99999,
              width: r ? r.width : 1,
              height: r ? r.height : 1,
              visibility: hidden ? 'hidden' : 'visible',
              pointerEvents: hidden ? 'none' : 'auto',
              clipPath,
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
              </div>
            ) : slot.failed ? (
              <>
                <code className="embed-media-rejected">app unavailable: {url}</code>
                <AppReloadButton
                  url={url}
                  quiet={false}
                  style={{ top: chrome.cornerTop, right: chrome.cornerRight }}
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
