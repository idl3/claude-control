// @vitest-environment jsdom
//
// Phase C, C2: the floating per-session artifact tray. Mocks
// resolveSessionArtifacts (keeping appNamesFromTranscript real, so the
// transcript -> names extraction is exercised end-to-end) and stubs
// useArtifactPanel's `open` (the officer's documented alternative to
// mounting a full ArtifactPanelProvider tree — this file is testing
// ArtifactGallery's own dispatch logic, not the panel's rendering).
//
// Phase C3: the row list is now a disclosure behind a head toggle button,
// collapsed by default so it never covers the transcript. Every test that
// asserts on rows must expandGallery() first.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { ArtifactGallery } from './ArtifactGallery';
import type { SessionArtifact } from '../lib/sessionArtifacts';

const resolveSessionArtifactsMock = vi.fn();
vi.mock('../lib/sessionArtifacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/sessionArtifacts')>();
  return {
    ...actual,
    resolveSessionArtifacts: (...args: Parameters<typeof actual.resolveSessionArtifacts>) =>
      resolveSessionArtifactsMock(...args),
  };
});

const openMock = vi.fn();
vi.mock('./ArtifactContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ArtifactContext')>();
  return { ...actual, useArtifactPanel: () => ({ open: openMock }) };
});

// D4/session-scoping note (see ArtifactContext.vitest.ts's identical stub):
// the Node/vitest/jsdom combo this repo runs on shadows jsdom's
// `localStorage` with Node's own experimental global, which implements
// neither getItem nor setItem — so persistence round-trips need a real,
// in-memory Storage stub.
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

function transcriptWith(...names: string[]): string {
  return names.map((n) => `<embedded-app url="apps/${n}.html" height="300" />`).join('\n');
}

function galleryHead(): HTMLElement {
  return screen.getByRole('button', { name: /^Artifacts/ });
}

async function expandGallery(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /^Artifacts/ }));
}

const PROTOTYPE: SessionArtifact = {
  name: 'counter',
  url: 'apps/counter.html',
  artifactKind: 'prototype',
  latestVersion: '2026-07-08T00-00-00Z',
};
const MARKDOWN: SessionArtifact = {
  name: 'notes',
  url: 'apps/notes/2026-07-09T00-00-00Z.html',
  artifactKind: 'markdown',
  latestVersion: '2026-07-09T00-00-00Z',
};
const REACT: SessionArtifact = {
  name: 'widget',
  url: 'apps/widget/2026-07-10T00-00-00Z.html',
  artifactKind: 'react',
  latestVersion: '2026-07-10T00-00-00Z',
};

let dispatchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resolveSessionArtifactsMock.mockReset();
  openMock.mockReset();
  dispatchSpy = vi.fn(window.dispatchEvent.bind(window));
  window.dispatchEvent = dispatchSpy as unknown as typeof window.dispatchEvent;
  vi.stubGlobal('localStorage', new FakeLocalStorage());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ArtifactGallery', () => {
  it('renders nothing for a transcript with no embedded-app tags (never calls resolveSessionArtifacts)', () => {
    render(createElement(ArtifactGallery, { transcriptText: 'just some prose, no tags here' }));
    expect(resolveSessionArtifactsMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Session artifacts' })).toBeNull();
  });

  it('is collapsed by default: the head button renders with aria-expanded=false and the row list is not in the DOM', async () => {
    resolveSessionArtifactsMock.mockResolvedValue([PROTOTYPE]);
    render(createElement(ArtifactGallery, { transcriptText: transcriptWith('counter') }));

    const head = await screen.findByRole('button', { name: /^Artifacts/ });
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(head.getAttribute('aria-controls')).toBeTruthy();
    expect(screen.queryByText('counter')).toBeNull();
    expect(screen.getByText('(1)')).toBeTruthy();
  });

  it('clicking the head toggles the list open, sets aria-expanded=true, and the <ul> id matches aria-controls', async () => {
    resolveSessionArtifactsMock.mockResolvedValue([PROTOTYPE]);
    render(createElement(ArtifactGallery, { transcriptText: transcriptWith('counter') }));

    const head = await screen.findByRole('button', { name: /^Artifacts/ });
    const controlsId = head.getAttribute('aria-controls');
    fireEvent.click(head);

    expect(head.getAttribute('aria-expanded')).toBe('true');
    const rowText = await screen.findByText('counter');
    expect(rowText.closest('ul')?.id).toBe(controlsId);

    // Click again to collapse.
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(screen.queryByText('counter')).toBeNull());
  });

  it('persists the expanded state to localStorage and restores it on the next mount', async () => {
    resolveSessionArtifactsMock.mockResolvedValue([PROTOTYPE]);
    const { unmount } = render(createElement(ArtifactGallery, { transcriptText: transcriptWith('counter') }));
    await expandGallery();
    expect(galleryHead().getAttribute('aria-expanded')).toBe('true');
    expect(localStorage.getItem('cc:artifact-gallery-open')).toBe('1');
    unmount();

    resolveSessionArtifactsMock.mockResolvedValue([PROTOTYPE]);
    render(createElement(ArtifactGallery, { transcriptText: transcriptWith('counter') }));
    expect((await screen.findByRole('button', { name: /^Artifacts/ })).getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByText('counter')).toBeTruthy();
  });

  it('lists all three artifacts with correct names, versions, and kind badges once resolved and expanded', async () => {
    resolveSessionArtifactsMock.mockResolvedValue([PROTOTYPE, MARKDOWN, REACT]);
    render(createElement(ArtifactGallery, { transcriptText: transcriptWith('counter', 'notes', 'widget') }));
    await expandGallery();

    await screen.findByText('counter');
    expect(screen.getByText('notes')).toBeTruthy();
    expect(screen.getByText('widget')).toBeTruthy();
    expect(screen.getByText('2026-07-08T00-00-00Z')).toBeTruthy();
    expect(screen.getByText('2026-07-09T00-00-00Z')).toBeTruthy();
    expect(screen.getByText('2026-07-10T00-00-00Z')).toBeTruthy();
    expect(screen.getByLabelText('Prototype artifact')).toBeTruthy();
    expect(screen.getByLabelText('Markdown artifact')).toBeTruthy();
    expect(screen.getByLabelText('React artifact')).toBeTruthy();
    expect(resolveSessionArtifactsMock).toHaveBeenCalledWith(['counter', 'notes', 'widget']);
  });

  it('clicking a prototype row dispatches cockpit:studio-open with its url, never calls open()', async () => {
    resolveSessionArtifactsMock.mockResolvedValue([PROTOTYPE]);
    render(createElement(ArtifactGallery, { transcriptText: transcriptWith('counter') }));
    await expandGallery();
    const row = (await screen.findByText('counter')).closest('button')!;

    fireEvent.click(row);

    const call = dispatchSpy.mock.calls.find(([e]) => (e as CustomEvent).type === 'cockpit:studio-open');
    expect(call).toBeTruthy();
    expect((call![0] as CustomEvent).detail).toEqual({ url: 'apps/counter.html' });
    expect(openMock).not.toHaveBeenCalled();
  });

  it('clicking a markdown row opens it inline via useArtifactPanel().open with kind "app" and the right appUrl', async () => {
    resolveSessionArtifactsMock.mockResolvedValue([MARKDOWN]);
    render(createElement(ArtifactGallery, { transcriptText: transcriptWith('notes') }));
    await expandGallery();
    const row = (await screen.findByText('notes')).closest('button')!;

    fireEvent.click(row);

    expect(openMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'app', appUrl: MARKDOWN.url, title: 'notes', pinned: true }),
    );
  });

  it('clicking a react row also opens it inline via open() (same presentation-kind path as markdown)', async () => {
    resolveSessionArtifactsMock.mockResolvedValue([REACT]);
    render(createElement(ArtifactGallery, { transcriptText: transcriptWith('widget') }));
    await expandGallery();
    const row = (await screen.findByText('widget')).closest('button')!;

    fireEvent.click(row);

    expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'app', appUrl: REACT.url, pinned: true }));
    expect(dispatchSpy.mock.calls.some(([e]) => (e as CustomEvent).type === 'cockpit:studio-open')).toBe(false);
  });

  it('clears to empty when the transcript no longer has any embed tags (e.g. session switch)', async () => {
    resolveSessionArtifactsMock.mockResolvedValue([PROTOTYPE]);
    const { rerender } = render(createElement(ArtifactGallery, { transcriptText: transcriptWith('counter') }));
    await expandGallery();
    await screen.findByText('counter');

    rerender(createElement(ArtifactGallery, { transcriptText: 'no embeds in this transcript anymore' }));

    await waitFor(() => expect(screen.queryByText('counter')).toBeNull());
  });

  it('does not re-resolve when transcript text changes but the derived name set does not', async () => {
    resolveSessionArtifactsMock.mockResolvedValue([PROTOTYPE]);
    const { rerender } = render(createElement(ArtifactGallery, { transcriptText: transcriptWith('counter') }));
    await expandGallery();
    await screen.findByText('counter');
    expect(resolveSessionArtifactsMock).toHaveBeenCalledTimes(1);

    // Same embedded name, extra prose appended (simulates streaming tokens) — must not re-fetch.
    rerender(createElement(ArtifactGallery, { transcriptText: transcriptWith('counter') + '\nmore streamed prose' }));

    await waitFor(() => expect(screen.getByText('counter')).toBeTruthy());
    expect(resolveSessionArtifactsMock).toHaveBeenCalledTimes(1);
  });
});
