// @vitest-environment jsdom
//
// jsdom (not the file's original bare 'node' default) is required for the
// "EmbeddedApp — live sandboxed micro-app rendering" suite below, which
// mounts via @testing-library/react and needs a real effect lifecycle
// (fetch → setHtml) that renderToStaticMarkup never runs. jsdom is harmless
// to the rest of this file: renderToStaticMarkup needs no DOM at all.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { render as mount, screen, cleanup, fireEvent } from '@testing-library/react';
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
import { EmbeddedApp } from '../components/EmbeddedApp';
import { AppFrameLayer } from '../components/AppFrameLayer';
import { ArtifactPanel } from '../components/ArtifactPanel';
// C2: AppFrameLayer now calls useArtifactPanel() (host-arbitration chip
// click-through), so every mount below needs a provider ancestor —
// ArtifactPanelProvider substitutes 1:1 for the Fragment these mounts used
// to wrap their placeholder + AppFrameLayer children in.
import { ArtifactPanelProvider, appArtifactId, useArtifactPanel } from '../components/ArtifactContext';
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

// Mobile-sheet fix: AppFrameLayer now calls useIsNarrow() (matchMedia)
// internally too (not just ArtifactPanel, see the C3 suite's own local mock
// below), so every mounted suite in this file that mounts AppFrameLayer
// needs one or it throws on mount — jsdom implements no matchMedia at all.
// Default non-narrow (desktop) preserves every pre-existing suite's prior
// (implicitly-desktop) behavior; C3's own identical local mock below is now
// redundant but harmless.
beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
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
function mockRect(over: Partial<DOMRect>): DOMRect {
  const r = { top: 0, left: 0, width: 400, height: 320, x: 0, y: 0, ...over };
  return { ...r, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
}

describe('EmbeddedApp — live sandboxed micro-app rendering via AppFrameLayer (mounted)', () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // jsdom implements no layout at all — every real element's
    // getBoundingClientRect() is always 0x0x0x0. AppFrameLayer's tick()
    // (A3 audit follow-up, FIX 2) treats a zero-sized rect as a
    // hidden-ancestor placeholder and skips tracking it, so without this
    // stub every placeholder in this suite would look "hidden" and never
    // fetch. Default: a plausible on-screen, in-pane rect so the existing
    // fetch/skeleton/iframe/failed-chip tests below exercise that path
    // unchanged; individual tests override via rectSpy.mockReturnValue(...).
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(mockRect({}));
  });

  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    rectSpy.mockRestore();
  });

  it('fetches via authFetch and renders a sandbox="allow-scripts" iframe with NO allow-same-origin', async () => {
    authFetchMock.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<html><body>hi</body></html>'),
    });

    mount(
      createElement(
        ArtifactPanelProvider,
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
    expect(authFetchMock).toHaveBeenCalledWith('/api/media/apps/counter.html', { cache: 'reload' });
  });

  it('renders the "app unavailable" chip on a non-ok fetch, never an iframe', async () => {
    authFetchMock.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('') });

    // B audit follow-up (CP3-B, FIX 4): the original `screen.queryByRole('IFRAME')`
    // was unconditionally null — 'IFRAME' (uppercase) is never a valid ARIA
    // role name, so the query can never match regardless of what actually
    // renders. AppFrameLayer's hoisted iframe portals to document.body, not
    // into `render()`'s own `container` div (a sibling under body) — a real
    // DOM query needs `baseElement` (defaults to document.body, so it covers
    // both the placeholder's container and the portal) to be able to fail.
    const { baseElement } = mount(
      createElement(
        ArtifactPanelProvider,
        null,
        createElement(MarkdownImg, { 'data-embed': 'app', 'data-url': 'apps/missing.html' }),
        createElement(AppFrameLayer),
      ),
    );

    expect(await screen.findByText('app unavailable: apps/missing.html')).toBeTruthy();
    expect(baseElement.querySelector('iframe')).toBeNull();
  });

  it('renders the "app unavailable" chip when authFetch itself rejects (network error)', async () => {
    authFetchMock.mockRejectedValue(new Error('network down'));

    mount(
      createElement(
        ArtifactPanelProvider,
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

  // A3 audit follow-up (CP3-A, FIX 2): a hidden-ancestor placeholder (mobile
  // back-nav's display:none on the whole detail pane — the placeholder stays
  // mounted) reports a zero-sized rect in a real browser. tick() must treat
  // that exactly like a removed placeholder and evict through the same
  // GRACE_MS path, not leak the slot (and its live iframe) forever.
  it('FIX 2: evicts the slot after grace once the placeholder rect collapses to zero (hidden ancestor)', async () => {
    authFetchMock.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<html><body>hi</body></html>'),
    });

    mount(
      createElement(
        ArtifactPanelProvider,
        null,
        createElement(MarkdownImg, { 'data-embed': 'app', 'data-url': 'apps/hideme.html' }),
        createElement(AppFrameLayer),
      ),
    );

    await screen.findByTitle('apps/hideme.html');
    expect(document.querySelector('.embed-app-hoist')).toBeTruthy();

    // Simulate the ancestor going display:none — every rect on this element
    // collapses to zero, same as a real browser under a hidden ancestor.
    rectSpy.mockReturnValue(mockRect({ width: 0, height: 0 }));

    // GRACE_MS is 250ms (AppFrameLayer.tsx) — wait comfortably past it. Real
    // rAF (jsdom polyfills it on a ~16ms timer) keeps tick() running since
    // the slot is still alive during the grace window (FIX 3).
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(document.querySelector('.embed-app-hoist')).toBeNull();
  });

  // A3 audit follow-up (CP3-A, FIX 1): a placeholder scrolled fully outside
  // its clipping pane must hide (no paint-over/click-through onto chrome
  // outside the pane) WITHOUT evicting — scrolling back into view must not
  // reload it, the whole point of the hoist layer.
  it('FIX 1: hides (not evicts) a slot whose placeholder sits entirely outside its pane', async () => {
    authFetchMock.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<html><body>hi</body></html>'),
    });
    // No .thread-viewport ancestor here, so computePaneClip falls back to the
    // layout viewport (window.innerWidth/Height, jsdom defaults to
    // 1024x768) — a rect far above it never intersects.
    rectSpy.mockReturnValue(mockRect({ top: -5000, left: 0, width: 300, height: 200 }));

    mount(
      createElement(
        ArtifactPanelProvider,
        null,
        createElement(MarkdownImg, { 'data-embed': 'app', 'data-url': 'apps/offpane.html' }),
        createElement(AppFrameLayer),
      ),
    );

    const hoist = await waitForHoist();
    expect(hoist.style.visibility).toBe('hidden');
    expect(hoist.style.pointerEvents).toBe('none');

    // Still alive well past GRACE_MS — paneHidden must never trigger eviction.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(document.querySelector('.embed-app-hoist')).toBeTruthy();
  });

  // B2: reload button + crash beacon, both owned by AppFrameLayer (see its
  // module doc comment). These exercise the real cockpit:app-reload +
  // message listeners end-to-end, not just the pure appBeacon.ts helpers
  // (appBeacon.vitest.ts already covers those in isolation).
  describe('B2: reload + crash beacon (AppFrameLayer message/cockpit:app-reload listeners)', () => {
    it('manual reload works with no beacon ever having fired — via a real click on the rendered button', async () => {
      authFetchMock.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html><body>v1</body></html>'),
      });

      mount(
        createElement(
          ArtifactPanelProvider,
          null,
          createElement(MarkdownImg, { 'data-embed': 'app', 'data-url': 'apps/reload-me.html' }),
          createElement(AppFrameLayer),
        ),
      );

      const iframe1 = (await screen.findByTitle('apps/reload-me.html')) as HTMLIFrameElement;
      expect(iframe1.getAttribute('srcdoc')).toBe('<html><body>v1</body></html>');
      expect(authFetchMock).toHaveBeenCalledTimes(1);

      authFetchMock.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html><body>v2</body></html>'),
      });
      // B audit follow-up (CP3-B, FIX 2): click the real rendered
      // AppReloadButton instead of dispatching the cockpit:app-reload
      // CustomEvent directly, so the event-name string + detail:{url} wiring
      // between the button and AppFrameLayer's listener is covered
      // end-to-end, not just AppFrameLayer's listener in isolation.
      fireEvent.click(screen.getByLabelText('Reload app'));

      await vi.waitFor(() => {
        const iframe2 = screen.getByTitle('apps/reload-me.html') as HTMLIFrameElement;
        expect(iframe2.getAttribute('srcdoc')).toBe('<html><body>v2</body></html>');
      });
      expect(authFetchMock).toHaveBeenCalledTimes(2);
    });

    it('a validated cc-app-error beacon from the tracked iframe marks the slot crashed', async () => {
      authFetchMock.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html><body>hi</body></html>'),
      });

      mount(
        createElement(
          ArtifactPanelProvider,
          null,
          createElement(MarkdownImg, { 'data-embed': 'app', 'data-url': 'apps/crashme.html' }),
          createElement(AppFrameLayer),
        ),
      );

      const iframe = (await screen.findByTitle('apps/crashme.html')) as HTMLIFrameElement;
      const win = iframe.contentWindow;
      expect(win).toBeTruthy();

      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'cc-app-error', message: 'boom' }, source: win }),
      );

      expect(await screen.findByText('app crashed: apps/crashme.html')).toBeTruthy();
      expect(screen.queryByTitle('apps/crashme.html')).toBeNull();
      // B audit follow-up (CP3-B, FIX 3): the beacon's own message is now
      // surfaced in the crashed strip, not just the url.
      expect(screen.getByText('boom')).toBeTruthy();
    });

    it('ignores a spoofed-source beacon — same shape, wrong window', async () => {
      authFetchMock.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html><body>hi</body></html>'),
      });

      mount(
        createElement(
          ArtifactPanelProvider,
          null,
          createElement(MarkdownImg, { 'data-embed': 'app', 'data-url': 'apps/nospoof.html' }),
          createElement(AppFrameLayer),
        ),
      );

      await screen.findByTitle('apps/nospoof.html');

      // window (the top frame itself) is never the tracked iframe's
      // contentWindow — a same-shape message from it must be ignored.
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'cc-app-error' }, source: window }));

      // Give any (incorrect) crash handling a tick to land, then assert it didn't.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByText(/app crashed/)).toBeNull();
      expect(screen.getByTitle('apps/nospoof.html')).toBeTruthy();
    });

    it('reload recovers a crashed slot back to a live iframe', async () => {
      authFetchMock.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html><body>v1</body></html>'),
      });

      mount(
        createElement(
          ArtifactPanelProvider,
          null,
          createElement(MarkdownImg, { 'data-embed': 'app', 'data-url': 'apps/recover.html' }),
          createElement(AppFrameLayer),
        ),
      );

      const iframe = (await screen.findByTitle('apps/recover.html')) as HTMLIFrameElement;
      const win = iframe.contentWindow;

      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'cc-app-error' }, source: win }),
      );
      await screen.findByText('app crashed: apps/recover.html');

      authFetchMock.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('<html><body>recovered</body></html>'),
      });
      window.dispatchEvent(
        new CustomEvent('cockpit:app-reload', { detail: { url: 'apps/recover.html' } }),
      );

      await vi.waitFor(() => {
        expect(screen.queryByText(/app crashed/)).toBeNull();
      });
      const recoveredIframe = (await screen.findByTitle('apps/recover.html')) as HTMLIFrameElement;
      expect(recoveredIframe.getAttribute('srcdoc')).toBe('<html><body>recovered</body></html>');
    });
  });
});

