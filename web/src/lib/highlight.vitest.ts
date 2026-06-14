import { describe, it, expect } from 'vitest';
import { resolveLanguage, highlightCode } from './highlight';

describe('resolveLanguage', () => {
  it('maps aliases onto canonical language ids', () => {
    expect(resolveLanguage('ts')).toBe('typescript');
    expect(resolveLanguage('tsx')).toBe('typescript');
    expect(resolveLanguage('js')).toBe('javascript');
    expect(resolveLanguage('jsx')).toBe('javascript');
    expect(resolveLanguage('sh')).toBe('bash');
    expect(resolveLanguage('shell')).toBe('bash');
    expect(resolveLanguage('py')).toBe('python');
    expect(resolveLanguage('patch')).toBe('diff');
    expect(resolveLanguage('md')).toBe('markdown');
    expect(resolveLanguage('html')).toBe('xml');
  });

  it('is case-insensitive and trims', () => {
    expect(resolveLanguage('  TypeScript ')).toBe('typescript');
    expect(resolveLanguage('JSON')).toBe('json');
  });

  it('returns null for unknown / empty languages', () => {
    expect(resolveLanguage('rust')).toBeNull();
    expect(resolveLanguage('')).toBeNull();
    expect(resolveLanguage(undefined)).toBeNull();
    expect(resolveLanguage(null)).toBeNull();
  });
});

describe('highlightCode', () => {
  it('returns escaped, span-wrapped HTML for a supported language', async () => {
    const html = await highlightCode('ts', 'const x = 1;');
    expect(html).toBeTypeOf('string');
    expect(html).toContain('hljs-');
    expect(html).toContain('const');
  });

  it('escapes HTML-special characters in the source', async () => {
    const html = await highlightCode('js', 'const a = b < c && d > e;');
    expect(html).not.toBeNull();
    // Raw angle brackets from the source must be entity-escaped, never literal.
    expect(html).toContain('&lt;');
    expect(html).toContain('&gt;');
    expect(html).toContain('&amp;');
  });

  it('returns null for an unsupported language (caller falls back to plain)', async () => {
    expect(await highlightCode('rust', 'fn main() {}')).toBeNull();
    expect(await highlightCode(undefined, 'x')).toBeNull();
  });

  it('highlights bash, json, python, and diff', async () => {
    expect(await highlightCode('bash', 'echo hi')).toContain('hljs-');
    expect(await highlightCode('json', '{"a":1}')).toContain('hljs-');
    expect(await highlightCode('python', 'def f(): pass')).toContain('hljs-');
    expect(await highlightCode('diff', '+added\n-removed')).toContain('hljs-');
  });
});
