// @vitest-environment jsdom
//
// Phase C, C2: the always-mounted panel app stack — selectLiveAppIds' pure
// cap/wake logic, plus the acceptance-driving end-to-end claim ("3 pinned
// apps, tab switches + reducer reorders + pin/unpin produce ZERO iframe
// reloads; cap 6 live iframes, beyond → oldest non-visible slot suspends").
// Mounted suite wires ArtifactPanelProvider + ArtifactPanel + AppFrameLayer
// together — the same trio a real thread mounts — and uses authFetch call
// count as the reload proxy: each distinct url is fetched exactly once no
// matter how many times its tab/visibility toggles.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react';
import { ArtifactPanel, selectLiveAppIds } from './ArtifactPanel';
import { ArtifactPanelProvider, useArtifactPanel, type OpenArtifactInput } from './ArtifactContext';
import { AppFrameLayer } from './AppFrameLayer';

const authFetchMock = vi.fn();
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, authFetch: (...args: Parameters<typeof actual.authFetch>) => authFetchMock(...args) };
});

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

describe('selectLiveAppIds (pure)', () => {
  it('all ids are live when under cap and nothing woken', () => {
    expect(selectLiveAppIds(['a', 'b', 'c'], new Set(), 6)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('only the first `cap` MRU-ordered ids are live once over cap', () => {
    const mru = ['a7', 'a6', 'a5', 'a4', 'a3', 'a2', 'a1']; // 7 ids, cap 6
    expect(selectLiveAppIds(mru, new Set(), 6)).toEqual(new Set(['a7', 'a6', 'a5', 'a4', 'a3', 'a2']));
  });

  it('a woken id beyond the cap boundary is included regardless of MRU position', () => {
    const mru = ['a7', 'a6', 'a5', 'a4', 'a3', 'a2', 'a1'];
    const live = selectLiveAppIds(mru, new Set(['a1']), 6);
    expect(live.has('a1')).toBe(true);
    expect(live.size).toBe(7);
  });

  it('a woken id for an artifact no longer open is dropped silently', () => {
    const live = selectLiveAppIds(['a', 'b'], new Set(['closed-id']), 6);
    expect(live).toEqual(new Set(['a', 'b']));
  });

  it('does not implicitly live-promote a tab merely for being MRU-front (the actively-open one)', () => {
    // Real coverage of the "no implicit auto-wake" contract lives in the
    // mounted suite below (switching to a suspended tab does not fetch it);
    // this pins the pure-function half — the MRU-front id itself is *only*
    // live because it's within the cap, not because of any active/open bias.
    const mru = ['front', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']; // cap 6 -> 'a7' excluded
    expect(selectLiveAppIds(mru, new Set(), 6).has('a7')).toBe(false);
  });
});

function mockRect(over: Partial<DOMRect>): DOMRect {
  const r = { top: 0, left: 0, width: 400, height: 320, x: 0, y: 0, ...over };
  return { ...r, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
}

describe('ArtifactPanel — C2 always-mounted app stack (mounted, desktop)', () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockNarrow(false);
    authFetchMock.mockReset();
    authFetchMock.mockImplementation((url: string) =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(`<html>${url}</html>`) }),
    );
    // jsdom implements no layout — every real getBoundingClientRect() is
    // 0x0x0x0, which AppFrameLayer's FIX 2 treats as "not present" (see
    // embeds.vitest.ts's identical stub for the full rationale).
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(mockRect({}));
  });
  afterEach(() => {
    cleanup();
    rectSpy.mockRestore();
  });

  function appInput(id: string, pinned = true): OpenArtifactInput {
    return { id, kind: 'app', title: id, content: '', appUrl: `apps/${id}.html`, appHeight: 320, pinned };
  }

  function Api({ onReady }: { onReady: (api: ReturnType<typeof useArtifactPanel>) => void }) {
    const api = useArtifactPanel();
    onReady(api);
    return null;
  }

  function mount() {
    let api!: ReturnType<typeof useArtifactPanel>;
    render(
      createElement(
        ArtifactPanelProvider,
        null,
        createElement(Api, { onReady: (a) => (api = a) }),
        createElement(ArtifactPanel),
        createElement(AppFrameLayer),
      ),
    );
    return () => api;
  }

  it('3 pinned apps: tab switches + reorder-via-reopen cause zero additional fetches', async () => {
    const getApi = mount();

    await act(async () => {
      getApi().open(appInput('app1'));
      getApi().open(appInput('app2'));
      getApi().open(appInput('app3'));
    });

    await screen.findByTitle('apps/app3.html');
    expect(authFetchMock).toHaveBeenCalledTimes(3);

    // Tab switches, both directions.
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'app1' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'app2' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'app3' }));
    });
    expect(authFetchMock).toHaveBeenCalledTimes(3);

    // Reducer reorder: re-opening app1 moves it to MRU-front + activates it.
    await act(async () => {
      getApi().open(appInput('app1'));
    });
    expect(authFetchMock).toHaveBeenCalledTimes(3);

    // All three iframes are still present (always-mounted, never evicted).
    expect(screen.getByTitle('apps/app1.html')).toBeTruthy();
    expect(screen.getByTitle('apps/app2.html')).toBeTruthy();
    expect(screen.getByTitle('apps/app3.html')).toBeTruthy();
  });

  it('beyond the 6-live cap, the oldest (least-recently-opened) app suspends instead of fetching', async () => {
    const getApi = mount();

    await act(async () => {
      for (let i = 1; i <= 7; i++) getApi().open(appInput(`app${i}`));
    });

    // app1 was opened first -> least-recently-used in MRU order -> suspended.
    await screen.findByTitle('apps/app7.html');
    expect(authFetchMock).toHaveBeenCalledTimes(6);
    expect(screen.queryByTitle('apps/app1.html')).toBeNull();

    // Switching to app1's tab does NOT auto-wake it (no implicit fetch).
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'app1' }));
    });
    expect(authFetchMock).toHaveBeenCalledTimes(6);
    // app1 was part of the SAME batched act() as the other 6 opens (React 18
    // collapses same-tick setState calls into one commit), so it never had
    // an interim live render — this is the genuine "never loaded" case, not
    // a demote-from-live case (see the dedicated test below for that one).
    const wakeBtn = screen.getByRole('button', { name: 'tap to open' });
    expect(wakeBtn).toBeTruthy();

    // Tapping the suspended chip wakes it — a user-initiated fetch is allowed.
    await act(async () => {
      fireEvent.click(wakeBtn);
    });
    await screen.findByTitle('apps/app1.html');
    expect(authFetchMock).toHaveBeenCalledTimes(7);
  });

  it('a demoted-from-live app shows "tap to reload" (not "tap to open") and wakes with exactly one re-fetch', async () => {
    const getApi = mount();

    // Pin app1 ALONE first, in its own act(), so it gets a genuine interim
    // live render (React 18 batches same-tick opens into one commit — see
    // the "beyond the 6-live cap" test above, where app1 is opened together
    // with 6 others in a single batch and therefore NEVER goes live at all;
    // this test's separate act() calls are what make app1's live history real).
    await act(async () => {
      getApi().open(appInput('app1'));
    });
    await screen.findByTitle('apps/app1.html');
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    // Pin 6 more, pushing app1 (now the least-recently-opened) past the cap.
    await act(async () => {
      for (let i = 2; i <= 7; i++) getApi().open(appInput(`app${i}`));
    });
    await screen.findByTitle('apps/app7.html');

    // Advance past AppFrameLayer's GRACE_MS (250ms) so the demoted slot's
    // cached html is actually dropped — waking before grace would silently
    // reuse the still-alive slot and produce zero additional fetches,
    // masking the very re-fetch this test exists to prove. Until grace
    // elapses, AppFrameLayer's own hoisted iframe for app1 is still mounted
    // (hidden, not yet evicted) even though ArtifactAppStack already
    // unmounted app1's placeholder — hence the queryByTitle check comes
    // AFTER this wait, not before (unlike the "beyond the 6-live cap" test
    // above, where app1 never went live in the first place and so never had
    // a slot to begin with).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(screen.queryByTitle('apps/app1.html')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'app1' }));
    });
    const wakeBtn = screen.getByRole('button', { name: 'suspended — tap to reload' });
    expect(wakeBtn).toBeTruthy();

    const fetchCountBeforeWake = authFetchMock.mock.calls.length;
    await act(async () => {
      fireEvent.click(wakeBtn);
    });
    await screen.findByTitle('apps/app1.html');
    expect(authFetchMock.mock.calls.length - fetchCountBeforeWake).toBe(1);
  });

  it('non-app artifacts (code/skill) render their existing body, not the app stack', async () => {
    const getApi = mount();
    await act(async () => {
      getApi().open({ id: 'c1', kind: 'code', title: 'c1', language: 'ts', content: 'const x = 1;' });
    });
    expect(document.querySelector('.artifact-app-stack')).toBeNull();
    expect(document.querySelector('.artifact-pre')).toBeTruthy();
  });
});

