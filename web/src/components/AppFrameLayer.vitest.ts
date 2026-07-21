// @vitest-environment jsdom
//
// jsdom is needed only for the mounted rAF-gating test at the bottom — the
// computePaneClip/shouldKeepPolling suites above it are pure, DOM-free
// functions and would pass equally under the bare 'node' environment.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { render, cleanup, screen, act, waitFor, fireEvent } from '@testing-library/react';
import {
  AppFrameLayer,
  computePaneClip,
  clampChromeInsets,
  shouldKeepPolling,
  shouldReloadOnFrame,
  hoistTransform,
  hoistClipPath,
  hoistGeometry,
  shouldElevateHoist,
  hoistZIndex,
  nextScrollStreak,
  shouldEngageScrollFade,
  shouldCrossFadeHoist,
  shouldFadeSlot,
  pickHost,
  isInViewport,
  type RectLike,
  type SlotEl,
} from './AppFrameLayer';
// C2: AppFrameLayer now calls useArtifactPanel() internally, so the mounted
// rAF-gating test below needs a provider ancestor.
import { ArtifactPanelProvider } from './ArtifactContext';
import { EmbeddedApp } from './EmbeddedApp';

// D2: mounted tests below drive real fetches through AppFrameLayer's
// fetchHtml -> authFetch — mock it out the same way ArtifactPanel.vitest.ts
// does, rather than letting jsdom attempt a real network fetch.
const authFetchMock = vi.fn();
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, authFetch: (...args: Parameters<typeof actual.authFetch>) => authFetchMock(...args) };
});

afterEach(cleanup);

