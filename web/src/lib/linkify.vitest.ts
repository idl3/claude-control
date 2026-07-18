// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import {
  URL_RE,
  stripTrailingPunctuation,
  splitOnUrls,
  linkifyChildren,
  hljsHtmlToNodes,
  framingFallbackState,
  computeMenuPosition,
} from './linkify';

// A stable, string-serializable stand-in for the real `UrlLink` — lets
// assertions check both "which URL got linked" and "did plain text survive
// untouched" via a plain HTML string, without pulling UrlLink's popover
// context into a pure-function test.
const renderUrl = (url: string) => createElement('a', { 'data-url': url }, url);

describe('stripTrailingPunctuation', () => {
  it('strips a single trailing period', () => {
    expect(stripTrailingPunctuation('https://example.com.')).toBe('https://example.com');
  });

  it('strips a single trailing comma', () => {
    expect(stripTrailingPunctuation('https://example.com,')).toBe('https://example.com');
  });

  it('strips multiple trailing punctuation characters one at a time', () => {
    expect(stripTrailingPunctuation('https://example.com."')).toBe('https://example.com');
  });

  it('strips an unbalanced trailing close-paren from surrounding prose', () => {
    expect(stripTrailingPunctuation('https://example.com)')).toBe('https://example.com');
  });

  it('keeps a trailing close-paren balanced by an earlier open-paren (Wikipedia-style)', () => {
    expect(stripTrailingPunctuation('https://en.wikipedia.org/wiki/Bracket_(disambiguation)')).toBe(
      'https://en.wikipedia.org/wiki/Bracket_(disambiguation)',
    );
  });

  it('strips a trailing period after a balanced-paren URL, keeping the paren', () => {
    expect(stripTrailingPunctuation('https://en.wikipedia.org/wiki/Bracket_(disambiguation).')).toBe(
      'https://en.wikipedia.org/wiki/Bracket_(disambiguation)',
    );
  });

  it('leaves a URL with no trailing punctuation untouched', () => {
    expect(stripTrailingPunctuation('https://example.com/path')).toBe('https://example.com/path');
  });
});

describe('splitOnUrls', () => {
  it('splits a prose URL with surrounding text', () => {
    expect(splitOnUrls('Check https://example.com today')).toEqual([
      { kind: 'text', value: 'Check ' },
      { kind: 'url', value: 'https://example.com' },
      { kind: 'text', value: ' today' },
    ]);
  });

  it('strips a trailing period at the end of a sentence', () => {
    expect(splitOnUrls('See https://example.com.')).toEqual([
      { kind: 'text', value: 'See ' },
      { kind: 'url', value: 'https://example.com' },
      { kind: 'text', value: '.' },
    ]);
  });

  it('strips a trailing comma mid-sentence', () => {
    expect(splitOnUrls('Also https://example.com, then more')).toEqual([
      { kind: 'text', value: 'Also ' },
      { kind: 'url', value: 'https://example.com' },
      { kind: 'text', value: ', then more' },
    ]);
  });

  it('keeps a balanced trailing paren (Wikipedia-style URL) intact', () => {
    expect(splitOnUrls('See https://en.wikipedia.org/wiki/Bracket_(disambiguation) for details')).toEqual([
      { kind: 'text', value: 'See ' },
      { kind: 'url', value: 'https://en.wikipedia.org/wiki/Bracket_(disambiguation)' },
      { kind: 'text', value: ' for details' },
    ]);
  });

  it('splits multiple URLs in one string', () => {
    expect(splitOnUrls('See https://a.com and https://b.com too')).toEqual([
      { kind: 'text', value: 'See ' },
      { kind: 'url', value: 'https://a.com' },
      { kind: 'text', value: ' and ' },
      { kind: 'url', value: 'https://b.com' },
      { kind: 'text', value: ' too' },
    ]);
  });

  it('returns a single text segment when there is no URL', () => {
    expect(splitOnUrls('just plain text, nothing to link')).toEqual([
      { kind: 'text', value: 'just plain text, nothing to link' },
    ]);
  });

  it('splits a URL flanked by text on both sides with no boundary loss', () => {
    expect(splitOnUrls('prefix https://example.com/path suffix')).toEqual([
      { kind: 'text', value: 'prefix ' },
      { kind: 'url', value: 'https://example.com/path' },
      { kind: 'text', value: ' suffix' },
    ]);
  });

  it('documents current behavior: a URL with no whitespace before trailing prose absorbs it', () => {
    // Known, accepted limitation of the "match up to whitespace" regex: when
    // prose immediately follows a URL with zero separating whitespace, it
    // reads as part of the URL's path. Real transcripts always have a space,
    // punctuation, or markdown delimiter after a URL, so this never bites in
    // practice — documented here rather than silently untested.
    expect(splitOnUrls('see https://example.comSuffix here')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'url', value: 'https://example.comSuffix' },
      { kind: 'text', value: ' here' },
    ]);
  });

  it('ignores non-http(s) schemes entirely', () => {
    expect(splitOnUrls('call ftp://example.com or mailto:a@b.com for help')).toEqual([
      { kind: 'text', value: 'call ftp://example.com or mailto:a@b.com for help' },
    ]);
  });

  it('is anchored by URL_RE (sanity check on the shared regex)', () => {
    expect(URL_RE.test('https://x.co')).toBe(true);
    expect(URL_RE.test('ftp://x.co')).toBe(false);
    expect(URL_RE.test('not a url')).toBe(false);
  });
});