describe('ArtifactPanel — C2 always-mounted app stack (mounted, mobile sheet)', () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockNarrow(true);
    authFetchMock.mockReset();
    authFetchMock.mockImplementation((url: string) =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(`<html>${url}</html>`) }),
    );
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(mockRect({}));
  });
  afterEach(() => {
    cleanup();
    rectSpy.mockRestore();
  });

  function Api({ onReady }: { onReady: (api: ReturnType<typeof useArtifactPanel>) => void }) {
    const api = useArtifactPanel();
    onReady(api);
    return null;
  }

  it('the mobile sheet also renders the always-mounted app stack, suppressing ArtifactBody for the app tab', async () => {
    let api!: ReturnType<typeof useArtifactPanel>;
    render(
      createElement(
        ArtifactPanelProvider,
        null,
        createElement(Api, { onReady: (a) => (api = a) }),
        createElement(ArtifactPanel),
        createElement(AppFrameLayer),
      ),
    );

    await act(async () => {
      api.open({ id: 'app1', kind: 'app', title: 'app1', content: '', appUrl: 'apps/app1.html', appHeight: 320, pinned: true });
    });

    expect(document.querySelector('[data-mode="sheet"]')).toBeTruthy();
    await screen.findByTitle('apps/app1.html');
    expect(document.querySelector('.artifact-app-stack')).toBeTruthy();
    expect(document.querySelector('.artifact-pre')).toBeNull();
  });
});