// Mobile-sheet fix: AppFrameLayer now calls useIsNarrow() (matchMedia)
// internally to gate PANEL_SHEET_HOIST_Z_INDEX — jsdom implements no
// matchMedia at all (not even a stub), so every mounted test in this file
// needs one or it throws on mount. Default to non-narrow (desktop) so all
// pre-existing tests keep their prior (implicitly-desktop) behavior; call
// mockNarrow(true) inside a specific test, before render(), to simulate the
// mobile sheet. Mirrors ArtifactPanel.vitest.ts's identical helper.
function mockNarrow(narrow: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: narrow && query === '(max-width:760px)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}
beforeEach(() => mockNarrow(false));

describe('computePaneClip (A3 audit follow-up, FIX 1: pane-intersection geometry)', () => {
  const ancestor: RectLike = { top: 100, left: 0, width: 800, height: 600 }; // e.g. .thread-viewport rect

  it('no clip when the placeholder sits entirely inside the ancestor', () => {
    const rect: RectLike = { top: 150, left: 50, width: 300, height: 200 };
    expect(computePaneClip(rect, ancestor)).toEqual({ paneHidden: false, clip: null });
  });

  it('paneHidden with no clip when scrolled fully above the ancestor', () => {
    const rect: RectLike = { top: -400, left: 50, width: 300, height: 200 }; // bottom=-200, ancestor top=100
    expect(computePaneClip(rect, ancestor)).toEqual({ paneHidden: true, clip: null });
  });

  it('paneHidden with no clip when scrolled fully below the ancestor', () => {
    const rect: RectLike = { top: 800, left: 50, width: 300, height: 200 }; // ancestor bottom=700
    expect(computePaneClip(rect, ancestor)).toEqual({ paneHidden: true, clip: null });
  });

  it('clips the top when the placeholder straddles the ancestor top edge', () => {
    // rect spans 50..250, ancestor starts at 100 -> 50px hidden above
    const rect: RectLike = { top: 50, left: 50, width: 300, height: 200 };
    expect(computePaneClip(rect, ancestor)).toEqual({
      paneHidden: false,
      clip: { top: 50, right: 0, bottom: 0, left: 0 },
    });
  });

  it('clips the bottom when the placeholder straddles the ancestor bottom edge', () => {
    // ancestor bottom=700; rect spans 650..900 -> 200px hidden below
    const rect: RectLike = { top: 650, left: 50, width: 300, height: 250 };
    expect(computePaneClip(rect, ancestor)).toEqual({
      paneHidden: false,
      clip: { top: 0, right: 0, bottom: 200, left: 0 },
    });
  });

  it('clips both left and right when the placeholder is wider than the ancestor', () => {
    const wideAncestor: RectLike = { top: 0, left: 100, width: 400, height: 1000 }; // right=500
    const rect: RectLike = { top: 10, left: 50, width: 600, height: 100 }; // right=650
    expect(computePaneClip(rect, wideAncestor)).toEqual({
      paneHidden: false,
      clip: { top: 0, right: 150, bottom: 0, left: 50 },
    });
  });

  it('treats a touching-not-overlapping edge as hidden (zero-width intersection)', () => {
    const rect: RectLike = { top: 200, left: -300, width: 300, height: 100 }; // right=0, ancestor.left=0
    expect(computePaneClip(rect, ancestor)).toEqual({ paneHidden: true, clip: null });
  });

  it('treats a zero-size rect as hidden', () => {
    const rect: RectLike = { top: 200, left: 200, width: 0, height: 0 };
    expect(computePaneClip(rect, ancestor).paneHidden).toBe(true);
  });
});

describe('clampChromeInsets (B audit follow-up, FIX 1: clamp chrome into the visible clip)', () => {
  it('is the identity offset (matches the CSS default 6px/6px, zero crashed inset) with no clip', () => {
    expect(clampChromeInsets(null)).toEqual({
      cornerTop: 6,
      cornerRight: 6,
      cornerLeft: 6,
      crashedInset: { top: 0, right: 0, bottom: 0, left: 0 },
    });
  });

  it('pushes the corner offset inward by the clipped top/right edges', () => {
    const clip = { top: 40, right: 15, bottom: 0, left: 0 };
    expect(clampChromeInsets(clip)).toEqual({
      cornerTop: 46,
      cornerRight: 21,
      cornerLeft: 6,
      crashedInset: clip,
    });
  });

  it('leaves the corner offset at its CSS default when only bottom/left are clipped, except cornerLeft (Phase C, C3 pin button)', () => {
    const clip = { top: 0, right: 0, bottom: 30, left: 25 };
    expect(clampChromeInsets(clip)).toEqual({
      cornerTop: 6,
      cornerRight: 6,
      cornerLeft: 31,
      crashedInset: clip,
    });
  });

  it('passes the full clip through as the crashed strip inset unchanged', () => {
    const clip = { top: 10, right: 20, bottom: 30, left: 40 };
    expect(clampChromeInsets(clip).crashedInset).toEqual(clip);
  });
});

describe('hoistTransform (scroll-lag fix: compositor-friendly positioning, pure)', () => {
  it('translates by the rect origin', () => {
    expect(hoistTransform({ top: 120, left: 40, width: 300, height: 200 })).toBe(
      'translate3d(40px, 120px, 0)',
    );
  });

  it('translates by (0, 0) when the rect sits at the viewport origin', () => {
    expect(hoistTransform({ top: 0, left: 0, width: 300, height: 200 })).toBe('translate3d(0px, 0px, 0)');
  });

  it('parks off-screen when there is no rect (grace-hidden / not-yet-found)', () => {
    expect(hoistTransform(null)).toBe('translate3d(-99999px, -99999px, 0)');
  });

  it('INVARIANT (mobile blank-render fix): always a 3D translate3d, never a plain 2D translate', () => {
    // styles.css's touch-only compositing fix (`.embed-app-hoist` under
    // `@media (hover: none) and (pointer: coarse)`) relies on the hoist's
    // transform always already being 3D — that's what promotes its own
    // compositing layer without needing `will-change: transform` on touch.
    // If this function ever regressed to a 2D `translate(x, y)`, the touch
    // media query's `will-change: auto` would stop having any GPU-layer
    // guarantee behind it. See styles.css's FIX N comment above
    // `.embed-app-hoist`'s touch media query block.
    for (const arg of [{ top: 1, left: 2, width: 3, height: 4 }, null] as const) {
      expect(hoistTransform(arg)).toMatch(/^translate3d\(/);
    }
  });

  it('Mobile-UX fix #3: composes a scale(...) after the translate3d when scale is not 1', () => {
    expect(hoistTransform({ top: 120, left: 40, width: 300, height: 200 }, 0.5)).toBe(
      'translate3d(40px, 120px, 0) scale(0.5)',
    );
  });

  it('Mobile-UX fix #3: scale omitted (or 1) stays byte-for-byte the pre-fix-3 string — no every-call-site regression', () => {
    const r = { top: 120, left: 40, width: 300, height: 200 };
    expect(hoistTransform(r)).toBe(hoistTransform(r, 1));
    expect(hoistTransform(r, 1)).toBe('translate3d(40px, 120px, 0)');
  });
});

describe('hoistClipPath (scroll-lag fix: shared clip-path string, pure)', () => {
  const rect: RectLike = { top: 0, left: 0, width: 300, height: 200 };
  const clip = { top: 10, right: 0, bottom: 0, left: 0 };

  it('returns the inset() string when there is a rect, it is not paneHidden, and a clip exists', () => {
    expect(hoistClipPath(rect, false, clip)).toBe('inset(10px 0px 0px 0px)');
  });

  it('returns undefined with no rect (not-yet-found / grace-hidden)', () => {
    expect(hoistClipPath(null, false, clip)).toBeUndefined();
  });

  it('returns undefined when paneHidden, even with a rect and a clip', () => {
    expect(hoistClipPath(rect, true, clip)).toBeUndefined();
  });

  it('returns undefined when there is no clip (fully inside the pane)', () => {
    expect(hoistClipPath(rect, false, null)).toBeUndefined();
  });

  it('Mobile-UX fix #3: divides the clip insets by scale (clip-path applies in the pre-transform/logical coordinate space)', () => {
    expect(hoistClipPath(rect, false, clip, 0.5)).toBe('inset(20px 0px 0px 0px)');
  });

  it('Mobile-UX fix #3: scale omitted (or 1) stays byte-for-byte the pre-fix-3 string', () => {
    expect(hoistClipPath(rect, false, clip)).toBe(hoistClipPath(rect, false, clip, 1));
  });
});

describe('hoistGeometry (Mobile-UX fix #3: logical size + display scale for one hoist slot, pure)', () => {
  it('scales up to the logical dims when both are present and the rect has width — scale derived from footprint/logical', () => {
    expect(hoistGeometry({ top: 0, left: 0, width: 366, height: 229 }, 1280, 800)).toEqual({
      width: 1280,
      height: 800,
      scale: 366 / 1280,
    });
  });

  it('identity (own rect, scale 1) when logicalWidth/logicalHeight are both null — the pre-fix-3 / non-scaling case', () => {
    const rect = { top: 0, left: 0, width: 366, height: 229 };
    expect(hoistGeometry(rect, null, null)).toEqual({ width: 366, height: 229, scale: 1 });
  });

  it('identity when only one of logicalWidth/logicalHeight is present', () => {
    const rect = { top: 0, left: 0, width: 366, height: 229 };
    expect(hoistGeometry(rect, 1280, null)).toEqual({ width: 366, height: 229, scale: 1 });
    expect(hoistGeometry(rect, null, 800)).toEqual({ width: 366, height: 229, scale: 1 });
  });

  it('identity when the rect has zero width (not-yet-measured slot) even with logical dims present', () => {
    const rect = { top: 0, left: 0, width: 0, height: 0 };
    expect(hoistGeometry(rect, 1280, 800)).toEqual({ width: 0, height: 0, scale: 1 });
  });
});

describe('shouldElevateHoist (generic elevation gate, pure)', () => {
  it('elevates a panel host on the mobile-sheet breakpoint, no elevate attribute needed', () => {
    expect(shouldElevateHoist('panel', true, false)).toBe(true);
  });

  it('elevates a panel host via the explicit elevate attribute, regardless of narrow', () => {
    expect(shouldElevateHoist('panel', false, true)).toBe(true);
  });

  it('elevates a panel host when both narrow and elevate are true', () => {
    expect(shouldElevateHoist('panel', true, true)).toBe(true);
  });

  it('does not elevate a panel host on desktop with no elevate attribute', () => {
    expect(shouldElevateHoist('panel', false, false)).toBe(false);
  });

  it('DESIGN RULE: never elevates a transcript host, regardless of narrow or the elevate attribute — it must stay below .detail-head/.composer (z-index: 2)', () => {
    expect(shouldElevateHoist('transcript', false, false)).toBe(false);
    expect(shouldElevateHoist('transcript', true, false)).toBe(false);
    expect(shouldElevateHoist('transcript', false, true)).toBe(false);
    expect(shouldElevateHoist('transcript', true, true)).toBe(false);
  });
});

describe('hoistZIndex (Phase B, B1: studio 310 vs panel 210, pure)', () => {
  it('a studio host always resolves to 310, regardless of narrow/elevate', () => {
    expect(hoistZIndex('studio', false, false)).toBe(310);
    expect(hoistZIndex('studio', true, false)).toBe(310);
    expect(hoistZIndex('studio', false, true)).toBe(310);
    expect(hoistZIndex('studio', true, true)).toBe(310);
  });

  it('DESIGN RULE: studio 310 is a distinct tier from panel elevate 210 — never conflated', () => {
    expect(hoistZIndex('studio', true, true)).not.toBe(hoistZIndex('panel', true, true));
    expect(hoistZIndex('panel', true, true)).toBe(210);
  });

  it('falls through to shouldElevateHoist for panel/transcript (unchanged behavior)', () => {
    expect(hoistZIndex('panel', true, false)).toBe(210);
    expect(hoistZIndex('panel', false, false)).toBeUndefined();
    expect(hoistZIndex('transcript', true, true)).toBeUndefined();
  });

  it('omitting the 4th (fullscreen) argument entirely preserves the pre-existing 3-arg behavior byte-for-byte', () => {
    expect(hoistZIndex('studio', false, false)).toBe(310);
    expect(hoistZIndex('panel', true, true)).toBe(210);
    expect(hoistZIndex('panel', false, false)).toBeUndefined();
    expect(hoistZIndex('transcript', true, true)).toBeUndefined();
  });
});

describe('hoistZIndex (Task 1: fullscreen tier, pure)', () => {
  it('fullscreen always resolves to 320, regardless of context/narrow/elevate', () => {
    expect(hoistZIndex('transcript', false, false, true)).toBe(320);
    expect(hoistZIndex('transcript', true, true, true)).toBe(320);
    expect(hoistZIndex('panel', false, false, true)).toBe(320);
    expect(hoistZIndex('panel', true, true, true)).toBe(320);
    expect(hoistZIndex('studio', false, false, true)).toBe(320);
    expect(hoistZIndex('studio', true, true, true)).toBe(320);
  });

  it('DESIGN RULE: fullscreen (320) is checked first — it wins even over an open studio host (310)', () => {
    expect(hoistZIndex('studio', false, false, true)).not.toBe(hoistZIndex('studio', false, false, false));
    expect(hoistZIndex('studio', false, false, true)).toBeGreaterThan(hoistZIndex('studio', false, false, false)!);
  });

  it('fullscreen=false behaves identically to omitting the argument', () => {
    expect(hoistZIndex('panel', true, true, false)).toBe(hoistZIndex('panel', true, true));
    expect(hoistZIndex('studio', false, false, false)).toBe(hoistZIndex('studio', false, false));
    expect(hoistZIndex('transcript', true, true, false)).toBe(hoistZIndex('transcript', true, true));
  });
});

describe('nextScrollStreak (fade-during-scroll: consecutive-event streak, pure)', () => {
  it('starts a fresh streak (count 1) from the initial {count: 0, lastT: 0} state', () => {
    expect(nextScrollStreak({ count: 0, lastT: 0 }, 1000, 150)).toEqual({ count: 1, lastT: 1000 });
  });

  it('continues the streak when the gap since the last event is within settleMs', () => {
    expect(nextScrollStreak({ count: 1, lastT: 1000 }, 1100, 150)).toEqual({ count: 2, lastT: 1100 });
  });

  it('treats a gap exactly equal to settleMs as still within the gesture (inclusive boundary)', () => {
    expect(nextScrollStreak({ count: 2, lastT: 1000 }, 1150, 150)).toEqual({ count: 3, lastT: 1150 });
  });

  it('resets to count 1 when the gap exceeds settleMs — the previous gesture already settled', () => {
    expect(nextScrollStreak({ count: 5, lastT: 1000 }, 1300, 150)).toEqual({ count: 1, lastT: 1300 });
  });
});

describe('shouldEngageScrollFade (fade-during-scroll: streak-length gate, pure)', () => {
  it('does not engage below the minimum streak', () => {
    expect(shouldEngageScrollFade(2, 3)).toBe(false);
  });

  it('engages exactly at the minimum streak', () => {
    expect(shouldEngageScrollFade(3, 3)).toBe(true);
  });

  it('stays engaged well past the minimum streak', () => {
    expect(shouldEngageScrollFade(10, 3)).toBe(true);
  });
});

describe('shouldCrossFadeHoist (B3: studio open/close cross-fade edge-detector, pure)', () => {
  it('fires when entering studio from transcript', () => {
    expect(shouldCrossFadeHoist('transcript', 'studio')).toBe(true);
  });

  it('fires when entering studio from panel', () => {
    expect(shouldCrossFadeHoist('panel', 'studio')).toBe(true);
  });

  it('fires when leaving studio back to transcript', () => {
    expect(shouldCrossFadeHoist('studio', 'transcript')).toBe(true);
  });

  it('fires when leaving studio back to panel', () => {
    expect(shouldCrossFadeHoist('studio', 'panel')).toBe(true);
  });

  it('does not fire for a panel <-> transcript handoff (no animated chrome to desync from)', () => {
    expect(shouldCrossFadeHoist('panel', 'transcript')).toBe(false);
    expect(shouldCrossFadeHoist('transcript', 'panel')).toBe(false);
  });

  it('does not fire when the context is unchanged, including a steady studio host', () => {
    expect(shouldCrossFadeHoist('transcript', 'transcript')).toBe(false);
    expect(shouldCrossFadeHoist('panel', 'panel')).toBe(false);
    expect(shouldCrossFadeHoist('studio', 'studio')).toBe(false);
  });
});

describe('shouldFadeSlot (transcript-only fade gate, pure)', () => {
  it('engages for a transcript-context slot when faded is requested', () => {
    expect(shouldFadeSlot(true, 'transcript')).toBe(true);
  });

  it('never engages for a panel-context slot, even when faded is requested — panel/studio hosts stay pinned via syncPositions with no lag to mask', () => {
    expect(shouldFadeSlot(true, 'panel')).toBe(false);
  });

  it('resolves to unfaded for a transcript-context slot when faded is not requested', () => {
    expect(shouldFadeSlot(false, 'transcript')).toBe(false);
  });

  it('resolves to unfaded for a panel-context slot when faded is not requested (idempotent)', () => {
    expect(shouldFadeSlot(false, 'panel')).toBe(false);
  });
});

describe('shouldKeepPolling (A3 audit follow-up, FIX 3: rAF loop arm/disarm gate)', () => {
  it('stops when there are neither live slots nor present placeholders', () => {
    expect(shouldKeepPolling(0, 0)).toBe(false);
  });

  it('keeps polling for a live slot mid grace-window even with nothing currently present', () => {
    expect(shouldKeepPolling(1, 0)).toBe(true);
  });

  it('keeps polling for a freshly-seen placeholder even before a slot exists yet', () => {
    expect(shouldKeepPolling(0, 1)).toBe(true);
  });

  it('keeps polling when both are present', () => {
    expect(shouldKeepPolling(2, 3)).toBe(true);
  });
});

describe('AppFrameLayer rAF gating (A3 audit follow-up, FIX 3, mounted)', () => {
  it('schedules zero rAF callbacks when mounted with no placeholders in the DOM', async () => {
    let rafCalls = 0;
    const realRaf = window.requestAnimationFrame.bind(window);
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCalls++;
      return realRaf(cb);
    });

    render(createElement(ArtifactPanelProvider, null, createElement(AppFrameLayer)));

    // Give the MutationObserver + any (unexpected) tick a few real frames to
    // fire, then assert the count never left zero — the mount-time guess
    // (shouldKeepPolling against a raw querySelectorAll count) sees no
    // matches and never schedules a first tick at all.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(rafCalls).toBe(0);

    rafSpy.mockRestore();
  });
});

