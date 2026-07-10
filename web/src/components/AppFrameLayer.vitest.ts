// @vitest-environment jsdom
//
// jsdom is needed only for the mounted rAF-gating test at the bottom — the
// computePaneClip/shouldKeepPolling suites above it are pure, DOM-free
// functions and would pass equally under the bare 'node' environment.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, cleanup, screen, act, waitFor } from '@testing-library/react';
import {
  AppFrameLayer,
  computePaneClip,
  clampChromeInsets,
  shouldKeepPolling,
  shouldReloadOnFrame,
  hoistTransform,
  hoistClipPath,
  shouldElevateHoist,
  nextScrollStreak,
  shouldEngageScrollFade,
  shouldFadeSlot,
  type RectLike,
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

describe('Fade-during-scroll: opacity fade + placeholder skeleton (mounted)', () => {
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
  // extends the same streak rather than starting a new one.
  function fireScrolls(n: number, topStep = 20) {
    for (let i = 0; i < n; i++) {
      currentTop += topStep;
      window.dispatchEvent(new Event('scroll'));
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
