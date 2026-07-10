// @vitest-environment jsdom
//
// Phase C, C1: pin semantics + LRU pin-exemption on ArtifactPanelProvider's
// reducer. Drives the reducer only through the public hook surface
// (open/setActive/close — pin/unpin were removed in CP3-C, see
// ArtifactContext.tsx's pinned-field doc comment; pinning goes through
// open({pinned:true}), unpinning through close()) via renderHook + act,
// mirroring useCockpit.vitest.ts's pattern — no reducer internals are
// imported directly, so these tests exercise exactly what real callers
// (ToolPart, CodeHeader, the C3 pin affordance) can do.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, render, cleanup, act } from '@testing-library/react';
import { createElement } from 'react';
import {
  ArtifactPanelProvider,
  useArtifactPanel,
  loadSessionPanels,
  saveSessionPanels,
  type OpenArtifactInput,
} from './ArtifactContext';

function setup() {
  return renderHook(() => useArtifactPanel(), { wrapper: ArtifactPanelProvider });
}

function codeArtifact(id: string): OpenArtifactInput {
  return { id, kind: 'code', title: id, language: 'ts', content: `content-${id}` };
}

function appArtifact(id: string, pinned?: boolean): OpenArtifactInput {
  return { id, kind: 'app', title: id, content: '', appUrl: `apps/${id}.html`, appHeight: 320, pinned };
}

// D4/session-scoping note (see ArtifactPanel.vitest.ts's identical stub): the
// Node/vitest/jsdom combo this repo runs on shadows jsdom's `localStorage`
// with Node's own experimental global, which implements neither getItem nor
// setItem — so persistence round-trips need a real, in-memory Storage stub.
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

/**
 * Session-scoped setup. NOTE: renderHook's `wrapper` option in this RTL
 * version always mounts the wrapper with `null` props (only `children` is
 * forwarded) — `initialProps`/rerender props reach the *render callback*
 * only, never a custom `wrapper` component. So a changing `sessionId` prop
 * can't be driven through renderHook's wrapper mechanism; instead this
 * mounts `ArtifactPanelProvider` directly via `render()` (mirroring
 * ArtifactPanel.vitest.ts's own `Api`-capture-component pattern) and drives
 * session switches via `rerender()` with a NEW `sessionId` prop on the SAME
 * element type/position — React keeps the provider's internal state across
 * that rerender rather than remounting it, exactly mirroring how App.tsx's
 * single long-lived `<ArtifactPanelProvider>` instance experiences
 * `cockpit.selectedId` changing over time.
 */
function Api({ onReady }: { onReady: (api: ReturnType<typeof useArtifactPanel>) => void }) {
  const api = useArtifactPanel();
  onReady(api);
  return null;
}

function setupSession(sessionId: string | null) {
  // A stable ref-like object (mirrors renderHook's `result`) — `.current` is
  // reassigned by `Api`'s `onReady` on every render, but the object identity
  // stays the same across rerenders so callers can destructure `result` once
  // and keep reading `result.current` for the freshest value.
  const result: { current: ReturnType<typeof useArtifactPanel> } = {
    current: null as unknown as ReturnType<typeof useArtifactPanel>,
  };
  const tree = (sid: string | null) =>
    createElement(ArtifactPanelProvider, { sessionId: sid }, createElement(Api, { onReady: (a) => (result.current = a) }));
  const view = render(tree(sessionId));
  return {
    result,
    rerender: (nextProps: { sessionId: string | null }) => view.rerender(tree(nextProps.sessionId)),
    unmount: view.unmount,
  };
}

