import { describe, it, expect, vi, beforeEach } from 'vitest';
import { appNamesFromTranscript, resolveSessionArtifacts } from './sessionArtifacts';
import type { AppVersionListing } from './appVersion';

// Same stub-only-what-you-need idiom as appVersion.vitest.ts / ArtifactPanel.vitest.ts:
// mock authFetch (lib/api) and fetchAppManifest (lib/appVersion), keep every
// other export of each module real (appNameFromUrl, flatAppUrl, etc.).
const authFetchMock = vi.fn();
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, authFetch: (...args: Parameters<typeof actual.authFetch>) => authFetchMock(...args) };
});

const fetchAppManifestMock = vi.fn();
vi.mock('./appVersion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./appVersion')>();
  return { ...actual, fetchAppManifest: (...args: Parameters<typeof actual.fetchAppManifest>) => fetchAppManifestMock(...args) };
});

function listing(name: string, filename: string, version: string): AppVersionListing {
  return {
    name,
    versions: [{ filename, version, label: null, url: `apps/${name}/${filename}`, latest: true }],
    latest: filename,
  };
}

describe('appNamesFromTranscript', () => {
  it('returns [] for text with no embedded-app tags', () => {
    expect(appNamesFromTranscript('just some plain text, no tags at all')).toEqual([]);
  });

  it('returns [] for text with only image/video embeds', () => {
    const text = '<embedded-image url="captures/x/1.png" size="md" /> and <embedded-video url="captures/x/1.mp4" />';
    expect(appNamesFromTranscript(text)).toEqual([]);
  });

  it('extracts distinct app names in first-seen order, deduping a repeated name', () => {
    const text = [
      '<embedded-app url="apps/counter.html" height="300" />',
      'some text between tags',
      '<embedded-app url="apps/notes.html" height="360" />',
      '<embedded-app url="apps/counter.html" height="300" />', // duplicate
      '<embedded-app url="apps/widget.html" height="240" />',
    ].join('\n');
    expect(appNamesFromTranscript(text)).toEqual(['counter', 'notes', 'widget']);
  });

  it('skips malformed tags (no url) without throwing', () => {
    const text = '<embedded-app height="300" /> <embedded-app url="apps/counter.html" height="300" />';
    expect(appNamesFromTranscript(text)).toEqual(['counter']);
  });

  it('never mutates the shared embeds.ts TAG_RE lastIndex (two consecutive calls both find every tag)', () => {
    const text = '<embedded-app url="apps/counter.html" height="300" />';
    expect(appNamesFromTranscript(text)).toEqual(['counter']);
    expect(appNamesFromTranscript(text)).toEqual(['counter']); // would return [] on a second call if lastIndex leaked
  });
});

describe('resolveSessionArtifacts', () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    fetchAppManifestMock.mockReset();
  });

  it('resolves distinct names to SessionArtifacts with the right name/kind/version, kind sourced from fetchAppManifest', async () => {
    authFetchMock.mockImplementation((url: string) => {
      if (url.includes('/counter/')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(listing('counter', '2026-07-08T23-32-05Z.html', '2026-07-08T23-32-05Z')) });
      }
      if (url.includes('/notes/')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(listing('notes', '2026-07-09T00-00-00Z.html', '2026-07-09T00-00-00Z')) });
      }
      if (url.includes('/widget/')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(listing('widget', '2026-07-10T00-00-00Z.html', '2026-07-10T00-00-00Z')) });
      }
      return Promise.resolve({ ok: false });
    });
    fetchAppManifestMock.mockImplementation((url: string) => {
      if (url.includes('counter')) return Promise.resolve({ 'schema-version': 1, artifactKind: 'prototype' });
      if (url.includes('notes')) return Promise.resolve({ 'schema-version': 1, artifactKind: 'markdown' });
      if (url.includes('widget')) return Promise.resolve({ 'schema-version': 1, artifactKind: 'react' });
      return Promise.resolve(null);
    });

    const result = await resolveSessionArtifacts(['counter', 'notes', 'widget']);

    expect(result).toEqual([
      { name: 'counter', url: 'apps/counter/2026-07-08T23-32-05Z.html', latestVersion: '2026-07-08T23-32-05Z', artifactKind: 'prototype' },
      { name: 'notes', url: 'apps/notes/2026-07-09T00-00-00Z.html', latestVersion: '2026-07-09T00-00-00Z', artifactKind: 'markdown' },
      { name: 'widget', url: 'apps/widget/2026-07-10T00-00-00Z.html', latestVersion: '2026-07-10T00-00-00Z', artifactKind: 'react' },
    ]);
  });

  it('returns [] for an empty names list without calling authFetch', async () => {
    expect(await resolveSessionArtifacts([])).toEqual([]);
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the flat url + prototype kind + "latest" version when the versions-fetch fails for one name, while other names still resolve normally', async () => {
    authFetchMock.mockImplementation((url: string) => {
      if (url.includes('/broken/')) return Promise.resolve({ ok: false });
      return Promise.resolve({ ok: true, json: () => Promise.resolve(listing('ok', '2026-07-08T00-00-00Z.html', '2026-07-08T00-00-00Z')) });
    });
    fetchAppManifestMock.mockResolvedValue({ 'schema-version': 1, artifactKind: 'html' });

    const result = await resolveSessionArtifacts(['broken', 'ok']);

    expect(result[0]).toEqual({ name: 'broken', url: 'apps/broken.html', latestVersion: 'latest', artifactKind: 'prototype' });
    expect(result[1]).toEqual({ name: 'ok', url: 'apps/ok/2026-07-08T00-00-00Z.html', latestVersion: '2026-07-08T00-00-00Z', artifactKind: 'html' });
    // The fallback path must never reach fetchAppManifest for the broken name.
    expect(fetchAppManifestMock).not.toHaveBeenCalledWith('apps/broken.html');
  });

  it('falls back when authFetch throws (network error) — never rejects the batch', async () => {
    authFetchMock.mockRejectedValue(new Error('network down'));
    const result = await resolveSessionArtifacts(['flaky']);
    expect(result).toEqual([{ name: 'flaky', url: 'apps/flaky.html', latestVersion: 'latest', artifactKind: 'prototype' }]);
  });

  it('falls back when the versions response body is malformed JSON', async () => {
    authFetchMock.mockResolvedValue({ ok: true, json: () => Promise.reject(new Error('bad json')) });
    const result = await resolveSessionArtifacts(['malformed']);
    expect(result).toEqual([{ name: 'malformed', url: 'apps/malformed.html', latestVersion: 'latest', artifactKind: 'prototype' }]);
  });

  it('preserves input order in the output regardless of resolution timing', async () => {
    authFetchMock.mockImplementation((url: string) => {
      // 'slow' resolves after 'fast' despite being requested first.
      const delayMs = url.includes('/slow/') ? 10 : 0;
      return new Promise((resolve) =>
        setTimeout(() => resolve({ ok: true, json: () => Promise.resolve(listing('x', '2026-01-01T00-00-00Z.html', 'v1')) }), delayMs),
      );
    });
    fetchAppManifestMock.mockResolvedValue({ 'schema-version': 1, artifactKind: 'prototype' });

    const result = await resolveSessionArtifacts(['slow', 'fast']);
    expect(result.map((r) => r.name)).toEqual(['slow', 'fast']);
  });
});
