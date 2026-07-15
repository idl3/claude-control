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
import { render, cleanup, screen, fireEvent, act, waitFor } from '@testing-library/react';
import {
  ArtifactPanel,
  selectLiveAppIds,
  loadAppTabVersion,
  saveAppTabVersion,
  effectiveAppUrl,
} from './ArtifactPanel';
import { ArtifactPanelProvider, useArtifactPanel, type Artifact, type OpenArtifactInput } from './ArtifactContext';
import { AppFrameLayer } from './AppFrameLayer';
import { EmbeddedApp } from './EmbeddedApp';

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

// D4: this Node/vitest/jsdom combo runs with Node's own experimental global
// `localStorage` (see the `--localstorage-file` warning at test-run time)
// shadowing jsdom's — and that global stub implements neither getItem nor
// setItem. No existing test in this repo ever exercised bare `localStorage`
// (App.tsx's loadDrafts/saveDrafts included) so nothing caught this before
// D4. Stub a minimal real Storage in-memory so loadAppTabVersion/
// saveAppTabVersion — which use bare `localStorage`, matching App.tsx's own
// established convention — are actually exercised, not just silently
// swallowed by their own try/catch. Scoped to this file only.
class FakeLocalStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  key(i: number): string | null {
    return Array.from(this.store.keys())[i] ?? null;
  }
  get length(): number {
    return this.store.size;
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new FakeLocalStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe('ArtifactPanel — session-specific panels (mounted, desktop)', () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockNarrow(false);
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

  function appInput(id: string, pinned = true): OpenArtifactInput {
    return { id, kind: 'app', title: id, content: '', appUrl: `apps/${id}.html`, appHeight: 320, pinned };
  }

  function Api({ onReady }: { onReady: (api: ReturnType<typeof useArtifactPanel>) => void }) {
    const api = useArtifactPanel();
    onReady(api);
    return null;
  }

  // Mirrors this file's own `mount()` but with a controllable `sessionId`
  // prop, so a "session switch" is driven the same way App.tsx experiences
  // one — the SAME long-lived `<ArtifactPanelProvider>` instance rerendered
  // with a new `sessionId`, never remounted (see ArtifactContext.vitest.ts's
  // `setupSession` for the identical pattern one layer down, without the
  // rendered ArtifactPanel/AppFrameLayer chrome).
  function mountSession(sessionId: string | null) {
    let api!: ReturnType<typeof useArtifactPanel>;
    const tree = (sid: string | null) =>
      createElement(
        ArtifactPanelProvider,
        { sessionId: sid },
        createElement(Api, { onReady: (a) => (api = a) }),
        createElement(ArtifactPanel),
        createElement(AppFrameLayer),
      );
    const view = render(tree(sessionId));
    return { getApi: () => api, switchTo: (sid: string | null) => view.rerender(tree(sid)) };
  }

  it('a pinned app opened in session A shows the panel; switching to an empty session B hides it entirely (no dock/sheet chrome), and A\'s app is gone; switching back to A restores it, still pinned', async () => {
    const { getApi, switchTo } = mountSession('session-a');

    await act(async () => {
      getApi().open(appInput('proto1'));
    });
    await screen.findByTitle('apps/proto1.html');
    expect(screen.getByRole('region', { name: 'Artifact panel' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'proto1' })).toBeTruthy();

    // Switch to a session with nothing open — the panel's dock/sheet chrome
    // disappears entirely (ArtifactPanel's own `if (!isOpen) return null`,
    // unchanged, now correctly sees session B's empty slice). Session A's app
    // iframe is no longer a "genuinely present" placeholder for AppFrameLayer
    // to find, so it ages out through the layer's normal GRACE_MS (250ms
    // real-time rAF loop, see AppFrameLayer.tsx) eviction path — the same
    // path a truly-removed placeholder takes; not synchronous, hence waitFor.
    switchTo('session-b');
    expect(screen.queryByRole('region', { name: 'Artifact panel' })).toBeNull();
    await waitFor(() => expect(screen.queryByTitle('apps/proto1.html')).toBeNull());

    // Switch back: session A's panel reappears with the same pinned app on
    // the same tab. (Its iframe reloads — the documented, accepted
    // cross-session exception — but the tab/pin state is exactly restored.)
    switchTo('session-a');
    expect(screen.getByRole('region', { name: 'Artifact panel' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'proto1' })).toBeTruthy();
    await screen.findByTitle('apps/proto1.html');
    expect(getApi().artifacts.find((a) => a.id === 'proto1')?.pinned).toBe(true);
  });

  it('two sessions keep fully independent open-artifact sets — switching never bleeds one session\'s tabs into the other', async () => {
    const { getApi, switchTo } = mountSession('session-a');
    await act(async () => {
      getApi().open(appInput('app-a'));
    });
    expect(screen.getByRole('tab', { name: 'app-a' })).toBeTruthy();

    switchTo('session-b');
    expect(screen.queryByRole('tab', { name: 'app-a' })).toBeNull();
    await act(async () => {
      getApi().open(appInput('app-b'));
    });
    expect(screen.getByRole('tab', { name: 'app-b' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'app-a' })).toBeNull();

    switchTo('session-a');
    expect(screen.getByRole('tab', { name: 'app-a' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'app-b' })).toBeNull();
  });
});