describe('ArtifactContext — open/re-open/close (pre-existing behavior, unchanged)', () => {
  it('open() prepends a new artifact and activates it', () => {
    const { result } = setup();
    act(() => result.current.open(codeArtifact('a')));
    expect(result.current.artifacts.map((a) => a.id)).toEqual(['a']);
    expect(result.current.activeId).toBe('a');

    act(() => result.current.open(codeArtifact('b')));
    expect(result.current.artifacts.map((a) => a.id)).toEqual(['b', 'a']);
    expect(result.current.activeId).toBe('b');
  });

  it('re-opening an existing artifact moves it to front and activates it, without reordering the rest', () => {
    const { result } = setup();
    act(() => {
      result.current.open(codeArtifact('a'));
      result.current.open(codeArtifact('b'));
      result.current.open(codeArtifact('c'));
    });
    expect(result.current.artifacts.map((a) => a.id)).toEqual(['c', 'b', 'a']);

    act(() => result.current.open(codeArtifact('a')));
    expect(result.current.artifacts.map((a) => a.id)).toEqual(['a', 'c', 'b']);
    expect(result.current.activeId).toBe('a');
  });

  it('close() removes an artifact and selects a neighbour', () => {
    const { result } = setup();
    act(() => {
      result.current.open(codeArtifact('a'));
      result.current.open(codeArtifact('b'));
      result.current.open(codeArtifact('c'));
    });
    // active is 'c' (front). Close the active one -> neighbour at same index.
    act(() => result.current.close('c'));
    expect(result.current.artifacts.map((a) => a.id)).toEqual(['b', 'a']);
    expect(result.current.activeId).toBe('b');
  });
});

describe('ArtifactContext — C1: pinned defaults + basic pin/unpin', () => {
  it('artifacts default to pinned: false when open() omits the field', () => {
    const { result } = setup();
    act(() => result.current.open(codeArtifact('a')));
    expect(result.current.artifacts[0].pinned).toBe(false);
  });

  it('open({ pinned: true }) opens an artifact already pinned', () => {
    const { result } = setup();
    act(() => result.current.open(appArtifact('app1', true)));
    expect(result.current.artifacts[0].pinned).toBe(true);
  });

  it('re-opening a still-open artifact with pinned:true re-pins it (the C3 re-click case)', () => {
    const { result } = setup();
    act(() => result.current.open(appArtifact('app1', true)));
    act(() => result.current.open(appArtifact('app1', false)));
    expect(result.current.artifacts[0].pinned).toBe(false);

    act(() => result.current.open(appArtifact('app1', true)));
    expect(result.current.artifacts[0].pinned).toBe(true);
  });

  it('re-opening without an explicit pinned field preserves the existing pinned state', () => {
    const { result } = setup();
    act(() => result.current.open(appArtifact('app1', true)));
    // Re-open via a caller that never thinks about pinning (no `pinned` key at all).
    act(() => result.current.open({ id: 'app1', kind: 'app', title: 'app1', content: '' }));
    expect(result.current.artifacts[0].pinned).toBe(true);
  });
});

describe('ArtifactContext — C1: LRU pin-exemption', () => {
  it('opening 9 unpinned artifacts evicts the least-recently-used one at the 8-cap', () => {
    const { result } = setup();
    act(() => {
      for (let i = 0; i < 9; i++) result.current.open(codeArtifact(`u${i}`));
    });
    expect(result.current.artifacts).toHaveLength(8);
    // u0 was opened first (oldest) -> evicted; u1..u8 survive, most-recent-first.
    expect(result.current.artifacts.map((a) => a.id)).not.toContain('u0');
    expect(result.current.artifacts[0].id).toBe('u8');
  });

  it('a pinned artifact survives 9+ subsequent unpinned opens (never evicted by the cap)', () => {
    const { result } = setup();
    act(() => result.current.open(appArtifact('pinned1', true)));
    act(() => {
      for (let i = 0; i < 12; i++) result.current.open(codeArtifact(`u${i}`));
    });
    const ids = result.current.artifacts.map((a) => a.id);
    expect(ids).toContain('pinned1');
    // 8 unpinned survive (cap) + the 1 pinned, unaffected by count of unpinned opens.
    expect(ids).toHaveLength(9);
    const pinnedEntry = result.current.artifacts.find((a) => a.id === 'pinned1');
    expect(pinnedEntry?.pinned).toBe(true);
  });

  it('multiple pinned artifacts all survive regardless of open order or count', () => {
    const { result } = setup();
    act(() => {
      result.current.open(appArtifact('p1', true));
      result.current.open(appArtifact('p2', true));
      result.current.open(appArtifact('p3', true));
    });
    act(() => {
      for (let i = 0; i < 10; i++) result.current.open(codeArtifact(`u${i}`));
    });
    const ids = result.current.artifacts.map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['p1', 'p2', 'p3']));
    expect(ids).toHaveLength(11); // 3 pinned + 8 unpinned (cap)
  });

  it('close() removes a pinned artifact outright, regardless of pin state', () => {
    const { result } = setup();
    act(() => result.current.open(appArtifact('p1', true)));
    expect(result.current.artifacts.map((a) => a.id)).toContain('p1');

    act(() => result.current.close('p1'));
    expect(result.current.artifacts.map((a) => a.id)).not.toContain('p1');
  });
});

