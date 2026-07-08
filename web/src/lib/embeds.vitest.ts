// @vitest-environment jsdom
//
// jsdom (not the file's original bare 'node' default) is required for the
// "EmbeddedApp — live sandboxed micro-app rendering" suite below, which
// mounts via @testing-library/react and needs a real effect lifecycle
// (fetch → setHtml) that renderToStaticMarkup never runs. jsdom is harmless
// to the rest of this file: renderToStaticMarkup needs no DOM at all.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { render as mount, screen, cleanup } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import {
  parseEmbedAttrs,
  parseEmbedAppAttrs,
  embedNodesFromHtml,
  remarkEmbeds,
  APP_HEIGHT_MIN,
  APP_HEIGHT_MAX,
  APP_HEIGHT_DEFAULT,
} from './embeds';
import { MarkdownImg } from '../components/EmbeddedMedia';
import { AppFrameLayer } from '../components/AppFrameLayer';
import { DEFAULT_ASPECT_RATIO } from './mediaDimensions';

// EmbeddedApp fetches its html via authFetch (lib/api) — stub only that
// export (importOriginal keeps every other lib/api export, e.g. Lightbox's
// uploadServeUrl, real) so the mounted-render suite below controls what the
// "fetch" resolves to without a real network.
const authFetchMock = vi.fn();
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, authFetch: (...args: Parameters<typeof actual.authFetch>) => authFetchMock(...args) };
});

// Render markdown through the same plugin + img override MarkdownText uses.
// Static markup: effects never run, so relative-path embeds mount their
// reserved-box frame + skeleton (no src fetched yet) — enough to assert
// kind/size/url made it into elements.
function render(md: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkEmbeds],
      components: { img: MarkdownImg },
      children: md,
    }),
  );
}

describe('parseEmbedAttrs', () => {
  it('parses url + size', () => {
    expect(parseEmbedAttrs(' url="shot.png" size="lg" ')).toEqual({
      url: 'shot.png',
      size: 'lg',
    });
  });
  it('defaults a missing or unknown size to md', () => {
    expect(parseEmbedAttrs(' url="shot.png" ')?.size).toBe('md');
    expect(parseEmbedAttrs(' url="shot.png" size="huge" ')?.size).toBe('md');
  });
  it('returns null without a url', () => {
    expect(parseEmbedAttrs(' size="lg" ')).toBeNull();
  });
});

describe('parseEmbedAppAttrs', () => {
  it('parses url + height', () => {
    expect(parseEmbedAppAttrs(' url="apps/counter.html" height="380" ')).toEqual({
      url: 'apps/counter.html',
      height: 380,
    });
  });
  it('defaults a missing height to APP_HEIGHT_DEFAULT', () => {
    expect(parseEmbedAppAttrs(' url="apps/counter.html" ')).toEqual({
      url: 'apps/counter.html',
      height: APP_HEIGHT_DEFAULT,
    });
  });
  it('clamps an out-of-range height to [APP_HEIGHT_MIN, APP_HEIGHT_MAX]', () => {
    expect(parseEmbedAppAttrs(' url="a.html" height="10" ')?.height).toBe(APP_HEIGHT_MIN);
    expect(parseEmbedAppAttrs(' url="a.html" height="5000" ')?.height).toBe(APP_HEIGHT_MAX);
    expect(parseEmbedAppAttrs(' url="a.html" height="-50" ')?.height).toBe(APP_HEIGHT_MIN);
  });
  it('falls back to the default for a non-numeric height', () => {
    expect(parseEmbedAppAttrs(' url="a.html" height="huge" ')?.height).toBe(APP_HEIGHT_DEFAULT);
  });
  it('returns null without a url', () => {
    expect(parseEmbedAppAttrs(' height="380" ')).toBeNull();
  });
});