describe('H2 (Codex review): a cap-suspended pinned app never falls back to hosting in a still-mounted transcript placeholder (mounted)', () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockNarrow(false);
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
        // A live transcript placeholder for app1's url — simulating the
        // transcript still showing the original <embedded-app> tag near
        // where the app was pinned from. This is the placeholder host
        // arbitration wrongly fell back to hosting in, pre-fix, once app1
        // got cap-suspended in the panel.
        createElement(EmbeddedApp, { url: 'apps/app1.html', height: 320, context: 'transcript' }),
        createElement(ArtifactPanel),
        createElement(AppFrameLayer),
      ),
    );
    return () => api;
  }

  it('bars hosting everywhere once suspended; the transcript shows a "suspended in panel" chip, not a live iframe; wake resumes normal hosting', async () => {
    const getApi = mount();

    // Transcript-only host, the ordinary single-placeholder case, settles first.
    await screen.findByTitle('apps/app1.html');
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    // Pin 7 apps in one batch — app1 (opened first, least-recently-used in
    // MRU order) never goes live on the panel side and is cap-suspended the
    // instant its marker mounts, exactly like the pre-existing "beyond the
    // 6-live cap" test, except this time a live transcript placeholder for
    // the SAME url is already hosting when the marker appears.
    await act(async () => {
      for (let i = 1; i <= 7; i++) getApi().open(appInput(`app${i}`));
    });
    await screen.findByTitle('apps/app7.html');
    expect(authFetchMock).toHaveBeenCalledTimes(1 + 6); // app1 never re-fetched via the panel

    // Past AppFrameLayer's GRACE_MS (250ms) + margin, the previously-hosting
    // transcript slot must have been evicted — the bug this fixes let it
    // silently keep hosting the live iframe there forever.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(screen.queryByTitle('apps/app1.html')).toBeNull();
    expect(authFetchMock).toHaveBeenCalledTimes(1 + 6);

    // The transcript placeholder now shows the relabeled chip instead.
    expect(screen.getByRole('button', { name: 'suspended in panel' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'open in panel ↗' })).toBeNull();

    // Waking removes the suspension marker (ArtifactAppStack swaps back to a
    // live EmbeddedApp) — normal host arbitration resumes with a fresh fetch.
    const wakeBtn = screen.getByRole('button', { name: 'tap to open' });
    await act(async () => {
      fireEvent.click(wakeBtn);
    });
    await screen.findByTitle('apps/app1.html');
    expect(authFetchMock).toHaveBeenCalledTimes(1 + 6 + 1);
  });
});