describe('shouldReloadOnFrame (D2: track-latest hot reload gate, pure)', () => {
  const panelSlot = { context: 'panel' as const, trackLatest: true, lastMtime: null as number | null };
  const frame = { path: 'apps/widget.html', mtime: 100 };

  it('reloads a panel, track-latest slot on a matching, newer frame', () => {
    expect(shouldReloadOnFrame(panelSlot, 'apps/widget.html', frame)).toBe(true);
  });

  it('DESIGN RULE: never reloads a transcript-context slot, regardless of trackLatest — a transcript is a reading surface, a manual reload button exists there instead', () => {
    expect(shouldReloadOnFrame({ ...panelSlot, context: 'transcript' }, 'apps/widget.html', frame)).toBe(false);
  });

  it('never reloads a pin-version slot (trackLatest: false) even in panel context (D4)', () => {
    expect(shouldReloadOnFrame({ ...panelSlot, trackLatest: false }, 'apps/widget.html', frame)).toBe(false);
  });

  it('ignores a frame for a different app name (unrelated app)', () => {
    expect(shouldReloadOnFrame(panelSlot, 'apps/other.html', frame)).toBe(false);
  });

  it('ignores a frame when this slot url does not resolve to a media-root fetch path', () => {
    expect(shouldReloadOnFrame(panelSlot, 'https://example.com/apps/widget.html', frame)).toBe(false);
  });

  it('ignores a duplicate/stale frame whose mtime is not newer than the slot\'s last applied mtime', () => {
    expect(shouldReloadOnFrame({ ...panelSlot, lastMtime: 100 }, 'apps/widget.html', frame)).toBe(false);
    expect(shouldReloadOnFrame({ ...panelSlot, lastMtime: 150 }, 'apps/widget.html', frame)).toBe(false);
  });

  it('accepts a frame strictly newer than the slot\'s last applied mtime', () => {
    expect(shouldReloadOnFrame({ ...panelSlot, lastMtime: 50 }, 'apps/widget.html', frame)).toBe(true);
  });

  it('accepts the first-ever frame (lastMtime still null)', () => {
    expect(shouldReloadOnFrame({ ...panelSlot, lastMtime: null }, 'apps/widget.html', frame)).toBe(true);
  });

  // H3 (Codex review): name-aware matching. A track-latest PANEL slot must
  // reload on ANY frame shape for the same app name — version-file write,
  // `latest` pointer refresh, or the flat-alias refresh itself — because a
  // producer that only writes versioned files + `latest` (no flat-alias
  // touch) previously never hot-reloaded a flat-url track-latest tab at all
  // (exact-path equality never matched). D5's producer contract (every
  // version write ALSO refreshes the flat compat alias — see
  // docs/plans/cockpit-pinned-artifacts/phase-d-tasks.md:66) is what makes a
  // flat-fetch on ANY of these frames correct: the flat file on disk is
  // guaranteed current by the time this fires, so re-fetching the slot's own
  // (flat) url is exactly as valid as reacting to a flat-frame directly.
  it('H3: a flat/track-latest slot reloads on a version-file frame with the same app name', () => {
    const versionFrame = { path: 'apps/widget/2026-07-08T23-32-05Z.html', mtime: 200 };
    expect(shouldReloadOnFrame(panelSlot, 'apps/widget.html', versionFrame)).toBe(true);
  });

  it('H3: a flat/track-latest slot reloads on a `latest`-pointer frame with the same app name', () => {
    const latestFrame = { path: 'apps/widget/latest', mtime: 200 };
    expect(shouldReloadOnFrame(panelSlot, 'apps/widget.html', latestFrame)).toBe(true);
  });

  it('H3: a versioned slot url still matches a flat-alias frame with the same app name', () => {
    const slotUrl = 'apps/widget/2026-07-01T00-00-00Z.html';
    expect(shouldReloadOnFrame(panelSlot, slotUrl, frame)).toBe(true);
  });

  it('H3: name mismatch still gates out even across version-file/latest-pointer frame shapes', () => {
    const otherVersionFrame = { path: 'apps/other/2026-07-08T23-32-05Z.html', mtime: 200 };
    const otherLatestFrame = { path: 'apps/other/latest', mtime: 200 };
    expect(shouldReloadOnFrame(panelSlot, 'apps/widget.html', otherVersionFrame)).toBe(false);
    expect(shouldReloadOnFrame(panelSlot, 'apps/widget.html', otherLatestFrame)).toBe(false);
  });

  it('H3/M3: matches app names across /api/media/-prefixed and bare slot url shapes', () => {
    expect(shouldReloadOnFrame(panelSlot, '/api/media/apps/widget.html', frame)).toBe(true);
  });
});

describe('D2: track-latest hot reload — cockpit:media-app-changed (mounted)', () => {
  function mockRect(over: Partial<DOMRect>): DOMRect {
    const r = { top: 0, left: 0, width: 400, height: 320, x: 0, y: 0, ...over };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
  }

  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    authFetchMock.mockReset();
    authFetchMock.mockImplementation((url: string) =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(`<html>${url}</html>`) }),
    );
    // jsdom implements no layout — see the identical stub in
    // ArtifactPanel.vitest.ts for the full rationale.
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(mockRect({}));
  });
  afterEach(() => {
    rectSpy.mockRestore();
  });

  function mountApp(context: 'panel' | 'transcript' | undefined, url: string, trackLatest?: boolean) {
    render(
      createElement(
        ArtifactPanelProvider,
        null,
        createElement(EmbeddedApp, { url, height: 320, context, trackLatest }),
        createElement(AppFrameLayer),
      ),
    );
  }

  function dispatchFrame(path: string, mtime: number) {
    return act(async () => {
      window.dispatchEvent(new CustomEvent('cockpit:media-app-changed', { detail: { path, mtime } }));
    });
  }

  it('a panel-context, track-latest slot reloads when a matching frame arrives', async () => {
    mountApp('panel', 'apps/widget.html');
    await screen.findByTitle('apps/widget.html');
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    await dispatchFrame('apps/widget.html', 111);
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
  });

  it('a transcript-context slot (the default host) never reloads on a matching frame', async () => {
    mountApp(undefined, 'apps/widget2.html');
    await screen.findByTitle('apps/widget2.html');
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    await dispatchFrame('apps/widget2.html', 111);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it('a panel-context slot with trackLatest=false (D4 pin-version) never reloads from a frame', async () => {
    mountApp('panel', 'apps/widget3.html', false);
    await screen.findByTitle('apps/widget3.html');
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    await dispatchFrame('apps/widget3.html', 111);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it('a duplicate/stale frame (mtime not newer than the last applied) does not reload again', async () => {
    mountApp('panel', 'apps/widget4.html');
    await screen.findByTitle('apps/widget4.html');
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    await dispatchFrame('apps/widget4.html', 200);
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));

    await dispatchFrame('apps/widget4.html', 200);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(authFetchMock).toHaveBeenCalledTimes(2);
  });

  it('an unrelated frame (different path) never reloads a slot it does not match', async () => {
    mountApp('panel', 'apps/widget5.html');
    await screen.findByTitle('apps/widget5.html');
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    await dispatchFrame('apps/other.html', 111);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('L1 (Codex review): multiple non-host transcript duplicates of the same url each keep their own chip (mounted)', () => {
  function mockRect(over: Partial<DOMRect>): DOMRect {
    const r = { top: 0, left: 0, width: 400, height: 320, x: 0, y: 0, ...over };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
  }

  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    authFetchMock.mockReset();
    authFetchMock.mockImplementation((url: string) =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(`<html>${url}</html>`) }),
    );
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(mockRect({}));
  });
  afterEach(() => {
    rectSpy.mockRestore();
  });

  it('a panel-hosted app with two transcript-context duplicates of its url renders two distinct "open in panel" chips, not one', async () => {
    render(
      createElement(
        ArtifactPanelProvider,
        null,
        createElement(EmbeddedApp, { url: 'apps/dup.html', height: 320, context: 'panel' }),
        createElement(EmbeddedApp, { url: 'apps/dup.html', height: 320, context: 'transcript' }),
        createElement(EmbeddedApp, { url: 'apps/dup.html', height: 320, context: 'transcript' }),
        createElement(AppFrameLayer),
      ),
    );

    // The panel-context placeholder wins host arbitration (pickHost) — one
    // iframe, one fetch, regardless of how many transcript duplicates exist.
    await screen.findByTitle('apps/dup.html');
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    // Before the L1 fix, shadowsRef was a single DOMRect per url — the
    // second transcript duplicate's Map.set silently overwrote the first's,
    // leaving only one chip in the DOM no matter how many duplicates existed.
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'open in panel ↗' })).toHaveLength(2);
    });
  });
});

