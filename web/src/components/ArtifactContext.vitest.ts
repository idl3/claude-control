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
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ArtifactPanelProvider, useArtifactPanel, type OpenArtifactInput } from './ArtifactContext';

function setup() {
  return renderHook(() => useArtifactPanel(), { wrapper: ArtifactPanelProvider });
}

function codeArtifact(id: string): OpenArtifactInput {
  return { id, kind: 'code', title: id, language: 'ts', content: `content-${id}` };
}

function appArtifact(id: string, pinned?: boolean): OpenArtifactInput {
  return { id, kind: 'app', title: id, content: '', appUrl: `apps/${id}.html`, appHeight: 320, pinned };
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
