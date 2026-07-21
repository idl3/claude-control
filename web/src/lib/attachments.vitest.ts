// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { acceptsFile, ATTACH_ACCEPT } from './attachments';

function file(name: string, type = ''): File {
  return new File(['x'], name, { type });
}

describe('acceptsFile — ATTACH_ACCEPT gate (drag-and-drop screening)', () => {
  it('accepts by MIME wildcard (image/*, text/*)', () => {
    expect(acceptsFile(file('a.png', 'image/png'))).toBe(true);
    expect(acceptsFile(file('a.webp', 'image/webp'))).toBe(true);
    expect(acceptsFile(file('a.txt', 'text/plain'))).toBe(true);
  });

  it('accepts by exact MIME (application/pdf)', () => {
    expect(acceptsFile(file('doc.pdf', 'application/pdf'))).toBe(true);
  });

  it('accepts by extension even when the OS gives no/odd MIME type', () => {
    expect(acceptsFile(file('notes.md', ''))).toBe(true);
    expect(acceptsFile(file('server.log', ''))).toBe(true);
    expect(acceptsFile(file('data.json', 'application/octet-stream'))).toBe(true);
    expect(acceptsFile(file('rows.csv', ''))).toBe(true);
  });

  it('rejects unsupported types (no matching MIME or extension)', () => {
    expect(acceptsFile(file('archive.zip', 'application/zip'))).toBe(false);
    expect(acceptsFile(file('clip.mp4', 'video/mp4'))).toBe(false);
    expect(acceptsFile(file('app.bin', 'application/octet-stream'))).toBe(false);
  });

  it('is case-insensitive on both extension and MIME', () => {
    expect(acceptsFile(file('PHOTO.PNG', 'IMAGE/PNG'))).toBe(true);
    expect(acceptsFile(file('README.MD', ''))).toBe(true);
  });

  it('an empty accept list accepts everything (mirrors a missing accept attr)', () => {
    expect(acceptsFile(file('anything.xyz', 'application/whatever'), '')).toBe(true);
  });

  it('honors a custom accept list distinct from the default', () => {
    expect(acceptsFile(file('a.png', 'image/png'), 'application/pdf')).toBe(false);
    expect(acceptsFile(file('doc.pdf', 'application/pdf'), 'application/pdf')).toBe(true);
  });

  it('ATTACH_ACCEPT is the default accept list', () => {
    // Sanity: the default arg is the shared constant, so the picker and the
    // drop gate screen identically.
    expect(acceptsFile(file('a.png', 'image/png'), ATTACH_ACCEPT)).toBe(
      acceptsFile(file('a.png', 'image/png')),
    );
  });
});