describe('M2 (Codex review): wokenIds/everLiveIds are pruned on close, so a re-pin of the same id always requires a fresh wake gesture (mounted)', () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockNarrow(false);
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

  it('closing a woken, cap-suspended app then re-pinning the same id (pushed beyond cap again) shows a fresh "tap to open", not a stale live iframe or "tap to reload"', async () => {
    const getApi = mount();

    // app1..app7 in one batch -> app1 (opened first) is cap-suspended, same
    // setup as the pre-existing "beyond the 6-live cap" test.
    await act(async () => {
      for (let i = 1; i <= 7; i++) getApi().open(appInput(`app${i}`));
    });
    await screen.findByTitle('apps/app7.html');
    expect(screen.queryByTitle('apps/app1.html')).toBeNull();

    // Wake app1 -> live, and (via the everLiveIds effect) marked ever-live.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'tap to open' }));
    });
    await screen.findByTitle('apps/app1.html');

    // Close EVERY open app (app1 plus the other 6 that were live) -> the
    // artifacts array is empty again, so the next batch's MRU math below
    // isn't muddied by app2-7's own (legitimate, unrelated) demotion.
    await act(async () => {
      for (let i = 1; i <= 7; i++) getApi().close(`app${i}`);
    });
    // AppFrameLayer's own hoisted iframe is grace-gated (GRACE_MS=250ms), not
    // torn down the instant the placeholder unmounts — same as the
    // pre-existing "demoted-from-live" test above.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(screen.queryByTitle('apps/app1.html')).toBeNull();

    // Re-pin app1, then open 6 BRAND-NEW apps in the SAME batch right after
    // it, reproducing the exact "beyond the 6-live cap" shape (first-opened
    // in a batch = least-recently-used in that batch = suspended) with app1
    // as the one that lands beyond the cap boundary — purely by MRU
    // freshness, not by anything left over from before. Whether app1 shows
    // live/suspended, and which suspended label it uses, therefore depends
    // ONLY on stale vs. pruned wokenIds/everLiveIds membership from before
    // the close above.
    await act(async () => {
      getApi().open(appInput('app1'));
      for (let i = 8; i <= 13; i++) getApi().open(appInput(`app${i}`));
    });
    await screen.findByTitle('apps/app13.html');

    // Without pruning: stale wokenIds would force app1 live here regardless
    // of cap position (an unrequested auto-fetch); stale everLiveIds would
    // show "suspended — tap to reload" instead of the honest "tap to open"
    // for what is, from the user's perspective, a brand-new pin. app8-13
    // never went live before either, so they'd also show "tap to open" if
    // suspended — but they're all within the 6-live cap here, so app1's
    // button is the only suspended one in the DOM.
    expect(screen.queryByTitle('apps/app1.html')).toBeNull();
    expect(screen.getByRole('button', { name: 'tap to open' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'suspended — tap to reload' })).toBeNull();
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

  // Mobile fix: the sheet must open full-screen (SNAP_MOBILE_OPEN = 100dvh),
  // not the cramped 40dvh peek — a fresh open should read as a real
  // dismissible full-screen view, not a sliver at the bottom of the screen.
  it('opens at 100dvh (full screen) by default, not the 40dvh peek', async () => {
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

    const sheet = document.querySelector('[data-mode="sheet"]') as HTMLElement;
    expect(sheet).toBeTruthy();
    expect(sheet.style.height).toBe('100dvh');
  });
});

// ── D4: per-tab version pin / track-latest picker ───────────────────────────

function art(appUrl?: string): Artifact {
  return { id: 'x', kind: 'app', title: 'x', content: '', appUrl, appHeight: 320, pinned: true };
}