describe('D cache-bypass (capstone follow-up)', () => {
  beforeEach(() => {
    authFetchMock.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  it('app html fetches always pass cache:"reload" — same-URL reloads must not serve the browser cache', async () => {
    authFetchMock.mockResolvedValue({ ok: true, text: async () => '<html>fresh</html>' });
    mount(
      createElement(ArtifactPanelProvider, null,
        createElement(EmbeddedApp, { url: 'apps/cachetest.html', height: 360, context: 'panel' as const }),
        createElement(AppFrameLayer, null),
      ),
    );
    await vi.waitFor(() => expect(authFetchMock).toHaveBeenCalled());
    const [, init] = authFetchMock.mock.calls[0];
    expect(init).toMatchObject({ cache: 'reload' });
  });
});

describe('C audit follow-up (CP3-C, FIX 1): panel hosts survive a mobile back-nav (display:none) collapse', () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Mirrors App.tsx's `.detail{display:none}` mobile back-nav toggle: a
    // placeholder inside a `[data-collapsed="true"]` ancestor zero-rects,
    // same as it would under a real `display:none` in a real browser (jsdom
    // computes no layout at all, so this is the same simulation technique
    // the existing "FIX 2: evicts..." test above already uses).
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.closest('[data-collapsed="true"]')) return mockRect({ width: 0, height: 0 });
      return mockRect({});
    });
  });

  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    rectSpy.mockRestore();
  });

  it('a panel-context host survives a mobile back-nav collapse (hide, not evict) with no re-fetch on un-hide, while a transcript-context host under the identical collapse still evicts (Phase A behavior intact)', async () => {
    authFetchMock.mockResolvedValue({ ok: true, text: () => Promise.resolve('<html><body>hi</body></html>') });

    function callsFor(url: string): number {
      return authFetchMock.mock.calls.filter((args) => args[0] === `/api/media/${url}`).length;
    }

    function Scene({ collapsed }: { collapsed: boolean }) {
      return createElement(
        ArtifactPanelProvider,
        null,
        createElement(
          'div',
          { 'data-collapsed': collapsed ? 'true' : 'false' },
          createElement(EmbeddedApp, { url: 'apps/pinned-panel.html', height: 320, context: 'panel' }),
          createElement(EmbeddedApp, { url: 'apps/transcript-only.html', height: 320, context: 'transcript' }),
        ),
        createElement(AppFrameLayer),
      );
    }

    const { rerender } = mount(createElement(Scene, { collapsed: false }));

    await screen.findByTitle('apps/pinned-panel.html');
    await screen.findByTitle('apps/transcript-only.html');
    expect(callsFor('apps/pinned-panel.html')).toBe(1);
    expect(callsFor('apps/transcript-only.html')).toBe(1);

    // Mobile back-nav: App.tsx's `.detail` flips to display:none. Both
    // placeholders stay mounted (App.tsx never unmounts them, only the CSS
    // toggles) but their rects collapse to zero — exactly the real-world
    // trigger for this bug.
    rerender(createElement(Scene, { collapsed: true }));

    // Past GRACE_MS (250ms).
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Panel host: hidden via visibility, slot survives — no re-fetch.
    const panelIframe = screen.getByTitle('apps/pinned-panel.html') as HTMLIFrameElement;
    const panelHoist = panelIframe.closest('.embed-app-hoist') as HTMLElement;
    expect(panelHoist.style.visibility).toBe('hidden');
    expect(panelHoist.style.pointerEvents).toBe('none');
    expect(callsFor('apps/pinned-panel.html')).toBe(1);

    // Transcript host: evicted — Phase A's unbounded-embed leak guard is untouched.
    expect(screen.queryByTitle('apps/transcript-only.html')).toBeNull();

    // Un-hide (mobile nav returns to the detail pane).
    rerender(createElement(Scene, { collapsed: false }));

    await vi.waitFor(() => {
      expect(screen.getByTitle('apps/transcript-only.html')).toBeTruthy();
    });
    const revealedPanelHoist = (screen.getByTitle('apps/pinned-panel.html') as HTMLElement).closest(
      '.embed-app-hoist',
    ) as HTMLElement;
    expect(revealedPanelHoist.style.visibility).toBe('visible');

    expect(callsFor('apps/pinned-panel.html')).toBe(1); // never re-fetched
    expect(callsFor('apps/transcript-only.html')).toBe(2); // evicted -> re-fetched on return
  });
});