describe('linkifyChildren', () => {
  it('returns a plain string untouched when there is no URL', () => {
    const out = linkifyChildren('no links here', renderUrl);
    expect(out).toBe('no links here');
  });

  it('linkifies a URL inside a string, rendering it via renderUrl', () => {
    const html = renderToStaticMarkup(
      createElement('div', null, linkifyChildren('go to https://example.com now', renderUrl)),
    );
    expect(html).toContain('data-url="https://example.com"');
    expect(html).toContain('go to ');
    expect(html).toContain(' now');
  });

  it('recurses into array children, linkifying each string element', () => {
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        linkifyChildren(['see ', 'https://a.com', ' and ', 'https://b.com'], renderUrl),
      ),
    );
    expect(html).toContain('data-url="https://a.com"');
    expect(html).toContain('data-url="https://b.com"');
  });

  it('passes non-string, non-array children through unchanged', () => {
    const el = createElement('strong', { key: 'k' }, 'bold text');
    expect(linkifyChildren(el, renderUrl)).toBe(el);
  });

  it('passes null/undefined children through unchanged', () => {
    expect(linkifyChildren(null, renderUrl)).toBeNull();
    expect(linkifyChildren(undefined, renderUrl)).toBeUndefined();
  });
});

describe('hljsHtmlToNodes', () => {
  it('linkifies a URL inside a single hljs span, preserving the highlight class', () => {
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        hljsHtmlToNodes('<span class="hljs-comment"># See https://example.com for docs</span>', renderUrl),
      ),
    );
    expect(html).toContain('class="hljs-comment"');
    expect(html).toContain('data-url="https://example.com"');
    expect(html).toContain('# See ');
    expect(html).toContain(' for docs');
  });

  it('renders plain text with no spans and no URL as-is', () => {
    const html = renderToStaticMarkup(
      createElement('div', null, hljsHtmlToNodes('plain code, no highlighting', renderUrl)),
    );
    expect(html).toContain('plain code, no highlighting');
    expect(html).not.toContain('<a');
  });

  it('recurses into nested spans, linkifying a URL in the innermost text', () => {
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        hljsHtmlToNodes(
          '<span class="hljs-string">"<span class="hljs-subst">https://example.com</span>"</span>',
          renderUrl,
        ),
      ),
    );
    expect(html).toContain('class="hljs-string"');
    expect(html).toContain('class="hljs-subst"');
    expect(html).toContain('data-url="https://example.com"');
  });

  it('decodes HTML entities before linkifying, and leaves a non-URL entity-bearing span untouched', () => {
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        hljsHtmlToNodes('<span class="hljs-comment">a &amp; b, no link here</span>', renderUrl),
      ),
    );
    expect(html).not.toContain('<a');
    // React re-escapes on output, so the decoded "&" round-trips to "&amp;".
    expect(html).toContain('a &amp; b, no link here');
  });

  it('finds a URL inside entity-escaped angle-bracket-wrapped text', () => {
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        hljsHtmlToNodes('<span class="hljs-comment">&lt;https://example.com&gt; see docs</span>', renderUrl),
      ),
    );
    expect(html).toContain('data-url="https://example.com"');
    expect(html).toContain('&lt;');
    expect(html).toContain('&gt;');
  });
});

describe('framingFallbackState', () => {
  it('is "loading" before load fires and before the timeout elapses', () => {
    expect(framingFallbackState({ loadFired: false, timedOut: false })).toBe('loading');
  });

  it('is "loaded" once load fires, even if the timeout also later elapses', () => {
    expect(framingFallbackState({ loadFired: true, timedOut: false })).toBe('loaded');
    expect(framingFallbackState({ loadFired: true, timedOut: true })).toBe('loaded');
  });

  it('is "blocked" once the timeout elapses without load ever firing', () => {
    expect(framingFallbackState({ loadFired: false, timedOut: true })).toBe('blocked');
  });
});

describe('computeMenuPosition', () => {
  const viewport = { width: 1000, height: 800 };
  const menu = { width: 200, height: 124 };

  it('places the menu below-left of the anchor by default', () => {
    const anchor = { top: 100, left: 100, width: 50, height: 20 };
    expect(computeMenuPosition(anchor, menu, viewport)).toEqual({ top: 128, left: 100 });
  });

  it('flips the menu above the anchor when there is no room below', () => {
    const anchor = { top: 750, left: 100, width: 50, height: 20 };
    // top(anchor) + height + margin = 798 -> would overflow 800 - margin(8) = 792
    expect(computeMenuPosition(anchor, menu, viewport)).toEqual({ top: 750 - 124 - 8, left: 100 });
  });

  it('clamps to the viewport bottom when there is no room above or below', () => {
    const anchor = { top: 10, left: 100, width: 50, height: 780 };
    const pos = computeMenuPosition(anchor, menu, viewport);
    expect(pos.top).toBe(Math.max(8, viewport.height - menu.height - 8));
  });

  it('clamps left so the menu never overflows the right viewport edge', () => {
    const anchor = { top: 100, left: 950, width: 50, height: 20 };
    const pos = computeMenuPosition(anchor, menu, viewport);
    expect(pos.left).toBe(viewport.width - menu.width - 8);
  });

  it('clamps left so the menu never overflows the left viewport edge', () => {
    const anchor = { top: 100, left: -50, width: 50, height: 20 };
    const pos = computeMenuPosition(anchor, menu, viewport);
    expect(pos.left).toBe(8);
  });
});