describe('Mobile-sheet fix: panel-hosted hoist z-index rides above the mobile sheet (mounted)', () => {
  function mockRect(over: Partial<DOMRect>): DOMRect {
    const r = { top: 0, left: 0, width: 400, height: 320, x: 0, y: 0, ...over };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
  }

  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    authFetchMock.mockReset();
    authFetchMock.mockImplementation((url: string) =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(`<html>${url}</html>`) }),
    );
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(mockRect({}));
  });
  afterEach(() => {
    rectSpy.mockRestore();
  });

  function mountApp(context: 'panel' | 'transcript', url: string) {
    render(
      createElement(
        ArtifactPanelProvider,
        null,
        createElement(EmbeddedApp, { url, height: 320, context }),
        createElement(AppFrameLayer),
      ),
    );
  }

  it("bumps a panel-context hoist to z-index 210 on the mobile sheet (narrow), clearing the sheet's own z-index: 200", async () => {
    mockNarrow(true);
    mountApp('panel', 'apps/sheet-zindex.html');
    await screen.findByTitle('apps/sheet-zindex.html');

    const hoist = document.querySelector('.embed-app-hoist') as HTMLElement | null;
    expect(hoist).not.toBeNull();
    expect(hoist!.style.zIndex).toBe('210');
  });

  it('leaves a panel-context hoist at the CSS default (no inline z-index) on desktop (not narrow)', async () => {
    mockNarrow(false);
    mountApp('panel', 'apps/desktop-zindex.html');
    await screen.findByTitle('apps/desktop-zindex.html');

    const hoist = document.querySelector('.embed-app-hoist') as HTMLElement | null;
    expect(hoist).not.toBeNull();
    // DESIGN RULE: a desktop panel-hosted iframe must stay below desktop
    // modals (.config-overlay etc., z-index 50-100) — no inline override.
    expect(hoist!.style.zIndex).toBe('');
  });

  it('DESIGN RULE: never bumps a transcript-context hoist, even on the mobile sheet — it must stay below .detail-head/.composer (z-index: 2)', async () => {
    mockNarrow(true);
    mountApp('transcript', 'apps/transcript-zindex.html');
    await screen.findByTitle('apps/transcript-zindex.html');

    const hoist = document.querySelector('.embed-app-hoist') as HTMLElement | null;
    expect(hoist).not.toBeNull();
    expect(hoist!.style.zIndex).toBe('');
  });
});

describe('Generic elevation hook: data-embed-app-elevate (mounted)', () => {
  function mockRect(over: Partial<DOMRect>): DOMRect {
    const r = { top: 0, left: 0, width: 400, height: 320, x: 0, y: 0, ...over };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
  }

  let rectSpy: ReturnType<typeof vi.spyOn>;
  let extraEl: HTMLElement | null = null;

  beforeEach(() => {
    authFetchMock.mockReset();
    authFetchMock.mockImplementation((url: string) =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(`<html>${url}</html>`) }),
    );
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(mockRect({}));
  });
  afterEach(() => {
    rectSpy.mockRestore();
    if (extraEl) {
      extraEl.remove();
      extraEl = null;
    }
  });

  // EmbeddedApp.tsx doesn't emit data-embed-app-elevate yet — it's forward-
  // compatible plumbing for a follow-up fullscreen-panel agent (see this
  // file's module doc comment) to wire up in ArtifactPanel.tsx/EmbeddedApp.tsx.
  // Build the raw placeholder directly, exactly the shape EmbeddedApp will
  // eventually render, rather than waiting on that follow-up work to land.
  function appendRawPlaceholder(attrs: Record<string, string>): HTMLElement {
    const el = document.createElement('span');
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.body.appendChild(el);
    extraEl = el;
    return el;
  }

  it('elevate attr bumps a panel-context hoist to z-index 210 even on desktop (not narrow)', async () => {
    mockNarrow(false);
    appendRawPlaceholder({
      'data-embed-app-url': 'apps/elevate.html',
      'data-embed-app-height': '320',
      'data-embed-app-context': 'panel',
      'data-embed-app-elevate': 'true',
    });
    render(createElement(ArtifactPanelProvider, null, createElement(AppFrameLayer)));

    await screen.findByTitle('apps/elevate.html');
    const hoist = document.querySelector('.embed-app-hoist') as HTMLElement | null;
    expect(hoist).not.toBeNull();
    expect(hoist!.style.zIndex).toBe('210');
  });

  it('panel+narrow still elevates unchanged, with no elevate attribute present', async () => {
    mockNarrow(true);
    appendRawPlaceholder({
      'data-embed-app-url': 'apps/elevate-narrow.html',
      'data-embed-app-height': '320',
      'data-embed-app-context': 'panel',
    });
    render(createElement(ArtifactPanelProvider, null, createElement(AppFrameLayer)));

    await screen.findByTitle('apps/elevate-narrow.html');
    const hoist = document.querySelector('.embed-app-hoist') as HTMLElement | null;
    expect(hoist).not.toBeNull();
    expect(hoist!.style.zIndex).toBe('210');
  });

  it('DESIGN RULE: a transcript-context hoist never elevates, even with the elevate attribute present', async () => {
    mockNarrow(false);
    appendRawPlaceholder({
      'data-embed-app-url': 'apps/elevate-transcript.html',
      'data-embed-app-height': '320',
      'data-embed-app-context': 'transcript',
      'data-embed-app-elevate': 'true',
    });
    render(createElement(ArtifactPanelProvider, null, createElement(AppFrameLayer)));

    await screen.findByTitle('apps/elevate-transcript.html');
    const hoist = document.querySelector('.embed-app-hoist') as HTMLElement | null;
    expect(hoist).not.toBeNull();
    expect(hoist!.style.zIndex).toBe('');
  });
});

describe('Scroll-lag fix: synchronous scroll/resize reposition (mounted)', () => {
  function mockRect(over: Partial<DOMRect>): DOMRect {
    const r = { top: 0, left: 0, width: 400, height: 320, x: 0, y: 0, ...over };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
  }

  let rectSpy: ReturnType<typeof vi.spyOn>;
  let currentTop = 0;

  beforeEach(() => {
    authFetchMock.mockReset();
    authFetchMock.mockImplementation((url: string) =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(`<html>${url}</html>`) }),
    );
    currentTop = 0;
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() =>
      mockRect({ top: currentTop, left: 20 }),
    );
  });
  afterEach(() => {
    rectSpy.mockRestore();
  });

  function mountApp(url: string) {
    render(
      createElement(
        ArtifactPanelProvider,
        null,
        createElement(EmbeddedApp, { url, height: 320 }),
        createElement(AppFrameLayer),
      ),
    );
  }

  it('repositions the hoist span (transform) synchronously on a scroll event — no animation frame required', async () => {
    mountApp('apps/scroll-sync.html');
    const iframe = await screen.findByTitle('apps/scroll-sync.html');
    const hoistBefore = iframe.closest('.embed-app-hoist') as HTMLElement;
    expect(hoistBefore.style.transform).toBe('translate3d(20px, 0px, 0)');

    // Change what getBoundingClientRect will report BEFORE firing the scroll
    // event, then read the hoist's transform in the exact same synchronous
    // callstack as the dispatchEvent call itself — no `await`, no `act()`.
    // window.dispatchEvent runs every matching listener synchronously, so a
    // value change observable here can only have come from the capture-phase
    // scroll listener (syncPositions): neither tick()'s rAF loop nor a React
    // commit can run in between two synchronous statements in the same turn.
    currentTop = 340;
    window.dispatchEvent(new Event('scroll'));

    const hoistAfter = iframe.closest('.embed-app-hoist') as HTMLElement;
    expect(hoistAfter.style.transform).toBe('translate3d(20px, 340px, 0)');
  });

  it('a resize event also triggers a synchronous reposition', async () => {
    mountApp('apps/resize-sync.html');
    const iframe = await screen.findByTitle('apps/resize-sync.html');
    const hoist = iframe.closest('.embed-app-hoist') as HTMLElement;
    expect(hoist.style.transform).toBe('translate3d(20px, 0px, 0)');

    currentTop = 88;
    window.dispatchEvent(new Event('resize'));
    expect(hoist.style.transform).toBe('translate3d(20px, 88px, 0)');
  });

  it('never-reload seam: the live iframe element is never remounted by a scroll-triggered reposition', async () => {
    mountApp('apps/scroll-no-remount.html');
    const iframeBefore = await screen.findByTitle('apps/scroll-no-remount.html');

    currentTop = 500;
    window.dispatchEvent(new Event('scroll'));
    currentTop = 900;
    window.dispatchEvent(new Event('scroll'));
    currentTop = 40;
    window.dispatchEvent(new Event('scroll'));

    const iframeAfter = screen.getByTitle('apps/scroll-no-remount.html');
    expect(iframeAfter).toBe(iframeBefore); // same DOM node, never torn down
  });
});