describe('embedNodesFromHtml (tag parsing → node props)', () => {
  it('turns a tag into an image node carrying data-embed/data-size/data-url', () => {
    const nodes = embedNodesFromHtml('<embedded-video url="runs/demo.mp4" size="full" />');
    expect(nodes).toHaveLength(1);
    expect(nodes![0]).toMatchObject({
      type: 'image',
      url: 'runs/demo.mp4',
      data: {
        hProperties: { dataEmbed: 'video', dataSize: 'full', dataUrl: 'runs/demo.mp4' },
      },
    });
  });
  it('turns an app tag into an image node carrying data-embed=app/data-height/data-url', () => {
    const nodes = embedNodesFromHtml('<embedded-app url="apps/counter.html" height="380" />');
    expect(nodes).toHaveLength(1);
    expect(nodes![0]).toMatchObject({
      type: 'image',
      url: 'apps/counter.html',
      data: {
        hProperties: { dataEmbed: 'app', dataHeight: '380', dataUrl: 'apps/counter.html' },
      },
    });
  });
  it('keeps text around tags and returns null when no tag is present', () => {
    const nodes = embedNodesFromHtml('before <embedded-image url="a.png" /> after');
    expect(nodes!.map((n) => n.type)).toEqual(['text', 'image', 'text']);
    expect(embedNodesFromHtml('<b>plain html</b>')).toBeNull();
  });
});

describe('markdown pipeline → element props', () => {
  it('renders an http image embed as a real <img> at the mapped width', () => {
    const html = render('Before\n\n<embedded-image url="https://example.com/s.png" size="lg" />\n\nAfter');
    expect(html).toContain('<p>Before</p>');
    expect(html).toContain('<p>After</p>');
    expect(html).toContain('src="https://example.com/s.png"');
    expect(html).toContain('class="embed-media"');
    expect(html).toContain('width:640px'); // lg
    expect(html).not.toContain('embedded-image'); // tag never leaks as text
  });

  it('renders a relative video embed as a reserved-box skeleton at md width', () => {
    const html = render('<embedded-video url="runs/demo.webm" />');
    expect(html).toContain('class="embed-media-frame"');
    expect(html).toContain('class="embed-media-skeleton"');
    expect(html).toContain('width:420px'); // default md
    expect(html).toContain(`aspect-ratio:${DEFAULT_ASPECT_RATIO}`); // no cached url yet
    expect(html).not.toContain('<video'); // src not fetched yet in a static render
  });

  it('rejects file:// urls without emitting any media element', () => {
    const html = render('<embedded-image url="file:///etc/passwd" size="full" />');
    expect(html).toContain('media url rejected');
    expect(html).not.toContain('<img');
  });

  it('gives regular markdown images the same reserved-box + skeleton treatment, wrapped in the lightbox-opening button', () => {
    const html = render('![alt text](https://example.com/plain.png)');
    expect(html).toContain('src="https://example.com/plain.png"');
    expect(html).toContain('alt="alt text"');
    expect(html).toContain('class="embed-media-skeleton"');
    expect(html).toContain('width:100%'); // no size attribute → fills the bubble
    expect(html).toContain(`aspect-ratio:${DEFAULT_ASPECT_RATIO}`); // no cached url yet
    // Wrapped in the same tap-to-open-Lightbox button as EmbeddedMedia.
    expect(html).toContain('class="embed-media-btn embed-media-frame"');
    expect(html).toContain('aria-label="Preview alt text"');
    // Static render: lightboxOpen starts false, so no Lightbox markup yet.
    expect(html).not.toContain('lightbox-backdrop');
  });

  it('leaves non-embed inline html escaped as before', () => {
    const html = render('a <b>bold?</b> b');
    expect(html).toContain('&lt;b&gt;');
  });

  it('renders a local embedded-app as a reserved-box placeholder at the fixed height — AppFrameLayer owns the fetch/skeleton/iframe (A3 hoist fix)', () => {
    const html = render('<embedded-app url="apps/counter.html" height="420" />');
    expect(html).toContain('class="embed-media-frame embed-app-frame"');
    expect(html).toContain('height:420px');
    expect(html).toContain('data-embed-app-url="apps/counter.html"');
    expect(html).toContain('data-embed-app-height="420"');
    expect(html).not.toContain('class="embed-media-skeleton"'); // AppFrameLayer renders the skeleton now
    expect(html).not.toContain('<iframe'); // AppFrameLayer renders the live iframe now
  });

  it('clamps and defaults embedded-app height in the reserved frame', () => {
    expect(render('<embedded-app url="apps/counter.html" />')).toContain(
      `height:${APP_HEIGHT_DEFAULT}px`,
    );
    expect(render('<embedded-app url="apps/counter.html" height="5000" />')).toContain(
      `height:${APP_HEIGHT_MAX}px`,
    );
    expect(render('<embedded-app url="apps/counter.html" height="1" />')).toContain(
      `height:${APP_HEIGHT_MIN}px`,
    );
  });

  it('rejects an http(s) embedded-app url — app iframes never hotlink remote code (unlike media)', () => {
    const html = render('<embedded-app url="https://evil.example/pwn.html" height="300" />');
    expect(html).toContain('app url rejected');
    expect(html).not.toContain('<iframe');
  });

  it('rejects file:// and ".." traversal embedded-app urls', () => {
    expect(render('<embedded-app url="file:///etc/passwd" />')).toContain('app url rejected');
    expect(render('<embedded-app url="../../etc/passwd" />')).toContain('app url rejected');
    expect(render('<embedded-app url="javascript:alert(1)" />')).toContain('app url rejected');
  });

  it('leaves a malformed (url-less) embedded-app tag visible as text', () => {
    const html = render('<embedded-app height="300" />');
    expect(html).toContain('embedded-app');
  });
});