describe('D4: loadAppTabVersion / saveAppTabVersion (pure, localStorage)', () => {
  // File-level beforeEach (above) already gives each test a fresh FakeLocalStorage.

  it('defaults to latest when nothing is persisted', () => {
    expect(loadAppTabVersion('never-saved')).toEqual({ kind: 'latest' });
  });

  it('round-trips a pinned mode through localStorage', () => {
    saveAppTabVersion('tabA', { kind: 'pinned', filename: '2026-07-08T23-32-05Z.html' });
    expect(loadAppTabVersion('tabA')).toEqual({ kind: 'pinned', filename: '2026-07-08T23-32-05Z.html' });
    // A different artifact id never sees another tab's pin.
    expect(loadAppTabVersion('tabB')).toEqual({ kind: 'latest' });
  });

  it('falls back to latest on corrupt/unparsable persisted JSON', () => {
    localStorage.setItem('cc_app_tab_version:tabC', '{not json');
    expect(loadAppTabVersion('tabC')).toEqual({ kind: 'latest' });
  });

  it('falls back to latest on a well-formed but malformed-shape value', () => {
    localStorage.setItem('cc_app_tab_version:tabD', JSON.stringify({ kind: 'pinned' })); // no filename
    expect(loadAppTabVersion('tabD')).toEqual({ kind: 'latest' });
  });
});

describe('D4: effectiveAppUrl (pure)', () => {
  it('latest mode always resolves to the artifact\'s own appUrl, trackLatest on', () => {
    expect(effectiveAppUrl(art('apps/widget.html'), { kind: 'latest' })).toEqual({
      url: 'apps/widget.html',
      trackLatest: true,
    });
  });

  it('pinned mode resolves to the concrete versioned url, trackLatest off', () => {
    expect(effectiveAppUrl(art('apps/widget.html'), { kind: 'pinned', filename: '2026-07-08T23-32-05Z.html' })).toEqual({
      url: 'apps/widget/2026-07-08T23-32-05Z.html',
      trackLatest: false,
    });
  });

  it('pinned mode on an already-versioned appUrl still resolves off the app name, not the current file', () => {
    expect(
      effectiveAppUrl(art('apps/widget/2026-07-01T10-00-00Z.html'), { kind: 'pinned', filename: 'v2.html' }),
    ).toEqual({ url: 'apps/widget/v2.html', trackLatest: false });
  });

  it('pinned mode safely falls back to latest behavior when the appUrl is not a recognizable media-apps url', () => {
    expect(effectiveAppUrl(art('https://example.com/x.html'), { kind: 'pinned', filename: 'v1.html' })).toEqual({
      url: 'https://example.com/x.html',
      trackLatest: true,
    });
  });

  it('handles a missing appUrl (defensive — should never happen for a real app artifact)', () => {
    expect(effectiveAppUrl(art(undefined), { kind: 'latest' })).toEqual({ url: '', trackLatest: true });
  });
});