describe('Task 1: cover-transcript fullscreen (mounted)', () => {
  function mockRect(over: Partial<DOMRect>): DOMRect {
    const r = { top: 100, left: 20, width: 400, height: 320, x: 20, y: 100, ...over };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
  }

  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    authFetchMock.mockReset();
    authFetchMock.mockImplementation((url: string) =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(`<html>${url}</html>`) }),
    );
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(mockRect({}));
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 768 });
  });
  afterEach(() => {
    rectSpy.mockRestore();
  });

  // EmbeddedApp's context defaults to 'transcript' — canExpand's gate.
  function mountApp(url: string) {
    render(
      createElement(
        ArtifactPanelProvider,
        null,
        createElement(EmbeddedApp, { url, height: 320 }),
        createElement(AppFrameLayer),
      ),
    );
  }

  it('toggling the expand button covers the viewport (rect/z-index/data-attr) and never remounts the live iframe', async () => {
    mountApp('apps/expand-toggle.html');
    const iframeBefore = await screen.findByTitle('apps/expand-toggle.html');
    const hoist = iframeBefore.closest('.embed-app-hoist') as HTMLElement;
    expect(hoist.dataset.embedAppFullscreen).toBeUndefined();

    const expandBtn = screen.getByRole('button', { name: 'Enter fullscreen' });
    fireEvent.click(expandBtn);

    expect(hoist.dataset.embedAppFullscreen).toBe('true');
    expect(hoist.style.zIndex).toBe('320');
    expect(hoist.style.width).toBe('1024px');
    expect(hoist.style.height).toBe('768px');
    expect(hoist.style.transform).toBe('translate3d(0px, 0px, 0)');
    // never-remount seam: same DOM node before and after the toggle.
    const iframeAfter = screen.getByTitle('apps/expand-toggle.html');
    expect(iframeAfter).toBe(iframeBefore);

    // Toggling back off (aria-label flips to "Exit fullscreen") restores
    // the placeholder-sourced rect/z-index and clears the data attribute.
    const exitBtn = screen.getByRole('button', { name: 'Exit fullscreen' });
    fireEvent.click(exitBtn);
    expect(hoist.dataset.embedAppFullscreen).toBeUndefined();
    expect(hoist.style.zIndex).toBe('');
    expect(hoist.style.transform).toBe('translate3d(20px, 100px, 0)');
    expect(screen.getByTitle('apps/expand-toggle.html')).toBe(iframeBefore);
  });

  it('Escape exits an expanded slot, without ever remounting the live iframe', async () => {
    mountApp('apps/expand-escape.html');
    const iframeBefore = await screen.findByTitle('apps/expand-escape.html');
    const hoist = iframeBefore.closest('.embed-app-hoist') as HTMLElement;

    fireEvent.click(screen.getByRole('button', { name: 'Enter fullscreen' }));
    expect(hoist.dataset.embedAppFullscreen).toBe('true');

    // Unlike the scroll/resize sync path (direct style mutation), the Escape
    // handler drives a React state update (forceRender) via a plain
    // window.addEventListener callback — not React's synthetic event system —
    // so the commit isn't guaranteed to have flushed synchronously; act()
    // flushes it before the assertion below runs.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(hoist.dataset.embedAppFullscreen).toBeUndefined();
    expect(screen.getByTitle('apps/expand-escape.html')).toBe(iframeBefore);
  });

  it('a panel-hosted embed (canExpand=false) never renders the fullscreen expand button', async () => {
    render(
      createElement(
        ArtifactPanelProvider,
        null,
        createElement(EmbeddedApp, { url: 'apps/panel-no-expand.html', height: 320, context: 'panel' }),
        createElement(AppFrameLayer),
      ),
    );
    await screen.findByTitle('apps/panel-no-expand.html');
    expect(screen.queryByRole('button', { name: 'Enter fullscreen' })).toBeNull();
  });

  it('drag-resizing the placeholder box (AppResizeHandle) writes width/height onto the placeholder, dispatches cockpit:app-resize, and never remounts the iframe', async () => {
    mountApp('apps/resize-drag.html');
    const iframeBefore = await screen.findByTitle('apps/resize-drag.html');
    // The reserved-box placeholder is the EmbeddedApp-rendered span (distinct
    // from the hoisted .embed-app-hoist AppFrameLayer portals into document.body).
    const placeholder = document.querySelector('[data-embed-app-url="apps/resize-drag.html"]') as HTMLElement;
    expect(placeholder).toBeTruthy();

    const handle = document.querySelector('.embed-app-resize-handle') as HTMLElement;
    expect(handle).toBeTruthy();

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100 });
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 200, clientY: 180 }));
    // beginResize's apply() is rAF-throttled — flush it.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    window.dispatchEvent(new PointerEvent('pointerup'));

    // startRect from mockRect: width 400, height 320; drag delta +100/+80.
    expect(placeholder.style.width).toBe('500px');
    expect(placeholder.style.height).toBe('400px');
    const resizeCall = dispatchSpy.mock.calls.find(([e]) => (e as CustomEvent).type === 'cockpit:app-resize');
    expect(resizeCall).toBeTruthy();
    expect((resizeCall![0] as CustomEvent).detail).toMatchObject({ url: 'apps/resize-drag.html' });
    expect(screen.getByTitle('apps/resize-drag.html')).toBe(iframeBefore);
    dispatchSpy.mockRestore();
  });
});

describe('Fade-during-scroll: opacity fade + placeholder skeleton (mounted)', () => {
  function mockRect(over: Partial<DOMRect>): DOMRect {
    const r = { top: 0, left: 0, width: 400, height: 320, x: 0, y: 0, ...over };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
  }

  let rectSpy: ReturnType<typeof vi.spyOn>;
  let currentTop = 0;
  // Sidebar-fade fix: handleScroll now gates fade-engagement on the
  // triggering scroll event's own `target` (`.closest('.thread-viewport')`),
  // not just on "a window scroll happened" — see AppFrameLayer.tsx's
  // handleScroll doc comment. A capture-phase `window` listener only sees a
  // real `event.target` when the dispatch travels down from `window` through
  // an actually-connected DOM node, so these two panes are real elements
  // appended to `document.body` (not just constructed) and every
  // `fireScrolls` call below dispatches on one of them instead of on
  // `window` directly — `window.dispatchEvent(...)` sets `event.target` to
  // `window` itself (not an Element), which would fail the new gate for
  // every single existing test in this suite otherwise.
  let threadViewportEl: HTMLDivElement;
  let railScrollEl: HTMLDivElement;

  beforeEach(() => {
    authFetchMock.mockReset();
    authFetchMock.mockImplementation((url: string) =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(`<html>${url}</html>`) }),
    );
    currentTop = 0;
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() =>
      mockRect({ top: currentTop, left: 20 }),
    );
    threadViewportEl = document.createElement('div');
    threadViewportEl.className = 'thread-viewport';
    document.body.appendChild(threadViewportEl);
    railScrollEl = document.createElement('div');
    railScrollEl.className = 'rail-scroll';
    document.body.appendChild(railScrollEl);
  });
  afterEach(() => {
    rectSpy.mockRestore();
    threadViewportEl.remove();
    railScrollEl.remove();
  });

  function mountApp(url: string, context: 'panel' | 'transcript' = 'transcript') {
    return render(
      createElement(
        ArtifactPanelProvider,
        null,
        createElement(EmbeddedApp, { url, height: 320, context }),
        createElement(AppFrameLayer),
      ),
    );
  }

  // Dispatches N scroll events back-to-back in the same synchronous
  // callstack — real elapsed time between them is microseconds, comfortably
  // under SCROLL_SETTLE_MS (150ms), so every dispatch after the first
  // extends the same streak rather than starting a new one. Defaults to
  // originating from `.thread-viewport` (the real trigger for every
  // pre-existing test below); pass `railScrollEl` explicitly to simulate a
  // sidebar scroll instead.
  function fireScrolls(n: number, topStep = 20, sourceEl: HTMLElement = threadViewportEl) {
    for (let i = 0; i < n; i++) {
      currentTop += topStep;
      sourceEl.dispatchEvent(new Event('scroll'));
    }
  }

  it('engages the fade after SCROLL_FADE_MIN_STREAK (3) consecutive scroll events: fades the iframe and shows a skeleton in the placeholder', async () => {
    mountApp('apps/fade-engage.html');
    const iframe = await screen.findByTitle('apps/fade-engage.html');
    const hoist = iframe.closest('.embed-app-hoist') as HTMLElement;
    const placeholder = document.querySelector('[data-embed-app-url="apps/fade-engage.html"]') as HTMLElement;
    expect(hoist.style.opacity).toBe('');
    expect(placeholder.querySelector('[data-scroll-fade-skeleton]')).toBeNull();

    fireScrolls(3);

    expect(hoist.style.opacity).toBe('0');
    expect(hoist.style.pointerEvents).toBe('none');
    // Never-reload seam: fading is opacity/pointer-events only.
    expect(screen.getByTitle('apps/fade-engage.html')).toBe(iframe);
    const skeleton = placeholder.querySelector('[data-scroll-fade-skeleton]');
    expect(skeleton).not.toBeNull();
    expect(skeleton!.className).toBe('embed-media-skeleton');
  });

  // Sidebar-fade fix: the bug this test guards against. handleScroll is a
  // single capture-phase `window` listener that sees every nested scroll
  // pane's scroll events, including the sidebar's own `.rail-scroll` — which
  // never moves a transcript embed at all (only `.thread-viewport` scrolling
  // does). Before this fix, a `.rail-scroll` scroll built the exact same
  // streak and called applyFadeState(true) a real transcript flick would,
  // fading transcript embeds for a gesture that never touched them.
  it('does NOT fade-to-skeleton for a scroll originating from the sidebar (`.rail-scroll`), even well past the streak threshold, but DOES for a `.thread-viewport`-targeted scroll on the same embed', async () => {
    mountApp('apps/fade-sidebar-vs-transcript.html');
    const iframe = await screen.findByTitle('apps/fade-sidebar-vs-transcript.html');
    const hoist = iframe.closest('.embed-app-hoist') as HTMLElement;
    const placeholder = document.querySelector(
      '[data-embed-app-url="apps/fade-sidebar-vs-transcript.html"]',
    ) as HTMLElement;

    // Scroll the sidebar, aggressively — well past SCROLL_FADE_MIN_STREAK.
    fireScrolls(10, 20, railScrollEl);
    expect(hoist.style.opacity).toBe('');
    expect(hoist.style.pointerEvents).toBe('auto');
    expect(placeholder.querySelector('[data-scroll-fade-skeleton]')).toBeNull();

    // The SAME embed's hoist still fades for a real transcript scroll.
    fireScrolls(3, 20, threadViewportEl);
    expect(hoist.style.opacity).toBe('0');
    expect(hoist.style.pointerEvents).toBe('none');
    const skeleton = placeholder.querySelector('[data-scroll-fade-skeleton]');
    expect(skeleton).not.toBeNull();
    expect(skeleton!.className).toBe('embed-media-skeleton');
  });

  it('does not engage the fade on a small 1-2 event nudge (below SCROLL_FADE_MIN_STREAK)', async () => {
    mountApp('apps/fade-nudge.html');
    const iframe = await screen.findByTitle('apps/fade-nudge.html');
    const hoist = iframe.closest('.embed-app-hoist') as HTMLElement;
    const placeholder = document.querySelector('[data-embed-app-url="apps/fade-nudge.html"]') as HTMLElement;

    fireScrolls(2);

    expect(hoist.style.opacity).toBe('');
    expect(hoist.style.pointerEvents).toBe('auto');
    expect(placeholder.querySelector('[data-scroll-fade-skeleton]')).toBeNull();
  });

  it('snaps back to full opacity and removes the skeleton once the scroll settles (real timer, past SCROLL_SETTLE_MS)', async () => {
    mountApp('apps/fade-settle.html');
    const iframe = await screen.findByTitle('apps/fade-settle.html');
    const hoist = iframe.closest('.embed-app-hoist') as HTMLElement;
    const placeholder = document.querySelector('[data-embed-app-url="apps/fade-settle.html"]') as HTMLElement;

    fireScrolls(3);
    expect(hoist.style.opacity).toBe('0');
    expect(placeholder.querySelector('[data-scroll-fade-skeleton]')).not.toBeNull();

    // SCROLL_SETTLE_MS is 150ms (AppFrameLayer.tsx) — wait comfortably past
    // it with a real timer, matching this file's GRACE_MS convention
    // (embeds.vitest.ts) rather than faking timers (jsdom's rAF polyfill
    // likely relies on real setTimeout internally).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    expect(hoist.style.opacity).toBe('');
    expect(hoist.style.pointerEvents).toBe('auto');
    expect(placeholder.querySelector('[data-scroll-fade-skeleton]')).toBeNull();
  });

  it('never-reload seam: the live iframe element is never remounted across a full fade-engage-then-settle cycle', async () => {
    mountApp('apps/fade-no-remount.html');
    const iframeBefore = await screen.findByTitle('apps/fade-no-remount.html');

    fireScrolls(3);
    expect(screen.getByTitle('apps/fade-no-remount.html')).toBe(iframeBefore);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    const iframeAfter = screen.getByTitle('apps/fade-no-remount.html');
    expect(iframeAfter).toBe(iframeBefore);
  });

  // Operator follow-up: the fade masks a transcript-hosted iframe's
  // fast-flick lag as it's towed along the scrolling transcript feed — a
  // panel-hosted iframe lives in ArtifactPanel's own container and is
  // already kept pinned by syncPositions' synchronous reposition (always
  // unconditional, unaffected by this gate), so it must never fade/skeleton
  // on scroll. AppFrameLayer only distinguishes 'panel' | 'transcript'
  // contexts today (see SlotEl/Slot's `context` field and readSlotEls'
  // `=== 'panel'` bucketing) — a studio-hosted iframe, once built, reaches
  // this same non-fading path by rendering its placeholder with
  // `data-embed-app-context="panel"`, exactly like any other "lives in its
  // own container, already pinned" host (the same convention the mobile-
  // sheet z-index and D2 hot-reload gates already rely on). There is no
  // separate 'studio' literal to construct here; this test IS the
  // studio-context coverage the operator asked for.
  it('does NOT engage the fade for a panel-context host on the same qualifying scroll streak (opacity stays 1, no skeleton) — covers panel/pinned AND studio hosts, which share this same non-transcript path', async () => {
    mountApp('apps/fade-panel-no-engage.html', 'panel');
    const iframe = await screen.findByTitle('apps/fade-panel-no-engage.html');
    const hoist = iframe.closest('.embed-app-hoist') as HTMLElement;
    const placeholder = document.querySelector(
      '[data-embed-app-url="apps/fade-panel-no-engage.html"]',
    ) as HTMLElement;

    fireScrolls(3);

    expect(hoist.style.opacity).toBe('');
    expect(hoist.style.pointerEvents).toBe('auto');
    expect(placeholder.querySelector('[data-scroll-fade-skeleton]')).toBeNull();
    // Never-reload seam still holds: gating the fade never touches the iframe itself.
    expect(screen.getByTitle('apps/fade-panel-no-engage.html')).toBe(iframe);
  });

  it('does NOT engage the fade for a panel-context host even on a long, sustained scroll streak (well past the transcript threshold)', async () => {
    mountApp('apps/fade-panel-sustained.html', 'panel');
    const iframe = await screen.findByTitle('apps/fade-panel-sustained.html');
    const hoist = iframe.closest('.embed-app-hoist') as HTMLElement;

    fireScrolls(20);

    expect(hoist.style.opacity).toBe('');
    expect(hoist.style.pointerEvents).toBe('auto');
  });

  it('a host transitioning transcript→panel while faded resolves back to opacity 1 (does not stay stuck faded until settle)', async () => {
    const { rerender } = mountApp('apps/fade-context-flip.html', 'transcript');
    const iframe = await screen.findByTitle('apps/fade-context-flip.html');
    const hoist = iframe.closest('.embed-app-hoist') as HTMLElement;

    fireScrolls(3);
    expect(hoist.style.opacity).toBe('0');
    expect(hoist.style.pointerEvents).toBe('none');

    // Flip the same placeholder to panel context mid-fade (stands in for
    // "pinned into the panel mid-scroll" — pickHost arbitrating a
    // panel-context host in is the real-world trigger; this directly drives
    // the same observable outcome: the winning host's context changes).
    rerender(
      createElement(
        ArtifactPanelProvider,
        null,
        createElement(EmbeddedApp, { url: 'apps/fade-context-flip.html', height: 320, context: 'panel' }),
        createElement(AppFrameLayer),
      ),
    );

    // tick()'s rAF loop (already running continuously while this slot is
    // live — FIX 3's gate) needs a real frame to observe the placeholder's
    // new data-embed-app-context and update slot.context — internally, NOT
    // necessarily via a re-render: a context-only change deliberately never
    // sets tick()'s `changed` flag (see tick()'s own comment: "no re-render
    // needed for this alone, it only feeds shouldReloadOnFrame"), so the
    // hoist span's rendered data-embed-app-context attribute can stay stale
    // even after slot.context has already updated in memory — not a
    // reliable signal to poll here. Wait a fixed, comfortably-short real
    // window instead (well under SCROLL_SETTLE_MS's 150ms, so the pending
    // settle timer from the fireScrolls(3) above never fires and masks the
    // assertion by un-fading everything via the OTHER, context-independent
    // path) — long enough for several rAF frames to land.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    // The next scroll event (still within the same gesture — 80ms is under
    // SCROLL_SETTLE_MS, so the streak continues rather than resetting) must
    // resolve this now-panel slot back to unfaded immediately, driven by
    // applyFadeState's per-slot shouldFadeSlot resolve — not by waiting for
    // the gesture to fully settle.
    fireScrolls(1);

    expect(hoist.style.opacity).toBe('');
    expect(hoist.style.pointerEvents).toBe('auto');
  });
});