// Phase C, C2: multi-placeholder host arbitration + the "open in panel"
// chip. Mounts EmbeddedApp directly (rather than via MarkdownImg's
// transcript-only remark pipeline) so a test can put a `context: 'panel'`
// placeholder in the DOM alongside a `context: 'transcript'` one for the
// same url — the real-world shape once an app is pinned (ArtifactPanel
// renders the panel placeholder; the original transcript embed keeps
// rendering its own, per AppFrameLayer.tsx's module doc comment).
describe('C2: multi-placeholder host arbitration + panel chip (mounted)', () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Discriminate by the placeholder's own data-embed-app-context attribute
    // so a panel-context and a transcript-context placeholder for the same
    // url get distinguishable, non-zero rects — proving tick() follows the
    // HOST's rect (panel wins), not whichever happened to be found first.
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset?.embedAppContext === 'panel') {
        return mockRect({ top: 500, left: 500, width: 300, height: 300 });
      }
      return mockRect({});
    });
  });

  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    rectSpy.mockRestore();
  });

  it('a panel-context placeholder hosts the iframe over a transcript-context placeholder for the same url', async () => {
    authFetchMock.mockResolvedValue({ ok: true, text: () => Promise.resolve('<html><body>hi</body></html>') });

    mount(
      createElement(
        ArtifactPanelProvider,
        null,
        createElement(EmbeddedApp, { url: 'apps/dual.html', height: 320, context: 'transcript' }),
        createElement(EmbeddedApp, { url: 'apps/dual.html', height: 320, context: 'panel' }),
        createElement(AppFrameLayer),
      ),
    );

    const iframe = (await screen.findByTitle('apps/dual.html')) as HTMLIFrameElement;
    // Exactly one live iframe for the url, regardless of two placeholders.
    expect(screen.getAllByTitle('apps/dual.html')).toHaveLength(1);
    const hoist = iframe.closest('.embed-app-hoist') as HTMLElement;
    // Follows the PANEL placeholder's rect (500/500), not the transcript
    // one's (0/0) — proving panel-context won host arbitration. Position is
    // via `transform` (scroll-lag fix, AppFrameLayer.tsx) — top/left are
    // fixed at 0 from mount, translate3d carries the actual offset.
    expect(hoist.style.top).toBe('0px');
    expect(hoist.style.left).toBe('0px');
    expect(hoist.style.transform).toBe('translate3d(500px, 500px, 0)');

    // The non-host (transcript) placeholder gets a click-to-focus chip
    // instead of a second, invisible-anyway iframe.
    expect(await screen.findByText('open in panel ↗')).toBeTruthy();
  });

  it('clicking the chip calls setActive(appArtifactId(url)) to focus the panel tab', async () => {
    authFetchMock.mockResolvedValue({ ok: true, text: () => Promise.resolve('<html><body>hi</body></html>') });

    function ActiveIdProbe() {
      const { activeId } = useArtifactPanel();
      return createElement('div', { 'data-testid': 'active-id' }, activeId ?? 'none');
    }

    mount(
      createElement(
        ArtifactPanelProvider,
        null,
        createElement(ActiveIdProbe),
        createElement(EmbeddedApp, { url: 'apps/dual2.html', height: 320, context: 'transcript' }),
        createElement(EmbeddedApp, { url: 'apps/dual2.html', height: 320, context: 'panel' }),
        createElement(AppFrameLayer),
      ),
    );

    await screen.findByTitle('apps/dual2.html');
    const chip = await screen.findByText('open in panel ↗');
    fireEvent.click(chip);

    expect(screen.getByTestId('active-id').textContent).toBe(appArtifactId('apps/dual2.html'));
  });

  it('an explicitly-hidden (inactive panel tab) placeholder hides the iframe via visibility, never evicts it', async () => {
    authFetchMock.mockResolvedValue({ ok: true, text: () => Promise.resolve('<html><body>hi</body></html>') });

    mount(
      createElement(
        ArtifactPanelProvider,
        null,
        createElement(EmbeddedApp, { url: 'apps/hiddentab.html', height: 320, context: 'panel', hidden: true }),
        createElement(AppFrameLayer),
      ),
    );

    const iframe = (await screen.findByTitle('apps/hiddentab.html')) as HTMLIFrameElement;
    const hoist = iframe.closest('.embed-app-hoist') as HTMLElement;
    expect(hoist.style.visibility).toBe('hidden');
    expect(hoist.style.pointerEvents).toBe('none');

    // Still alive well past GRACE_MS — hidden must never trigger eviction,
    // the same "hide, never evict" contract as FIX 1's pane-clipping case
    // (tick() folds data-embed-app-hidden into the same paneHidden flag).
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(screen.queryByTitle('apps/hiddentab.html')).toBeTruthy();
  });

  // CP3-C FIX 5: pickHost's panel-always-wins rule is UNCONDITIONAL on
  // explicitlyHidden (an inactive-but-pinned panel tab still hosts — see
  // pickHost's doc comment in AppFrameLayer.tsx). Guard that a hidden panel
  // host still correctly out-arbitrates a visible transcript placeholder:
  // the chip must show (not a silent duplicate iframe) and must still focus
  // the right tab.
  it('a hidden (inactive-tab) panel host still yields its host role — the transcript chip shows and clicking it still focuses the tab', async () => {
    authFetchMock.mockResolvedValue({ ok: true, text: () => Promise.resolve('<html><body>hi</body></html>') });

    function ActiveIdProbe() {
      const { activeId } = useArtifactPanel();
      return createElement('div', { 'data-testid': 'active-id' }, activeId ?? 'none');
    }

    mount(
      createElement(
        ArtifactPanelProvider,
        null,
        createElement(ActiveIdProbe),
        createElement(EmbeddedApp, { url: 'apps/hidden-host.html', height: 320, context: 'transcript' }),
        createElement(EmbeddedApp, {
          url: 'apps/hidden-host.html',
          height: 320,
          context: 'panel',
          hidden: true, // inactive panel tab — still the HOST, per pickHost's unconditional context rule
        }),
        createElement(AppFrameLayer),
      ),
    );

    await screen.findByTitle('apps/hidden-host.html');
    expect(screen.getAllByTitle('apps/hidden-host.html')).toHaveLength(1);

    const chip = await screen.findByText('open in panel ↗');
    fireEvent.click(chip);

    expect(screen.getByTestId('active-id').textContent).toBe(appArtifactId('apps/hidden-host.html'));
  });

  it('falls back to first-in-document-order for two transcript-context duplicates and renders no misleading "panel" chip', async () => {
    authFetchMock.mockResolvedValue({ ok: true, text: () => Promise.resolve('<html><body>hi</body></html>') });

    mount(
      createElement(
        ArtifactPanelProvider,
        null,
        createElement(EmbeddedApp, { url: 'apps/twice.html', height: 320, context: 'transcript' }),
        createElement(EmbeddedApp, { url: 'apps/twice.html', height: 320, context: 'transcript' }),
        createElement(AppFrameLayer),
      ),
    );

    await screen.findByTitle('apps/twice.html');
    expect(screen.getAllByTitle('apps/twice.html')).toHaveLength(1);
    // No panel placeholder exists for this url — the second transcript
    // duplicate must NOT claim "open in panel" (that would be a lie).
    expect(screen.queryByText('open in panel ↗')).toBeNull();
  });
});

