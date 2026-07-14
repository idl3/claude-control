import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  appNameFromUrl,
  flatAppUrl,
  versionedAppUrl,
  sortVersionsDesc,
  normalizeArtifactKind,
  isValidAppManifestShape,
  fetchAppManifest,
  type AppVersionEntry,
} from './appVersion';

// B1: fetchAppManifest fetches via authFetch (lib/api) — stub only that
// export (importOriginal keeps every other lib/api export real), same idiom
// as embeds.vitest.ts / StudioModal.vitest.ts.
const authFetchMock = vi.fn();
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, authFetch: (...args: Parameters<typeof actual.authFetch>) => authFetchMock(...args) };
});

describe('appNameFromUrl', () => {
  it('extracts the name from a flat legacy url', () => {
    expect(appNameFromUrl('apps/counter.html')).toBe('counter');
  });

  it('extracts the name from a versioned url', () => {
    expect(appNameFromUrl('apps/counter/2026-07-08T23-32-05Z.html')).toBe('counter');
  });

  it('returns null for a non-media-apps url', () => {
    expect(appNameFromUrl('https://example.com/apps/counter.html')).toBeNull();
    expect(appNameFromUrl('runs/demo.mp4')).toBeNull();
  });

  it('returns null for an app name with disallowed characters (never matches the [a-z0-9-]+ rule)', () => {
    expect(appNameFromUrl('apps/Counter.html')).toBeNull();
    expect(appNameFromUrl('apps/my_app.html')).toBeNull();
  });

  // M3 (Codex review): appNameFromUrl must resolve the SAME name whether the
  // url is bare-relative or already `/api/media/`-prefixed — both are legal
  // EmbeddedApp `url` shapes (see mediaUrl.ts's resolveMediaUrl), and
  // AppFrameLayer's H3 name-aware frame matching (shouldReloadOnFrame)
  // depends on this parity to compare a slot's url against a WS frame's path.
  it('extracts the name from an /api/media/-prefixed flat url (matches the bare form)', () => {
    expect(appNameFromUrl('/api/media/apps/counter.html')).toBe('counter');
    expect(appNameFromUrl('/api/media/apps/counter.html')).toBe(appNameFromUrl('apps/counter.html'));
  });

  it('extracts the name from an /api/media/-prefixed versioned url (matches the bare form)', () => {
    expect(appNameFromUrl('/api/media/apps/counter/2026-07-08T23-32-05Z.html')).toBe('counter');
    expect(appNameFromUrl('/api/media/apps/counter/2026-07-08T23-32-05Z.html')).toBe(
      appNameFromUrl('apps/counter/2026-07-08T23-32-05Z.html'),
    );
  });
});

describe('flatAppUrl / versionedAppUrl', () => {
  it('builds the flat legacy url', () => {
    expect(flatAppUrl('counter')).toBe('apps/counter.html');
  });

  it('builds a concrete versioned url', () => {
    expect(versionedAppUrl('counter', '2026-07-08T23-32-05Z.html')).toBe(
      'apps/counter/2026-07-08T23-32-05Z.html',
    );
  });
});

describe('sortVersionsDesc', () => {
  function entry(filename: string): AppVersionEntry {
    return { filename, version: filename.replace(/\.html$/, ''), label: null, url: `apps/x/${filename}`, latest: false };
  }

  it('sorts newest-first by filename (ISO stamp sorts lexicographically == chronologically)', () => {
    const versions = [
      entry('2026-07-01T10-00-00Z.html'),
      entry('2026-07-08T23-32-05Z.html'),
      entry('2026-07-05T00-00-00Z.html'),
    ];
    expect(sortVersionsDesc(versions).map((v) => v.filename)).toEqual([
      '2026-07-08T23-32-05Z.html',
      '2026-07-05T00-00-00Z.html',
      '2026-07-01T10-00-00Z.html',
    ]);
  });

  it('does not mutate the input array', () => {
    const versions = [entry('2026-07-01T10-00-00Z.html'), entry('2026-07-08T23-32-05Z.html')];
    const original = [...versions];
    sortVersionsDesc(versions);
    expect(versions).toEqual(original);
  });

  it('is a no-op on an already-sorted or empty list', () => {
    expect(sortVersionsDesc([])).toEqual([]);
    const versions = [entry('2026-07-08T23-32-05Z.html'), entry('2026-07-01T10-00-00Z.html')];
    expect(sortVersionsDesc(versions).map((v) => v.filename)).toEqual([
      '2026-07-08T23-32-05Z.html',
      '2026-07-01T10-00-00Z.html',
    ]);
  });
});

