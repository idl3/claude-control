import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { authFetch } from '../lib/api';
import { resolveMediaUrl } from '../lib/mediaUrl';

/**
 * Hoists <embedded-app> iframes out of the transcript row DOM into one
 * always-mounted layer, portaled to document.body and positioned over each
 * app's in-flow placeholder (rendered by EmbeddedApp in EmbeddedMedia.tsx).
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
 */

const GRACE_MS = 250;
const SLOT_SELECTOR = '[data-embed-app-url]';

type Slot = {
  height: number;
  rect: DOMRect | null;
  html: string | null;
  failed: boolean;
  lastSeen: number;
};

function readSlotEls(): { url: string; height: number; el: HTMLElement }[] {
  const out: { url: string; height: number; el: HTMLElement }[] = [];
  document.querySelectorAll<HTMLElement>(SLOT_SELECTOR).forEach((el) => {
    const url = el.dataset.embedAppUrl;
    if (!url) return;
    const height = Number.parseInt(el.dataset.embedAppHeight ?? '', 10);
    out.push({ url, height: Number.isFinite(height) ? height : 360, el });
  });
  return out;
}

export function AppFrameLayer() {
  const [, forceRender] = useState(0);
  const slotsRef = useRef<Map<string, Slot>>(new Map());
  const fetchingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    let rafId: number;

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

    function tick() {
      if (!alive) return;
      const now = performance.now();
      const found = readSlotEls();
      const foundUrls = new Set(found.map((f) => f.url));
      let changed = false;

      for (const { url, height, el } of found) {
        const rect = el.getBoundingClientRect();
        let slot = slotsRef.current.get(url);
        if (!slot) {
          slot = { height, rect, html: null, failed: false, lastSeen: now };
          slotsRef.current.set(url, slot);
          fetchHtml(url);
          changed = true;
        } else {
          if (
            !slot.rect ||
            slot.rect.top !== rect.top ||
            slot.rect.left !== rect.left ||
            slot.rect.width !== rect.width ||
            slot.rect.height !== rect.height
          ) {
            changed = true;
          }
          slot.rect = rect;
          slot.height = height;
          slot.lastSeen = now;
        }
      }

      // Drop slots whose placeholder has been missing past the grace window
      // (genuinely gone — e.g. session switch — not a same-tick churn remount).
      for (const [url, slot] of slotsRef.current) {
        if (foundUrls.has(url)) continue;
        if (now - slot.lastSeen > GRACE_MS) {
          slotsRef.current.delete(url);
          changed = true;
        } else if (slot.rect !== null) {
          slot.rect = null; // hide until it reappears or the grace window drops it
          changed = true;
        }
      }

      if (changed) forceRender((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(rafId);
    };
  }, []);

  const slots = Array.from(slotsRef.current.entries());
  if (slots.length === 0) return null;

  return createPortal(
    <>
      {slots.map(([url, slot]) => (
        <span
          key={url}
          className="embed-app-hoist"
          style={{
            position: 'fixed',
            top: slot.rect ? slot.rect.top : -99999,
            left: slot.rect ? slot.rect.left : -99999,
            width: slot.rect ? slot.rect.width : 1,
            height: slot.rect ? slot.rect.height : 1,
            visibility: slot.rect ? 'visible' : 'hidden',
            pointerEvents: slot.rect ? 'auto' : 'none',
          }}
        >
          {slot.failed ? (
            <code className="embed-media-rejected">app unavailable: {url}</code>
          ) : slot.html != null ? (
            <iframe className="embed-app" sandbox="allow-scripts" srcDoc={slot.html} title={url} />
          ) : (
            <span className="embed-media-skeleton" aria-label="loading app" />
          )}
        </span>
      ))}
    </>,
    document.body,
  );
}
