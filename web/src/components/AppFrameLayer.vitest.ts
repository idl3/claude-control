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

  it('ignores a frame for a different url (slotFramePath mismatch)', () => {
    expect(shouldReloadOnFrame(panelSlot, 'apps/other.html', frame)).toBe(false);
  });

  it('ignores a frame when this slot url does not resolve to a media-root fetch path', () => {
    expect(shouldReloadOnFrame(panelSlot, null, frame)).toBe(false);
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