describe('H1 (Codex review): fetch generations — a reload mid-flight is never lost (mounted)', () => {
  function mockRect(over: Partial<DOMRect>): DOMRect {
    const r = { top: 0, left: 0, width: 400, height: 320, x: 0, y: 0, ...over };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
  }

  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    authFetchMock.mockReset();
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(mockRect({}));
  });
  afterEach(() => {
    rectSpy.mockRestore();
  });

  function mountApp(url: string) {
    render(
      createElement(
        ArtifactPanelProvider,
        null,
        createElement(EmbeddedApp, { url, height: 320, context: 'panel' }),
        createElement(AppFrameLayer),
      ),
    );
  }

  function dispatchFrame(path: string, mtime: number) {
    return act(async () => {
      window.dispatchEvent(new CustomEvent('cockpit:media-app-changed', { detail: { path, mtime } }));
    });
  }

  // The bug: a frame-triggered reload() that lands while an OLDER fetch for
  // the same url is still in flight used to be silently dropped — fetchHtml
  // no-ops when fetchingRef already has the url, and the in-flight fetch had
  // no way to know a reload had superseded it — yet reload() unconditionally
  // cleared slot.html and (pre-fix) would have let the older fetch's THEN
  // commit its now-stale response over it, with lastMtime already advanced
  // to the reload's mtime. Net effect: newer content never loads, and a
  // future identical frame is suppressed by shouldReloadOnFrame's own mtime
  // gate since lastMtime already (wrongly) reflects it.
  it('an older in-flight fetch never commits over a reload that lands mid-flight; the reload wins via a self re-fetch', async () => {
    let resolveA: (v: { ok: boolean; text: () => Promise<string> }) => void = () => {};
    let resolveB: (v: { ok: boolean; text: () => Promise<string> }) => void = () => {};
    const pendingA = new Promise<{ ok: boolean; text: () => Promise<string> }>((resolve) => {
      resolveA = resolve;
    });
    const pendingB = new Promise<{ ok: boolean; text: () => Promise<string> }>((resolve) => {
      resolveB = resolve;
    });
    authFetchMock.mockImplementationOnce(() => pendingA).mockImplementationOnce(() => pendingB);

    mountApp('apps/h1.html');
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(1)); // fetch A launched on mount

    // A reload lands while A is still in flight (bumps fetchGen + records
    // pendingMtime=555). fetchHtml() no-ops here — fetchingRef still holds
    // the url — so no second authFetch call yet; the mismatch is only
    // noticed once A's own .finally() runs below.
    await dispatchFrame('apps/h1.html', 555);
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    // Resolve A (the now-superseded, pre-reload fetch) with OLD content.
    await act(async () => {
      resolveA({ ok: true, text: () => Promise.resolve('<html>OLD</html>') });
    });

    // OLD must never be committed, and A's generation mismatch must have
    // triggered a self re-fetch (fetch B) for the current generation.
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByTitle('apps/h1.html')).toBeNull();

    // Resolve B (the reload's own re-fetch) with NEW content.
    await act(async () => {
      resolveB({ ok: true, text: () => Promise.resolve('<html>NEW</html>') });
    });

    const iframe = await screen.findByTitle('apps/h1.html');
    expect(iframe.getAttribute('srcdoc')).toBe('<html>NEW</html>');

    // lastMtime now reflects the reload's mtime (555), committed only when
    // generation B landed — a duplicate/stale frame at the same mtime must
    // not trigger a third fetch.
    await dispatchFrame('apps/h1.html', 555);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(authFetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('Phase B, B1: studio hosting tier — pickHost priority, elevation, handoff, chips (mounted)', () => {
  function mockRect(over: Partial<DOMRect>): DOMRect {
    const r = { top: 0, left: 0, width: 400, height: 320, x: 0, y: 0, ...over };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
  }

  // Distinguish each context's placeholder by a fixed top offset, so the
  // hoisted iframe's translate (hoistTransform) tells us which placeholder
  // currently won host arbitration (pickHost) — a DOM-observable proxy for
  // "who's hosting" independent of z-index/narrow, and independent of
  // pickHost itself (not exported — same reason the pre-existing L1 test
  // exercises it indirectly rather than unit-testing it directly).
  const TOP_BY_CONTEXT: Record<string, number> = { transcript: 0, panel: 100, studio: 200 };

  let rectSpy: ReturnType<typeof vi.spyOn>;
  let extraEls: HTMLElement[] = [];

  beforeEach(() => {
    authFetchMock.mockReset();
    authFetchMock.mockImplementation((url: string) =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(`<html>${url}</html>`) }),
    );
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const ctx = this.getAttribute('data-embed-app-context') ?? 'transcript';
      return mockRect({ top: TOP_BY_CONTEXT[ctx] ?? 0, left: 0 });
    });
  });
  afterEach(() => {
    rectSpy.mockRestore();
    for (const el of extraEls) el.remove();
    extraEls = [];
  });

  // Same raw-placeholder idiom as the "Generic elevation hook" suite above —
  // builds exactly the shape EmbeddedApp renders (context prop -> data-embed-
  // app-context) without needing a live StudioModal/ArtifactPanel around it.
  function appendRawPlaceholder(attrs: Record<string, string>): HTMLElement {
    const el = document.createElement('span');
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.body.appendChild(el);
    extraEls.push(el);
    return el;
  }

  it('studio outranks panel and transcript: with all three placeholders present for one url, the studio placeholder hosts (one slot, one fetch)', async () => {
    appendRawPlaceholder({
      'data-embed-app-url': 'apps/tiers.html',
      'data-embed-app-height': '320',
      'data-embed-app-context': 'transcript',
    });
    appendRawPlaceholder({
      'data-embed-app-url': 'apps/tiers.html',
      'data-embed-app-height': '320',
      'data-embed-app-context': 'panel',
    });
    appendRawPlaceholder({
      'data-embed-app-url': 'apps/tiers.html',
      'data-embed-app-height': '320',
      'data-embed-app-context': 'studio',
    });
    render(createElement(ArtifactPanelProvider, null, createElement(AppFrameLayer)));

    const iframe = await screen.findByTitle('apps/tiers.html');
    const hoist = iframe.closest('.embed-app-hoist') as HTMLElement;
    expect(hoist.style.transform).toBe('translate3d(0px, 200px, 0)'); // studio's top offset
    expect(hoist.style.zIndex).toBe('310');
    expect(authFetchMock).toHaveBeenCalledTimes(1); // one Slot per url regardless of placeholder count
  });

  it('closing the studio hands hosting back to panel, then transcript — zero iframe reloads across the whole journey (never-reload seam)', async () => {
    appendRawPlaceholder({
      'data-embed-app-url': 'apps/handoff.html',
      'data-embed-app-height': '320',
      'data-embed-app-context': 'transcript',
    });
    const panelEl = appendRawPlaceholder({
      'data-embed-app-url': 'apps/handoff.html',
      'data-embed-app-height': '320',
      'data-embed-app-context': 'panel',
    });
    const studioEl = appendRawPlaceholder({
      'data-embed-app-url': 'apps/handoff.html',
      'data-embed-app-height': '320',
      'data-embed-app-context': 'studio',
    });
    render(createElement(ArtifactPanelProvider, null, createElement(AppFrameLayer)));

    const iframeAtStudio = await screen.findByTitle('apps/handoff.html');
    expect((iframeAtStudio.closest('.embed-app-hoist') as HTMLElement).style.transform).toBe(
      'translate3d(0px, 200px, 0)',
    );
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    // Close the studio — same DOM effect as StudioPanel unmounting (its
    // EmbeddedApp context="studio" placeholder goes away with it).
    await act(async () => {
      studioEl.remove();
    });
    await waitFor(() => {
      const h = screen.getByTitle('apps/handoff.html').closest('.embed-app-hoist') as HTMLElement;
      expect(h.style.transform).toBe('translate3d(0px, 100px, 0)'); // falls to panel
    });
    expect(screen.getByTitle('apps/handoff.html')).toBe(iframeAtStudio); // never remounted
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    // Unpin from the panel too — falls all the way back to transcript.
    await act(async () => {
      panelEl.remove();
    });
    await waitFor(() => {
      const h = screen.getByTitle('apps/handoff.html').closest('.embed-app-hoist') as HTMLElement;
      expect(h.style.transform).toBe('translate3d(0px, 0px, 0)'); // falls to transcript
    });
    expect(screen.getByTitle('apps/handoff.html')).toBe(iframeAtStudio); // still the same node
    expect(authFetchMock).toHaveBeenCalledTimes(1); // one fetch for the entire journey
  });

  it('DESIGN RULE: a studio host always elevates to 310 (distinct from panel elevate\'s 210), on both narrow and desktop', async () => {
    mockNarrow(true);
    appendRawPlaceholder({
      'data-embed-app-url': 'apps/studio-zindex-narrow.html',
      'data-embed-app-height': '320',
      'data-embed-app-context': 'studio',
    });
    const { unmount } = render(createElement(ArtifactPanelProvider, null, createElement(AppFrameLayer)));
    const iframeNarrow = await screen.findByTitle('apps/studio-zindex-narrow.html');
    expect((iframeNarrow.closest('.embed-app-hoist') as HTMLElement).style.zIndex).toBe('310');
    unmount();

    mockNarrow(false);
    appendRawPlaceholder({
      'data-embed-app-url': 'apps/studio-zindex-desktop.html',
      'data-embed-app-height': '320',
      'data-embed-app-context': 'studio',
    });
    render(createElement(ArtifactPanelProvider, null, createElement(AppFrameLayer)));
    const iframeDesktop = await screen.findByTitle('apps/studio-zindex-desktop.html');
    expect((iframeDesktop.closest('.embed-app-hoist') as HTMLElement).style.zIndex).toBe('310');
  });

  it('DESIGN RULE: 310 clears .studio-overlay\'s own z-index (300, styles.css) with headroom, and stays below the sub-agent drawer (899/900) and lightbox (1000)', () => {
    expect(hoistZIndex('studio', false, false)).toBeGreaterThan(300);
    expect(hoistZIndex('studio', false, false)).toBeLessThan(899);
  });

  it('DESIGN RULE: a transcript-context hoist still never elevates, even while a studio host wins arbitration for a different url', async () => {
    mockNarrow(false);
    appendRawPlaceholder({
      'data-embed-app-url': 'apps/t1.html',
      'data-embed-app-height': '320',
      'data-embed-app-context': 'transcript',
    });
    appendRawPlaceholder({
      'data-embed-app-url': 'apps/t2.html',
      'data-embed-app-height': '320',
      'data-embed-app-context': 'studio',
    });
    render(createElement(ArtifactPanelProvider, null, createElement(AppFrameLayer)));

    const iframe1 = await screen.findByTitle('apps/t1.html');
    const iframe2 = await screen.findByTitle('apps/t2.html');
    expect((iframe1.closest('.embed-app-hoist') as HTMLElement).style.zIndex).toBe('');
    expect((iframe2.closest('.embed-app-hoist') as HTMLElement).style.zIndex).toBe('310');
  });

  it('non-host placeholders (transcript AND panel) get the "open in panel ↗" chip while studio hosts — chip text stays unchanged this phase', async () => {
    appendRawPlaceholder({
      'data-embed-app-url': 'apps/chips.html',
      'data-embed-app-height': '320',
      'data-embed-app-context': 'transcript',
    });
    appendRawPlaceholder({
      'data-embed-app-url': 'apps/chips.html',
      'data-embed-app-height': '320',
      'data-embed-app-context': 'panel',
    });
    appendRawPlaceholder({
      'data-embed-app-url': 'apps/chips.html',
      'data-embed-app-height': '320',
      'data-embed-app-context': 'studio',
    });
    render(createElement(ArtifactPanelProvider, null, createElement(AppFrameLayer)));

    await screen.findByTitle('apps/chips.html');
    await waitFor(() => {
      // Both the transcript AND the (now-shadowed) panel placeholder get the
      // existing chip — same text/click affordance as the pre-B1 panel-hosts
      // case, per the tracker's "keep existing chip text" instruction.
      expect(screen.getAllByRole('button', { name: 'open in panel ↗' })).toHaveLength(2);
    });
  });
});