// Mounted (jsdom) render — the only way to observe the post-fetch iframe.
// Post-A3 (hoist fix), EmbeddedApp itself only renders a placeholder
// (data-embed-app-url/-height); the fetch/skeleton/iframe/failed-chip all
// live in AppFrameLayer, which polls the DOM for placeholders (see
// AppFrameLayer.tsx) — so it must be mounted alongside MarkdownImg to
// observe any of that behavior.
describe('EmbeddedApp — live sandboxed micro-app rendering via AppFrameLayer (mounted)', () => {
  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
  });

  it('fetches via authFetch and renders a sandbox="allow-scripts" iframe with NO allow-same-origin', async () => {
    authFetchMock.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<html><body>hi</body></html>'),
    });

    mount(
      createElement(
        Fragment,
        null,
        createElement(MarkdownImg, {
          'data-embed': 'app',
          'data-url': 'apps/counter.html',
          'data-height': '420',
        }),
        createElement(AppFrameLayer),
      ),
    );

    const iframe = (await screen.findByTitle('apps/counter.html')) as HTMLIFrameElement;
    expect(iframe.tagName).toBe('IFRAME');
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(iframe.getAttribute('srcdoc')).toBe('<html><body>hi</body></html>');
    expect(authFetchMock).toHaveBeenCalledWith('/api/media/apps/counter.html');
  });

  it('renders the "app unavailable" chip on a non-ok fetch, never an iframe', async () => {
    authFetchMock.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('') });

    mount(
      createElement(
        Fragment,
        null,
        createElement(MarkdownImg, { 'data-embed': 'app', 'data-url': 'apps/missing.html' }),
        createElement(AppFrameLayer),
      ),
    );

    expect(await screen.findByText('app unavailable: apps/missing.html')).toBeTruthy();
    expect(screen.queryByRole('IFRAME')).toBeNull();
  });

  it('renders the "app unavailable" chip when authFetch itself rejects (network error)', async () => {
    authFetchMock.mockRejectedValue(new Error('network down'));

    mount(
      createElement(
        Fragment,
        null,
        createElement(MarkdownImg, { 'data-embed': 'app', 'data-url': 'apps/counter.html' }),
        createElement(AppFrameLayer),
      ),
    );

    expect(await screen.findByText('app unavailable: apps/counter.html')).toBeTruthy();
  });

  it('never calls authFetch for a rejected (http/scheme) url — no server round-trip for a url that can only be refused', () => {
    mount(
      createElement(MarkdownImg, {
        'data-embed': 'app',
        'data-url': 'https://evil.example/pwn.html',
      }),
    );
    expect(screen.getByText(/app url rejected/)).toBeTruthy();
    expect(authFetchMock).not.toHaveBeenCalled();
  });
});