describe('ArtifactContext — session-scoping (one provider instance, sessionId prop changes)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new FakeLocalStorage());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('opening an app in session A is invisible from session B; switching back to A restores it, still pinned', () => {
    const { result, rerender } = setupSession('A');
    act(() => result.current.open(appArtifact('proto1', true)));
    expect(result.current.artifacts.map((a) => a.id)).toEqual(['proto1']);
    expect(result.current.activeId).toBe('proto1');

    // Switch to session B: a fresh, empty slice — A's artifact must not leak.
    rerender({ sessionId: 'B' });
    expect(result.current.artifacts).toEqual([]);
    expect(result.current.activeId).toBeNull();

    // B opens its own, unrelated artifact.
    act(() => result.current.open(codeArtifact('b-code')));
    expect(result.current.artifacts.map((a) => a.id)).toEqual(['b-code']);

    // Switch back to A: proto1 is restored exactly as left, still pinned.
    rerender({ sessionId: 'A' });
    expect(result.current.artifacts.map((a) => a.id)).toEqual(['proto1']);
    expect(result.current.artifacts[0].pinned).toBe(true);
    expect(result.current.activeId).toBe('proto1');
  });

  it('a session with nothing open reads as the same empty slice as no session at all', () => {
    const { result } = setupSession(null);
    expect(result.current.artifacts).toEqual([]);
    expect(result.current.activeId).toBeNull();
  });

  it('LRU cap + pin exemption are scoped per session — 9 opens in A do not evict or reorder B\'s artifacts', () => {
    const { result, rerender } = setupSession('B');
    act(() => {
      result.current.open(codeArtifact('b1'));
      result.current.open(codeArtifact('b2'));
      result.current.open(appArtifact('b-pinned', true));
    });
    expect(result.current.artifacts.map((a) => a.id)).toEqual(['b-pinned', 'b2', 'b1']);

    rerender({ sessionId: 'A' });
    act(() => {
      for (let i = 0; i < 9; i++) result.current.open(codeArtifact(`a${i}`));
    });
    // A's own 8-cap applies, independent of B's 3 open artifacts.
    expect(result.current.artifacts).toHaveLength(8);
    expect(result.current.artifacts.map((a) => a.id)).not.toContain('a0');

    // B's slice is byte-for-byte unaffected by A's 9 opens.
    rerender({ sessionId: 'B' });
    expect(result.current.artifacts.map((a) => a.id)).toEqual(['b-pinned', 'b2', 'b1']);
    expect(result.current.artifacts.find((a) => a.id === 'b-pinned')?.pinned).toBe(true);
  });

  it('setActive/close on the current session never touch another session\'s slice', () => {
    const { result, rerender } = setupSession('A');
    act(() => {
      result.current.open(codeArtifact('a1'));
      result.current.open(codeArtifact('a2'));
    });

    rerender({ sessionId: 'B' });
    act(() => result.current.open(codeArtifact('b1')));

    rerender({ sessionId: 'A' });
    act(() => result.current.setActive('a1'));
    act(() => result.current.close('a2'));
    expect(result.current.artifacts.map((a) => a.id)).toEqual(['a1']);

    rerender({ sessionId: 'B' });
    expect(result.current.artifacts.map((a) => a.id)).toEqual(['b1']);
  });
});