describe('Studio Phase B CP3 audit, FIX 1: .studio-body pane clip (mounted)', () => {
  function mockRect(over: Partial<DOMRect>): DOMRect {
    const r = { top: 0, left: 0, width: 400, height: 320, x: 0, y: 0, ...over };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
  }

  let rectSpy: ReturnType<typeof vi.spyOn>;
  let studioBodyEl: HTMLElement | null = null;
  let placeholderEl: HTMLElement | null = null;

  beforeEach(() => {
    authFetchMock.mockReset();
    authFetchMock.mockImplementation((url: string) =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(`<html>${url}</html>`) }),
    );
  });
  afterEach(() => {
    rectSpy.mockRestore();
    placeholderEl?.remove();
    studioBodyEl?.remove();
    placeholderEl = null;
    studioBodyEl = null;
  });

  it('a studio host inside a scrolled real .studio-body pane gets clipped to that pane instead of falling back to the full viewport', async () => {
    // .studio-body pane: fixed at top=40 (below the modal's own head +
    // toolbar), 400x300 — the ancestor `.closest('.thread-viewport,
    // .studio-body')` must actually find. Pre-fix the selector only matched
    // '.thread-viewport', so a studio host never found ANY clipping
    // ancestor and computePaneClip ran against viewportRect() instead.
    const ancestorRect = { top: 40, left: 0, width: 400, height: 300 };
    // Placeholder scrolled so its top sits 20px ABOVE the pane's top and its
    // bottom runs 440px below the pane's bottom — exactly what a device box
    // taller than the modal (iPad 1024 / Desktop 800) produces once
    // `.studio-body`'s own `overflow: auto` has scrolled on a typical
    // laptop screen.
    const placeholderRect = { top: -20, left: 0, width: 400, height: 800 };

    studioBodyEl = document.createElement('div');
    studioBodyEl.className = 'studio-body';
    document.body.appendChild(studioBodyEl);

    placeholderEl = document.createElement('span');
    placeholderEl.setAttribute('data-embed-app-url', 'apps/studio-clip.html');
    placeholderEl.setAttribute('data-embed-app-height', '800');
    placeholderEl.setAttribute('data-embed-app-context', 'studio');
    studioBodyEl.appendChild(placeholderEl);

    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this === studioBodyEl) return mockRect(ancestorRect);
      if (this === placeholderEl) return mockRect(placeholderRect);
      return mockRect({});
    });

    render(createElement(ArtifactPanelProvider, null, createElement(AppFrameLayer)));

    await screen.findByTitle('apps/studio-clip.html');
    const hoist = document.querySelector('.embed-app-hoist') as HTMLElement;
    await waitFor(() => {
      // top: ancestor.top(40) - rect.top(-20) = 60; bottom: rect.bottom(780)
      // - ancestor.bottom(340) = 440 — a real, non-trivial clip on BOTH
      // edges. Pre-fix this was `undefined` (unclipped): a placeholder that
      // easily fits inside jsdom's default (effectively infinite) viewport
      // produces no clip at all once `.closest()` falls through to
      // viewportRect(), which is exactly the "unclipped iframe floats over
      // the studio's own head/toolbar" bug FIX 1 closes.
      expect(hoist.style.clipPath).toBe('inset(60px 0px 440px 0px)');
    });
  });

  it("elementFromPoint hit-testing at the studio's close button cannot be expressed in jsdom at all — no layout engine, no implementation of the API — same limitation B1's own verification note (phase-b-tasks.md) already recorded ('jsdom can't prove this', proven instead via a real-Chromium harness). The clip-math assertion above is FIX 1's real, DOM-observable proof for this suite.", () => {
    // jsdom (this project's vitest environment) doesn't even implement
    // elementFromPoint — there's no layout engine to hit-test against, so
    // there is nothing here to assert beyond "the API is absent." A real
    // close-button-vs-iframe hit-test needs a real browser, exactly as B1
    // documented.
    expect(typeof (document as unknown as { elementFromPoint?: unknown }).elementFromPoint).toBe(
      'undefined',
    );
  });
});

