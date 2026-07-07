import { describe, it, expect } from 'vitest';
import { resolveMediaUrl } from './mediaUrl';

describe('resolveMediaUrl', () => {
  it('uses http(s) urls directly, no fetch', () => {
    expect(resolveMediaUrl('https://example.com/s.png')).toEqual({
      kind: 'direct',
      src: 'https://example.com/s.png',
    });
    expect(resolveMediaUrl('http://example.com/s.png')).toEqual({
      kind: 'direct',
      src: 'http://example.com/s.png',
    });
  });

  it('builds /api/media/<encoded> for a bare filename', () => {
    expect(resolveMediaUrl('cockpit-media-e2e.webm')).toEqual({
      kind: 'fetch',
      fetchUrl: '/api/media/cockpit-media-e2e.webm',
    });
  });

  it('encodes a nested relative path per segment, preserving "/" separators', () => {
    expect(resolveMediaUrl('prototypes/cockpit uiproof v2/clip name.webm')).toEqual({
      kind: 'fetch',
      fetchUrl: '/api/media/prototypes/cockpit%20uiproof%20v2/clip%20name.webm',
    });
  });

  it('uses an already-/api/media/-prefixed url as-is, never re-prefixing it', () => {
    const already = '/api/media/prototypes/dir/file.webm';
    expect(resolveMediaUrl(already)).toEqual({ kind: 'fetch', fetchUrl: already });
  });

  it('rejects ".." traversal segments', () => {
    expect(resolveMediaUrl('../secret.txt')).toEqual({ kind: 'rejected' });
    expect(resolveMediaUrl('a/../../b.png')).toEqual({ kind: 'rejected' });
  });

  it('rejects the empty url', () => {
    expect(resolveMediaUrl('')).toEqual({ kind: 'rejected' });
  });

  it('rejects other schemes and protocol-relative urls', () => {
    expect(resolveMediaUrl('file:///etc/passwd')).toEqual({ kind: 'rejected' });
    expect(resolveMediaUrl('data:image/png;base64,abc')).toEqual({ kind: 'rejected' });
    expect(resolveMediaUrl('javascript:alert(1)')).toEqual({ kind: 'rejected' });
    expect(resolveMediaUrl('//evil.example.com/x.png')).toEqual({ kind: 'rejected' });
  });

  it('rejects other leading-"/" paths — no server route besides /api/media/ exists', () => {
    expect(resolveMediaUrl('/etc/passwd')).toEqual({ kind: 'rejected' });
    expect(resolveMediaUrl('/foo/bar.png')).toEqual({ kind: 'rejected' });
  });
});
