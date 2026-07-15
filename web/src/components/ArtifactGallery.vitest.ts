// @vitest-environment jsdom
//
// Phase C, C2: the floating per-session artifact tray. Mocks
// resolveSessionArtifacts (keeping appNamesFromTranscript real, so the
// transcript -> names extraction is exercised end-to-end) and stubs
// useArtifactPanel's `open` (the officer's documented alternative to
// mounting a full ArtifactPanelProvider tree — this file is testing
// ArtifactGallery's own dispatch logic, not the panel's rendering).
//
// Phase D: the component is now FULLY CONTROLLED — no internal head button
// or expand/collapse state. `open` decides whether the row list renders at
// all, and `onCountChange` is how the resolved artifact count is reported
// upward (the header owns the toggle button + count badge now). Persistence
// of the open/closed choice moved to lib/sessionArtifacts.ts
// (loadGalleryOpen/saveGalleryOpen), tested directly in
// sessionArtifacts.vitest.ts.
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

function transcriptWith(...names: string[]): string {
  return names.map((n) => `<embedded-app url="apps/${n}.html" height="300" />`).join('\n');
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
let onCountChange: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resolveSessionArtifactsMock.mockReset();
  openMock.mockReset();
  onCountChange = vi.fn();
  dispatchSpy = vi.fn(window.dispatchEvent.bind(window));
  window.dispatchEvent = dispatchSpy as unknown as typeof window.dispatchEvent;
});
afterEach(() => {
  cleanup();
});