describe('ArtifactContext — persistence (localStorage round-trip)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new FakeLocalStorage());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('a fresh provider instance rehydrates a pinned app artifact opened by a previous instance', () => {
    const first = setupSession('A');
    act(() => first.result.current.open(appArtifact('proto1', true)));
    // Let the persistence effect flush.
    expect(loadSessionPanels().A?.artifacts.map((a) => a.id)).toEqual(['proto1']);
    first.unmount();

    // A brand-new provider instance (simulating a hard reload) for the same session id.
    const second = setupSession('A');
    expect(second.result.current.artifacts.map((a) => a.id)).toEqual(['proto1']);
    expect(second.result.current.artifacts[0].pinned).toBe(true);
    expect(second.result.current.activeId).toBe('proto1');
  });

  it('code/tool/skill artifacts are session-memory-only: a fresh instance does not rehydrate them', () => {
    const first = setupSession('A');
    act(() => first.result.current.open(codeArtifact('some-code')));
    expect(loadSessionPanels().A).toBeUndefined();
    first.unmount();

    const second = setupSession('A');
    expect(second.result.current.artifacts).toEqual([]);
  });

  it('a session with only non-app artifacts is dropped from storage entirely, not kept as an empty entry', () => {
    const { result } = setupSession('A');
    act(() => result.current.open(codeArtifact('some-code')));
    expect(loadSessionPanels()).toEqual({});
  });

  it('the active tab falls back to a persisted artifact when the live-active tab was a non-persisted kind', () => {
    const { result } = setupSession('A');
    act(() => result.current.open(appArtifact('proto1', true)));
    act(() => result.current.open(codeArtifact('some-code')));
    expect(result.current.activeId).toBe('some-code');

    // Persisted slice must not carry an activeId pointing at the dropped 'code' artifact.
    expect(loadSessionPanels().A).toEqual({ artifacts: [{ ...appArtifact('proto1', true), pinned: true }], activeId: 'proto1' });
  });

  it('malformed/corrupt persisted JSON is ignored, not thrown', () => {
    localStorage.setItem('cc:session-panels', '{not valid json');
    expect(loadSessionPanels()).toEqual({});
    const { result } = setupSession('A');
    expect(result.current.artifacts).toEqual([]);
  });

  it('saveSessionPanels/loadSessionPanels round-trip directly (pure)', () => {
    const shape = { A: { artifacts: [{ ...appArtifact('p1', true), pinned: true }], activeId: 'p1' } };
    saveSessionPanels(shape);
    expect(loadSessionPanels()).toEqual(shape);
  });

  it('a provider mounted with no sessionId (or null) never persists — the no-session bucket cannot leak across mounts/tests', () => {
    // Regression: a real (non-broken) localStorage previously let every
    // no-sessionId mount in this suite rehydrate the PRIOR no-sessionId
    // mount's pinned apps, inflating the LRU-cap tests' counts by however
    // many artifacts an earlier `it()` had left behind — reproduced only in
    // environments where bare `localStorage` actually works (this repo's
    // local dev Node shadow silently no-ops instead, which is why it passed
    // here but failed in CI). No-session mounts must never touch storage.
    const first = setupSession(null);
    act(() => first.result.current.open(appArtifact('leaky', true)));
    expect(loadSessionPanels()).toEqual({});
    first.unmount();

    const second = setupSession(null);
    expect(second.result.current.artifacts).toEqual([]);
  });
});