describe('D4: version picker + pin/track-latest (mounted, desktop)', () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockNarrow(false);
    authFetchMock.mockReset();
    authFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/media-apps/')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              name: 'widget',
              versions: [
                { filename: 'v1.html', version: 'v1', label: null, url: 'apps/widget/v1.html', latest: false },
              ],
              latest: 'v2.html',
            }),
        });
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve(`<html>${url}</html>`) });
    });
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
      (() => {
        const r = { top: 0, left: 0, width: 400, height: 320, x: 0, y: 0 };
        return { ...r, right: r.width, bottom: r.height, toJSON: () => r } as DOMRect;
      })(),
    );
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

  it('acceptance: pin v1 via the picker, then a rebuild-latest frame leaves the pinned tab untouched while a sibling latest-mode tab reloads', async () => {
    const getApi = mount();

    // A pinned mode set BEFORE mount (mirrors a persisted pin from a prior
    // session) so 'tabPin' opens directly on v1 — 'tabLatest' opens on the
    // flat/latest url and stays there throughout.
    saveAppTabVersion('tabPin', { kind: 'pinned', filename: 'v1.html' });

    await act(async () => {
      getApi().open({ id: 'tabLatest', kind: 'app', title: 'widget latest', content: '', appUrl: 'apps/widget.html', appHeight: 320, pinned: true });
      getApi().open({ id: 'tabPin', kind: 'app', title: 'widget v1', content: '', appUrl: 'apps/widget.html', appHeight: 320, pinned: true });
    });

    await screen.findByTitle('apps/widget/v1.html');
    await screen.findByTitle('apps/widget.html');
    expect(authFetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('cockpit:media-app-changed', { detail: { path: 'apps/widget.html', mtime: 111 } }),
      );
    });

    // tabLatest reloads (one more fetch); tabPin's own url never matches the
    // frame's path AND has trackLatest off, so it is untouched either way.
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(3));
    expect(screen.getByTitle('apps/widget/v1.html')).toBeTruthy();
    expect(screen.getByTitle('apps/widget.html')).toBeTruthy();
  });

  it('the version picker fetches lazily on first focus, then pinning a version through it swaps the tab to the versioned url', async () => {
    const getApi = mount();

    await act(async () => {
      getApi().open({ id: 'tabA', kind: 'app', title: 'widget', content: '', appUrl: 'apps/widget.html', appHeight: 320, pinned: true });
    });
    await screen.findByTitle('apps/widget.html');
    expect(authFetchMock).toHaveBeenCalledTimes(1); // iframe only — no eager versions probe

    const select = screen.getByLabelText('App version') as HTMLSelectElement;
    fireEvent.focus(select);
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2)); // versions probe, on focus

    await screen.findByRole('option', { name: 'v1' });
    fireEvent.change(select, { target: { value: 'v1.html' } });

    await screen.findByTitle('apps/widget/v1.html');
    expect(authFetchMock).toHaveBeenCalledTimes(3); // new url -> new fetch
    expect(loadAppTabVersion('tabA')).toEqual({ kind: 'pinned', filename: 'v1.html' });
  });

  it('M1 (Codex review): a stale version-listing response for a since-abandoned tab must not overwrite the current tab\'s listing', async () => {
    const getApi = mount();

    // Two DIFFERENT app names, so each gets its own /api/media-apps/<name>/versions
    // url — the race is real, not just two requests for the same url.
    await act(async () => {
      getApi().open({ id: 'tabA', kind: 'app', title: 'a', content: '', appUrl: 'apps/app-a.html', appHeight: 320, pinned: true });
      getApi().open({ id: 'tabB', kind: 'app', title: 'b', content: '', appUrl: 'apps/app-b.html', appHeight: 320, pinned: true });
    });
    await screen.findByTitle('apps/app-b.html'); // tabB opened last -> active

    let resolveA: (v: unknown) => void = () => {};
    let resolveB: (v: unknown) => void = () => {};
    const pendingA = new Promise((resolve) => {
      resolveA = resolve;
    });
    const pendingB = new Promise((resolve) => {
      resolveB = resolve;
    });
    authFetchMock.mockImplementation((url: string) => {
      if (url === '/api/media-apps/app-a/versions') return pendingA;
      if (url === '/api/media-apps/app-b/versions') return pendingB;
      return Promise.resolve({ ok: true, text: () => Promise.resolve(`<html>${url}</html>`) });
    });

    // Focus the picker while tabB (app-b) is active -> launches fetch B.
    const select = () => screen.getByLabelText('App version') as HTMLSelectElement;
    fireEvent.focus(select());

    // Switch to tabA BEFORE B resolves. The [name] reset effect clears
    // fetchedForRef + listing; focusing again launches fetch A for app-a.
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'a' }));
    });
    fireEvent.focus(select());

    // Resolve B (the older, now-abandoned request) with app-b's data.
    await act(async () => {
      resolveB({
        ok: true,
        json: () =>
          Promise.resolve({ name: 'app-b', versions: [{ filename: 'bv1.html', version: 'bv1', label: null, url: 'apps/app-b/bv1.html', latest: false }], latest: null }),
      });
    });
    // Must NOT land: the picker is showing tabA now, and must never briefly
    // (or permanently) offer app-b's version as an option for app-a's tab.
    expect(screen.queryByRole('option', { name: 'bv1' })).toBeNull();

    // Resolve A (the current request) with app-a's data — this one must land.
    await act(async () => {
      resolveA({
        ok: true,
        json: () =>
          Promise.resolve({ name: 'app-a', versions: [{ filename: 'av1.html', version: 'av1', label: null, url: 'apps/app-a/av1.html', latest: false }], latest: null }),
      });
    });
    await screen.findByRole('option', { name: 'av1' });
    expect(screen.queryByRole('option', { name: 'bv1' })).toBeNull();
  });
});