describe('ArtifactGallery', () => {
  // Task 3: open + zero-artifacts now renders the onboarding explainer
  // (never null) — see the two tests immediately below. This replaces the
  // old "renders nothing ... open={true}" expectation, which pre-dates the
  // empty-state change.
  it('open + no embedded-app tags: renders the region with the onboarding explainer (never calls resolveSessionArtifacts), reports count 0', () => {
    render(
      createElement(ArtifactGallery, {
        transcriptText: 'just some prose, no tags here',
        open: true,
        onCountChange,
      }),
    );
    expect(resolveSessionArtifactsMock).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Session artifacts' })).toBeTruthy();
    expect(screen.getByText('No artifacts yet')).toBeTruthy();
    expect(onCountChange).toHaveBeenCalledWith(0);
  });

  it('closed + no embedded-app tags: still renders nothing (the !open early return is untouched by the empty-state change)', () => {
    render(
      createElement(ArtifactGallery, {
        transcriptText: 'just some prose, no tags here',
        open: false,
        onCountChange,
      }),
    );
    expect(resolveSessionArtifactsMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Session artifacts' })).toBeNull();
    expect(onCountChange).toHaveBeenCalledWith(0);
  });

  it('open={false}: resolves artifacts + reports the count, but the list is not in the DOM', async () => {
    resolveSessionArtifactsMock.mockResolvedValue([PROTOTYPE]);
    render(
      createElement(ArtifactGallery, { transcriptText: transcriptWith('counter'), open: false, onCountChange }),
    );

    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(1));
    expect(screen.queryByRole('region', { name: 'Session artifacts' })).toBeNull();
    expect(screen.queryByText('counter')).toBeNull();
  });

  it('open={true}: renders the list once artifacts resolve', async () => {
    resolveSessionArtifactsMock.mockResolvedValue([PROTOTYPE]);
    render(createElement(ArtifactGallery, { transcriptText: transcriptWith('counter'), open: true, onCountChange }));

    expect(await screen.findByText('counter')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Session artifacts' })).toBeTruthy();
    expect(onCountChange).toHaveBeenCalledWith(1);
  });

  it('toggling the open prop (rerender) mounts/unmounts the list without re-resolving', async () => {
    resolveSessionArtifactsMock.mockResolvedValue([PROTOTYPE]);
    const { rerender } = render(
      createElement(ArtifactGallery, { transcriptText: transcriptWith('counter'), open: false, onCountChange }),
    );
    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(1));
    expect(screen.queryByText('counter')).toBeNull();

    rerender(createElement(ArtifactGallery, { transcriptText: transcriptWith('counter'), open: true, onCountChange }));
    expect(await screen.findByText('counter')).toBeTruthy();

    rerender(createElement(ArtifactGallery, { transcriptText: transcriptWith('counter'), open: false, onCountChange }));
    await waitFor(() => expect(screen.queryByText('counter')).toBeNull());

    // Only ever resolved once — toggling `open` is pure render-level, no re-fetch.
    expect(resolveSessionArtifactsMock).toHaveBeenCalledTimes(1);
  });

  it('lists all three artifacts with correct names, versions, and kind badges once resolved', async () => {
    resolveSessionArtifactsMock.mockResolvedValue([PROTOTYPE, MARKDOWN, REACT]);
    render(
      createElement(ArtifactGallery, {
        transcriptText: transcriptWith('counter', 'notes', 'widget'),
        open: true,
        onCountChange,
      }),
    );

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
    expect(onCountChange).toHaveBeenCalledWith(3);
  });

  it('clicking a prototype row dispatches cockpit:studio-open with its url, never calls open()', async () => {
    resolveSessionArtifactsMock.mockResolvedValue([PROTOTYPE]);
    render(createElement(ArtifactGallery, { transcriptText: transcriptWith('counter'), open: true, onCountChange }));
    const row = (await screen.findByText('counter')).closest('button')!;

    fireEvent.click(row);

    const call = dispatchSpy.mock.calls.find(([e]) => (e as CustomEvent).type === 'cockpit:studio-open');
    expect(call).toBeTruthy();
    expect((call![0] as CustomEvent).detail).toEqual({ url: 'apps/counter.html' });
    expect(openMock).not.toHaveBeenCalled();
  });

  it('clicking a markdown row opens it inline via useArtifactPanel().open with kind "app" and the right appUrl', async () => {
    resolveSessionArtifactsMock.mockResolvedValue([MARKDOWN]);
    render(createElement(ArtifactGallery, { transcriptText: transcriptWith('notes'), open: true, onCountChange }));
    const row = (await screen.findByText('notes')).closest('button')!;

    fireEvent.click(row);

    expect(openMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'app', appUrl: MARKDOWN.url, title: 'notes', pinned: true }),
    );
  });

  it('clicking a react row also opens it inline via open() (same presentation-kind path as markdown)', async () => {
    resolveSessionArtifactsMock.mockResolvedValue([REACT]);
    render(createElement(ArtifactGallery, { transcriptText: transcriptWith('widget'), open: true, onCountChange }));
    const row = (await screen.findByText('widget')).closest('button')!;

    fireEvent.click(row);

    expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'app', appUrl: REACT.url, pinned: true }));
    expect(dispatchSpy.mock.calls.some(([e]) => (e as CustomEvent).type === 'cockpit:studio-open')).toBe(false);
  });

  it('clears to empty (onCountChange(0), list gone) when the transcript no longer has any embed tags (e.g. session switch)', async () => {
    resolveSessionArtifactsMock.mockResolvedValue([PROTOTYPE]);
    const { rerender } = render(
      createElement(ArtifactGallery, { transcriptText: transcriptWith('counter'), open: true, onCountChange }),
    );
    await screen.findByText('counter');

    rerender(
      createElement(ArtifactGallery, {
        transcriptText: 'no embeds in this transcript anymore',
        open: true,
        onCountChange,
      }),
    );

    await waitFor(() => expect(screen.queryByText('counter')).toBeNull());
    expect(onCountChange).toHaveBeenCalledWith(0);
  });

  it('does not re-resolve when transcript text changes but the derived name set does not', async () => {
    resolveSessionArtifactsMock.mockResolvedValue([PROTOTYPE]);
    const { rerender } = render(
      createElement(ArtifactGallery, { transcriptText: transcriptWith('counter'), open: true, onCountChange }),
    );
    await screen.findByText('counter');
    expect(resolveSessionArtifactsMock).toHaveBeenCalledTimes(1);

    // Same embedded name, extra prose appended (simulates streaming tokens) — must not re-fetch.
    rerender(
      createElement(ArtifactGallery, {
        transcriptText: transcriptWith('counter') + '\nmore streamed prose',
        open: true,
        onCountChange,
      }),
    );

    await waitFor(() => expect(screen.getByText('counter')).toBeTruthy());
    expect(resolveSessionArtifactsMock).toHaveBeenCalledTimes(1);
  });
});
