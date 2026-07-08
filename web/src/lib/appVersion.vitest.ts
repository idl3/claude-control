import { describe, it, expect } from 'vitest';
import {
  appNameFromUrl,
  flatAppUrl,
  versionedAppUrl,
  sortVersionsDesc,
  type AppVersionEntry,
} from './appVersion';

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
    expect(appNameFromUrl('/api/media/apps/counter.html')).toBeNull();
  });

  it('returns null for an app name with disallowed characters (never matches the [a-z0-9-]+ rule)', () => {
    expect(appNameFromUrl('apps/Counter.html')).toBeNull();
    expect(appNameFromUrl('apps/my_app.html')).toBeNull();
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