// Phase C, C3: the pin-to-panel affordance rendered by AppFrameLayer next to
// AppReloadButton. Mounts the real trio a thread mounts — EmbeddedApp
// (transcript), AppFrameLayer, and ArtifactPanel — so the acceptance bar
// ("pinning from transcript creates/focuses the app tab; pinning twice
// focuses (no duplicate); transcript embed stays functional independently")
// is proven end-to-end through the actual pin button + panel UI, not by
// calling useArtifactPanel().open() directly.
describe('C3: pin-to-panel affordance (mounted)', () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // ArtifactPanel calls useIsNarrow() (matchMedia) — not needed by any
    // other suite in this file since none of them mount ArtifactPanel.
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(mockRect({}));
    authFetchMock.mockResolvedValue({ ok: true, text: () => Promise.resolve('<html><body>hi</body></html>') });
  });

  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    rectSpy.mockRestore();
  });

  it('pinning from the transcript creates+focuses a panel tab; pinning again focuses without duplicating; unpinning keeps the transcript embed working with no extra fetch', async () => {
    mount(
      createElement(
        ArtifactPanelProvider,
        null,
        createElement(EmbeddedApp, { url: 'apps/pin1.html', height: 320, context: 'transcript' }),
        createElement(AppFrameLayer),
        createElement(ArtifactPanel),
      ),
    );

    await screen.findByTitle('apps/pin1.html');
    expect(authFetchMock).toHaveBeenCalledTimes(1);
    // No artifact pinned yet — no panel, no tab.
    expect(screen.queryByRole('tab')).toBeNull();

    fireEvent.click(screen.getByLabelText('Pin to panel'));

    // A panel tab appears, titled from the url's basename, and is focused.
    const tab = await screen.findByRole('tab', { name: 'pin1.html' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    // Host arbitration hands the iframe to the (now-mounted) panel
    // placeholder; the transcript placeholder becomes a shadow with the
    // click-to-focus chip — still exactly one live iframe for the url.
    expect(await screen.findByText('open in panel ↗')).toBeTruthy();
    expect(screen.getAllByTitle('apps/pin1.html')).toHaveLength(1);
    expect(authFetchMock).toHaveBeenCalledTimes(1); // pinning never re-fetches
    expect(screen.getByLabelText('Pinned to panel')).toBeTruthy(); // button reflects pinned state

    // Pin again — idempotent focus, no duplicate tab, no extra fetch.
    fireEvent.click(screen.getByLabelText('Pinned to panel'));
    expect(screen.getAllByRole('tab', { name: 'pin1.html' })).toHaveLength(1);
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    // Unpin via the panel's own close control — the transcript embed keeps
    // functioning: host arbitration falls back to it (still the SAME
    // tracked slot, no new fetch), and the "open in panel" chip goes away.
    fireEvent.click(screen.getByLabelText('Close pin1.html'));
    await vi.waitFor(() => {
      expect(screen.queryByText('open in panel ↗')).toBeNull();
    });
    expect(await screen.findByTitle('apps/pin1.html')).toBeTruthy();
    expect(authFetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Pin to panel')).toBeTruthy(); // back to unpinned state
  });
});

function waitForHoist(): Promise<HTMLElement> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const poll = () => {
      const el = document.querySelector<HTMLElement>('.embed-app-hoist');
      if (el) return resolve(el);
      if (Date.now() > deadline) return reject(new Error('.embed-app-hoist never appeared'));
      setTimeout(poll, 20);
    };
    poll();
  });
}