describe('Studio Phase B CP3 audit, FIX 2: studio hosts render no corner-button chrome (mounted)', () => {
  function mockRect(over: Partial<DOMRect>): DOMRect {
    const r = { top: 0, left: 0, width: 400, height: 320, x: 0, y: 0, ...over };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
  }

  let rectSpy: ReturnType<typeof vi.spyOn>;
  let extraEls: HTMLElement[] = [];

  beforeEach(() => {
    authFetchMock.mockReset();
    authFetchMock.mockImplementation((url: string) =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(`<html>${url}</html>`) }),
    );
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(mockRect({}));
  });
  afterEach(() => {
    rectSpy.mockRestore();
    for (const el of extraEls) el.remove();
    extraEls = [];
  });

  function appendRawPlaceholder(attrs: Record<string, string>): HTMLElement {
    const el = document.createElement('span');
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.body.appendChild(el);
    extraEls.push(el);
    return el;
  }

  it('a studio-context host renders none of the reload/pin/fullscreen corner trio; a transcript host for a different url still renders all three', async () => {
    appendRawPlaceholder({
      'data-embed-app-url': 'apps/studio-chrome.html',
      'data-embed-app-height': '320',
      'data-embed-app-context': 'studio',
    });
    appendRawPlaceholder({
      'data-embed-app-url': 'apps/transcript-chrome.html',
      'data-embed-app-height': '320',
      'data-embed-app-context': 'transcript',
    });
    render(createElement(ArtifactPanelProvider, null, createElement(AppFrameLayer)));

    const studioIframe = await screen.findByTitle('apps/studio-chrome.html');
    const transcriptIframe = await screen.findByTitle('apps/transcript-chrome.html');
    const studioHoist = studioIframe.closest('.embed-app-hoist') as HTMLElement;
    const transcriptHoist = transcriptIframe.closest('.embed-app-hoist') as HTMLElement;

    // Pre-fix: this trio rendered unconditionally for every context,
    // including studio — floating over the previewed app inside the device
    // box (visual clutter the studio's own head/toolbar chrome has no room
    // for), and turning the fullscreen button into a self-referential no-op
    // (re-opening the studio for a url the studio already hosts).
    expect(studioHoist.querySelector('[aria-label="Reload app"]')).toBeNull();
    expect(studioHoist.querySelector('[aria-label="Open in panel"]')).toBeNull();
    expect(studioHoist.querySelector('[aria-label="Open in studio"]')).toBeNull();

    // A non-studio host is completely unaffected by the new gate.
    expect(transcriptHoist.querySelector('[aria-label="Reload app"]')).not.toBeNull();
    expect(transcriptHoist.querySelector('[aria-label="Open in panel"]')).not.toBeNull();
    expect(transcriptHoist.querySelector('[aria-label="Open in studio"]')).not.toBeNull();
  });
});

describe('Mobile transcript-embed blank-render fix (iOS Safari compositing, touch-gated, styles.css)', () => {
  // Real-device-only bug (reporter-confirmed): the hoisted iframe span
  // composited as a fully blank/dark box on a real iPhone — no shimmer, no
  // error chip, scroll/rotate didn't recover it. Two headless-WebKit repro
  // attempts (a synthetic mount, and a real-server + real-nav-flow Playwright
  // run against production bundle+backend) could NOT reproduce it: the
  // hoist/iframe painted correctly within ~50ms of every `data-detail`
  // navigation flip tested (both a hash-restored return visit and a fresh
  // first click), so AppFrameLayer's tick()/MutationObserver nav-reflow path
  // is NOT the root cause — this is a real-iOS GPU/compositing bug (see
  // https://gwwar.com/debugging-hard-things-safari-edition/). The fix is
  // CSS-only and cannot be proven by any headless test; this suite instead
  // guards the two concrete regressions that would silently break the fix:
  // (1) someone reverting the touch-gated mitigation, (2) someone "helpfully"
  // adding a CSS `transform` to that block, which would be dead code — see
  // below.
  // process.cwd()-relative, not import.meta.url-relative: vitest's module
  // runner doesn't always give import.meta.url a real `file:` URL, but this
  // suite (like every other vitest invocation in the repo) always runs from
  // the `web/` package root.
  const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
  // Isolate the touch-only override block so assertions can't accidentally
  // match the unconditional `.embed-app-hoist` rule above it.
  const touchBlockMatch = css.match(
    /@media \(hover: none\) and \(pointer: coarse\) \{\s*\.embed-app-hoist \{([\s\S]*?)\}\s*\}/,
  );

  it('the touch-only mitigation block exists', () => {
    expect(touchBlockMatch).not.toBeNull();
  });

  it('drops the redundant will-change hint on touch (GPU memory pressure is the suspected trigger)', () => {
    expect(touchBlockMatch?.[1]).toMatch(/will-change:\s*auto/);
  });

  it('adds backface-visibility: hidden on touch (documented WebKit blank-tile mitigation)', () => {
    expect(touchBlockMatch?.[1]).toMatch(/backface-visibility:\s*hidden/);
  });

  it('REGRESSION GUARD: never adds a CSS `transform` override in this block — it would be dead code', () => {
    // hoistTransform() (AppFrameLayer.tsx) writes `el.style.transform`
    // directly on every tick; an inline style always wins over any
    // stylesheet rule regardless of specificity or media query, so a
    // `transform:` declaration here can never take effect. This guards
    // against silently reintroducing the exact mistake this fix's own
    // authoring caught: adding `translateZ(0)` via CSS, believing it does
    // something, when the browser is already applying (and always applying)
    // the inline `translate3d(x, y, 0)` from hoistTransform() instead.
    expect(touchBlockMatch?.[1]).not.toMatch(/(?<!-webkit-)\btransform\s*:/);
  });

  it('the base (non-touch) rule still promotes via will-change: transform — desktop scroll-lag fix is untouched', () => {
    const baseBlockMatch = css.match(/\.embed-app-hoist \{([\s\S]*?)\n\}/);
    expect(baseBlockMatch?.[1]).toMatch(/will-change:\s*transform/);
  });
});

describe('pickHost — multi-same-url in-view arbitration (regression: duplicate embeds rendered blank)', () => {
  // Minimal SlotEl with a stubbed rect. jsdom has no layout, so we stub
  // getBoundingClientRect directly. window.innerHeight is jsdom's default (768).
  function slot(top: number, over: Partial<SlotEl> = {}): SlotEl {
    return {
      url: 'apps/dup.html',
      height: 320,
      context: 'transcript',
      explicitlyHidden: false,
      trackLatest: true,
      suspended: false,
      elevate: false,
      logicalWidth: null,
      logicalHeight: null,
      el: {
        getBoundingClientRect: () =>
          ({ top, bottom: top + 300, height: 300, width: 400, left: 0, right: 400, x: 0, y: top, toJSON: () => ({}) }) as DOMRect,
      } as unknown as HTMLElement,
      ...over,
    } as SlotEl;
  }

  it('prefers the transcript duplicate currently in the viewport over the first in document order', () => {
    const first = slot(-5000); // scrolled far above → out of view
    const inView = slot(120); // on screen
    expect(pickHost([first, inView])).toBe(inView);
  });

  it('falls back to document order when NO duplicate is in view', () => {
    const first = slot(-5000);
    const second = slot(-3000);
    expect(pickHost([first, second])).toBe(first);
  });

  it('studio and panel contexts still win over an in-view transcript copy', () => {
    const inViewTranscript = slot(120);
    const offscreenPanel = slot(-5000, { context: 'panel' });
    expect(pickHost([inViewTranscript, offscreenPanel])).toBe(offscreenPanel);
    const offscreenStudio = slot(-9000, { context: 'studio' });
    expect(pickHost([inViewTranscript, offscreenPanel, offscreenStudio])).toBe(offscreenStudio);
  });

  it('isInViewport: true on-screen, false scrolled far away', () => {
    const on = { getBoundingClientRect: () => ({ top: 10, bottom: 310, height: 300, width: 400 }) } as unknown as HTMLElement;
    const off = { getBoundingClientRect: () => ({ top: -9999, bottom: -9699, height: 300, width: 400 }) } as unknown as HTMLElement;
    expect(isInViewport(on)).toBe(true);
    expect(isInViewport(off)).toBe(false);
  });
});