// --- B1: artifactKind normalization + manifest validation -----------------

describe('normalizeArtifactKind', () => {
  it('passes through each recognized kind', () => {
    expect(normalizeArtifactKind('prototype')).toBe('prototype');
    expect(normalizeArtifactKind('markdown')).toBe('markdown');
    expect(normalizeArtifactKind('html')).toBe('html');
    expect(normalizeArtifactKind('react')).toBe('react');
  });

  it('defaults unknown/garbage/absent values to "prototype"', () => {
    expect(normalizeArtifactKind(undefined)).toBe('prototype');
    expect(normalizeArtifactKind(null)).toBe('prototype');
    expect(normalizeArtifactKind('bogus')).toBe('prototype');
    expect(normalizeArtifactKind(42)).toBe('prototype');
  });
});

describe('isValidAppManifestShape', () => {
  it('accepts a presentation manifest with no component/props (B1: previously rejected)', () => {
    expect(isValidAppManifestShape({ 'schema-version': 1, artifactKind: 'markdown' })).toBe(true);
  });

  it('accepts a prototype manifest with component+props', () => {
    expect(
      isValidAppManifestShape({
        'schema-version': 1,
        component: 'Counter',
        props: [{ name: 'label', tsType: 'string', required: true }],
      }),
    ).toBe(true);
  });

  it('rejects a non-object', () => {
    expect(isValidAppManifestShape(null)).toBe(false);
    expect(isValidAppManifestShape('not an object')).toBe(false);
  });

  it('rejects the wrong schema-version', () => {
    expect(isValidAppManifestShape({ 'schema-version': 2 })).toBe(false);
  });

  it('rejects a manifest whose props is present but not an array', () => {
    expect(isValidAppManifestShape({ 'schema-version': 1, props: 'nope' })).toBe(false);
  });

  it('rejects a props entry missing a string name', () => {
    expect(isValidAppManifestShape({ 'schema-version': 1, props: [{ tsType: 'string' }] })).toBe(false);
  });
});

describe('fetchAppManifest', () => {
  beforeEach(() => {
    authFetchMock.mockReset();
  });

  it('surfaces a presentation manifest\'s artifactKind (was null before B1)', async () => {
    authFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ 'schema-version': 1, artifactKind: 'markdown' }),
    });
    const manifest = await fetchAppManifest('apps/notes.html');
    expect(manifest).toEqual({ 'schema-version': 1, artifactKind: 'markdown' });
  });

  it('defaults to "prototype" when a valid manifest carries no artifactKind (pre-Phase-A back-compat)', async () => {
    authFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ 'schema-version': 1, component: 'Counter', props: [] }),
    });
    const manifest = await fetchAppManifest('apps/counter.html');
    expect(manifest?.artifactKind).toBe('prototype');
  });

  it('normalizes an unrecognized artifactKind value to "prototype"', async () => {
    authFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ 'schema-version': 1, artifactKind: 'bogus' }),
    });
    const manifest = await fetchAppManifest('apps/weird.html');
    expect(manifest?.artifactKind).toBe('prototype');
  });

  it('surfaces artifactKind "react"', async () => {
    authFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ 'schema-version': 1, artifactKind: 'react' }),
    });
    const manifest = await fetchAppManifest('apps/widget.html');
    expect(manifest?.artifactKind).toBe('react');
  });

  it('returns null for a non-ok response (e.g. no manifest written yet)', async () => {
    authFetchMock.mockResolvedValue({ ok: false });
    expect(await fetchAppManifest('apps/old-counter.html')).toBeNull();
  });

  it('returns null when the response body is not an object', async () => {
    authFetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve('not an object') });
    expect(await fetchAppManifest('apps/counter.html')).toBeNull();
  });

  it('returns null for the wrong schema-version', async () => {
    authFetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ 'schema-version': 2 }) });
    expect(await fetchAppManifest('apps/counter.html')).toBeNull();
  });

  it('returns null when props is present but not an array', () => {
    authFetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ 'schema-version': 1, props: 'nope' }),
    });
    return expect(fetchAppManifest('apps/counter.html')).resolves.toBeNull();
  });

  it('returns null when authFetch throws (network error) — never rejects', async () => {
    authFetchMock.mockRejectedValue(new Error('network down'));
    expect(await fetchAppManifest('apps/counter.html')).toBeNull();
  });

  it('returns null for a url that does not resolve to a media-apps manifest', async () => {
    expect(await fetchAppManifest('https://example.com/apps/counter.html')).toBeNull();
    expect(authFetchMock).not.toHaveBeenCalled();
  });
});
