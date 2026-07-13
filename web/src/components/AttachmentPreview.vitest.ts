// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { AttachPreviewItem, Lightbox } from './AttachmentPreview';
import { MarkdownImg } from './EmbeddedMedia';

// AttachPreviewItem's tap-open path (unlike the plain/embedded-image paths
// below) always goes through useAuthedBlobUrl -> authFetch, since upload
// thumbnails can't authenticate a plain <img src>. Mocked once, module-wide
// (vi.mock is hoisted above these imports by the vite/vitest transform),
// matching the same pattern ArtifactPanel.vitest.ts uses for the same reason.
const authFetchMock = vi.fn();
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, authFetch: (...args: Parameters<typeof actual.authFetch>) => authFetchMock(...args) };
});

// Default authFetch to a Promise that never settles: tests elsewhere in this
// file exercise EmbeddedMedia's relative-url (kind: 'fetch') branch without
// caring about the network response (they only assert the pre-resolve
// state), and the module-wide mock above would otherwise make every one of
// those calls return `undefined` (crashing on `.then`) unless a specific test
// opts in with its own mockResolvedValue/mockReset.
beforeEach(() => {
  authFetchMock.mockReset();
  authFetchMock.mockImplementation(() => new Promise(() => {}));
});

afterEach(cleanup);
// Belt and braces: a test that throws before its effect cleanup runs would
// otherwise leak `lightbox-open` onto <html> and poison every test after it.
afterEach(() => document.documentElement.classList.remove('lightbox-open'));

describe('Lightbox', () => {
  it('tapping the image itself no longer dismisses (deliberate change — see stopPropagation in AttachmentPreview.tsx)', () => {
    // A single click on the image now has to coexist with drag-to-pan and
    // double-tap-to-zoom, neither of which can work if the first tap also
    // unmounts the Lightbox. Only the backdrop and the explicit X close it.
    const onClose = vi.fn();
    render(createElement(Lightbox, { src: 'blob:fake', alt: 'a screenshot', onClose }));
    fireEvent.click(screen.getByAltText('a screenshot'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('tapping the backdrop (outside the image) still dismisses', () => {
    const onClose = vi.fn();
    render(createElement(Lightbox, { src: 'blob:fake', alt: 'a screenshot', onClose }));
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape still dismisses', () => {
    const onClose = vi.fn();
    render(createElement(Lightbox, { src: 'blob:fake', alt: 'a screenshot', onClose }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('adds lightbox-open to <html> on mount and removes it on unmount', () => {
    expect(document.documentElement.classList.contains('lightbox-open')).toBe(false);
    const { unmount } = render(
      createElement(Lightbox, { src: 'blob:fake', alt: 'a screenshot', onClose: () => {} }),
    );
    expect(document.documentElement.classList.contains('lightbox-open')).toBe(true);
    unmount();
    expect(document.documentElement.classList.contains('lightbox-open')).toBe(false);
  });

  it('blocks touchmove on the backdrop: preventDefault fires and it never bubbles past the overlay', () => {
    // Regression guard for the app's OWN pull-to-refresh (hooks/usePullToRefresh.ts),
    // which listens for touchmove on an ancestor of the transcript (and therefore
    // of the Lightbox, which mounts inside it) — see the comment in Lightbox's
    // scroll-lock effect. If this listener stopped calling stopPropagation, a
    // drag on the overlay could still reach that hook and trigger a hard reload.
    render(createElement(Lightbox, { src: 'blob:fake', alt: 'a screenshot', onClose: () => {} }));
    const backdrop = screen.getByRole('dialog');
    const ancestorHandler = vi.fn();
    document.body.addEventListener('touchmove', ancestorHandler);

    const evt = new TouchEvent('touchmove', { bubbles: true, cancelable: true });
    const notCancelled = backdrop.dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(true);
    expect(notCancelled).toBe(false); // dispatchEvent returns false once preventDefault() is called
    expect(ancestorHandler).not.toHaveBeenCalled();

    document.body.removeEventListener('touchmove', ancestorHandler);
  });

  it('renders an explicit X close button with aria-label "Close" (on top of, not instead of, tap-anywhere-closes)', () => {
    render(createElement(Lightbox, { src: 'blob:fake', alt: 'a screenshot', onClose: () => {} }));
    const closeBtn = screen.getByRole('button', { name: 'Close' });
    expect(closeBtn.tagName).toBe('BUTTON');
  });

  it('clicking the X close button closes (and only fires onClose once, not double-counted via the backdrop)', () => {
    const onClose = vi.fn();
    render(createElement(Lightbox, { src: 'blob:fake', alt: 'a screenshot', onClose }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Lightbox — portal + focus (opening the modal must not scroll or get trapped by an ancestor pane)', () => {
  it('focuses the dialog with preventScroll (standard dialog-focus hygiene)', () => {
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    render(createElement(Lightbox, { src: 'blob:fake', alt: 'shot', onClose: () => {} }));
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    focusSpy.mockRestore();
  });

  it('mounts directly on document.body regardless of the render container (real portal — a scrollable ancestor pane can no longer trap it)', () => {
    // Regression guard for the root cause of the reported "Lightbox squished
    // into a drawer" / off-viewport bug class: any transformed, contain-ing,
    // or will-change:transform ancestor (e.g. SubAgentPanel's GSAP drawer)
    // becomes a NEW containing block for a position:fixed descendant that
    // isn't portaled — see the comment in SubAgentPanel.tsx. A real portal to
    // document.body sidesteps that structurally, regardless of what DOM tree
    // rendered the triggering <img>.
    const outer = document.createElement('div');
    outer.style.overflowY = 'auto';
    document.body.appendChild(outer);
    const inner = document.createElement('div');
    outer.appendChild(inner);

    render(createElement(Lightbox, { src: 'blob:fake', alt: 'shot', onClose: () => {} }), { container: inner });

    const dialog = screen.getByRole('dialog');
    expect(dialog.parentElement).toBe(document.body);
    expect(outer.contains(dialog)).toBe(false);

    document.body.removeChild(outer);
  });
});

describe('Lightbox — zoom/pan', () => {
  /** jsdom has no layout engine (naturalWidth/offsetWidth are always 0), so
   * gesture math that reads the image's real/displayed size needs an
   * explicit stub per test. */
  function mockImageSize(
    img: HTMLImageElement,
    natural: { width: number; height: number },
    displayed: { width: number; height: number },
  ) {
    Object.defineProperty(img, 'naturalWidth', { value: natural.width, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: natural.height, configurable: true });
    Object.defineProperty(img, 'offsetWidth', { value: displayed.width, configurable: true });
    Object.defineProperty(img, 'offsetHeight', { value: displayed.height, configurable: true });
  }

  it('starts at Fit (scale 1, no pan) with the toolbar showing "Fit"', () => {
    render(createElement(Lightbox, { src: 'blob:fake', alt: 'shot', onClose: () => {} }));
    const img = screen.getByAltText('shot') as HTMLImageElement;
    expect(img.dataset.zoomed).toBe('false');
    expect(img.style.transform).toBe('translate(0px, 0px) scale(1)');
    expect(screen.getByRole('button', { name: 'Toggle fit / 100% zoom' }).textContent).toBe('Fit');
  });

  it('double-click toggles Fit -> 100% -> Fit, driving the transform, data-zoomed and the toolbar label', () => {
    render(createElement(Lightbox, { src: 'blob:fake', alt: 'shot', onClose: () => {} }));
    const img = screen.getByAltText('shot') as HTMLImageElement;
    mockImageSize(img, { width: 2000, height: 1000 }, { width: 1000, height: 500 }); // actual-size ratio: 2x

    fireEvent.doubleClick(img);
    expect(img.dataset.zoomed).toBe('true');
    expect(img.style.transform).toContain('scale(2)');
    expect(screen.getByRole('button', { name: 'Toggle fit / 100% zoom' }).textContent).toBe('200%');

    fireEvent.doubleClick(img);
    expect(img.dataset.zoomed).toBe('false');
    expect(img.style.transform).toBe('translate(0px, 0px) scale(1)');
    expect(screen.getByRole('button', { name: 'Toggle fit / 100% zoom' }).textContent).toBe('Fit');
  });

  it('double-click does not also close the Lightbox (stopPropagation)', () => {
    const onClose = vi.fn();
    render(createElement(Lightbox, { src: 'blob:fake', alt: 'shot', onClose }));
    const img = screen.getByAltText('shot') as HTMLImageElement;
    mockImageSize(img, { width: 2000, height: 1000 }, { width: 1000, height: 500 });
    fireEvent.doubleClick(img);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('the −/+ toolbar buttons step the zoom level by a fixed factor, clamped to the max', () => {
    render(createElement(Lightbox, { src: 'blob:fake', alt: 'shot', onClose: () => {} }));
    const img = screen.getByAltText('shot') as HTMLImageElement;
    // Actual-size ratio here is only 1.2x, below the 4x floor — confirms
    // stepping uses maxZoomScale's floor, not the raw actual-size ratio.
    mockImageSize(img, { width: 1200, height: 1200 }, { width: 1000, height: 1000 });

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(img.style.transform).toContain('scale(1.5)');

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(img.style.transform).toContain('scale(2.25)');

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(img.style.transform).toContain('scale(1.5)');
  });

  it('clicking a zoom-control button does not also close the Lightbox via the backdrop', () => {
    const onClose = vi.fn();
    render(createElement(Lightbox, { src: 'blob:fake', alt: 'shot', onClose }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('mouse drag-to-pan is a no-op until zoomed in, then pans (clamped to the bound)', () => {
    render(createElement(Lightbox, { src: 'blob:fake', alt: 'shot', onClose: () => {} }));
    const img = screen.getByAltText('shot') as HTMLImageElement;
    mockImageSize(img, { width: 2000, height: 2000 }, { width: 1000, height: 1000 }); // 100% == scale 2

    fireEvent.mouseDown(img, { clientX: 500, clientY: 500 });
    fireEvent.mouseMove(window, { clientX: 600, clientY: 460 });
    expect(img.style.transform).toBe('translate(0px, 0px) scale(1)'); // not zoomed yet — drag ignored
    fireEvent.mouseUp(window);

    fireEvent.doubleClick(img); // zoom in to scale 2
    fireEvent.mouseDown(img, { clientX: 500, clientY: 500 });
    fireEvent.mouseMove(window, { clientX: 600, clientY: 460 });
    expect(img.style.transform).toBe('translate(100px, -40px) scale(2)');

    // Max pan at scale 2 on a 1000x1000 box is (1000*(2-1))/2 = 500 per axis.
    fireEvent.mouseMove(window, { clientX: 5000, clientY: 460 });
    expect(img.style.transform).toBe('translate(500px, -40px) scale(2)');

    fireEvent.mouseUp(window);
  });

  it('wheel zooms in, clamped to at least 1x', () => {
    render(createElement(Lightbox, { src: 'blob:fake', alt: 'shot', onClose: () => {} }));
    const img = screen.getByAltText('shot') as HTMLImageElement;
    mockImageSize(img, { width: 2000, height: 1000 }, { width: 1000, height: 500 });

    fireEvent.wheel(screen.getByRole('dialog'), { deltaY: -200 });

    const match = /scale\(([\d.]+)\)/.exec(img.style.transform);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThan(1);
  });

  it('wheel does not also scroll/close anything behind the Lightbox (preventDefault fires)', () => {
    render(createElement(Lightbox, { src: 'blob:fake', alt: 'shot', onClose: () => {} }));
    const dialog = screen.getByRole('dialog');
    const evt = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 });
    dialog.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
  });
});

describe('MarkdownImg — regular (non-embed) markdown images', () => {
  it('renders inside the tap-to-open-Lightbox button and opens the Lightbox on click', () => {
    render(createElement(MarkdownImg, { src: 'https://example.com/plain.png', alt: 'plain shot' }));

    // The <img> itself carries the same src/alt, now inside the reserved-box
    // frame (.embed-media-frame / .embed-media, see EmbeddedMedia.tsx).
    const img = screen.getByAltText('plain shot') as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.src).toBe('https://example.com/plain.png');
    expect(screen.queryByRole('dialog')).toBeNull(); // Lightbox not open yet

    fireEvent.click(screen.getByRole('button', { name: 'Preview plain shot' }));

    // Lightbox is now open, and the alt text flowed through to its aria-label.
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('Preview: plain shot');
  });

  it('falls back to a bare <img> when there is no src (defensive, no crash)', () => {
    render(createElement(MarkdownImg, { alt: 'no src' }));
    expect(screen.getByAltText('no src').tagName).toBe('IMG');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('leaves <embedded-image/> handling on the EmbeddedMedia path, not the plain-image wrapper', () => {
    render(
      createElement(MarkdownImg, {
        'data-embed': 'image',
        'data-url': 'shot.png', // relative path -> src stays null until a blob fetch resolves
        'data-size': 'md',
      }),
    );
    const btn = screen.getByRole('button', { name: 'Preview shot.png' });
    // EmbeddedMedia-only affordance PlainMarkdownImage never sets: a `title`
    // mirroring the raw url (both buttons otherwise share the same
    // `embed-media-btn embed-media-frame` classes post-refactor).
    expect(btn.getAttribute('title')).toBe('shot.png');
    // EmbeddedMedia also gates the click on a resolved `src` — a relative
    // embed with no blob fetched yet makes the click a no-op, unlike
    // PlainMarkdownImage which always opens on click.
    fireEvent.click(btn);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('MarkdownImg — embedded image (data-embed="image") with a direct https url', () => {
  it('tap/click opens the Lightbox once resolveMediaUrl resolves synchronously (kind: direct, no fetch needed)', () => {
    render(
      createElement(MarkdownImg, {
        'data-embed': 'image',
        'data-url': 'https://example.com/embedded-shot.png',
        'data-size': 'md',
      }),
    );
    const btn = screen.getByRole('button', { name: 'Preview https://example.com/embedded-shot.png' });
    expect(screen.queryByRole('dialog')).toBeNull(); // not open yet

    fireEvent.click(btn);

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('Preview: https://example.com/embedded-shot.png');
  });
});

describe('AttachPreviewItem — upload thumbnail tap-to-open (authed blob-URL path)', () => {
  // jsdom has no native URL.createObjectURL/revokeObjectURL; useAuthedBlobUrl
  // (unlike the direct-https paths above) always calls them, so this describe
  // block is the one place in this file that needs to stub them — scoped
  // here and restored after, so it can't leak into other tests/files.
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:mock-thumb-url');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    // Unmount now, while the stubs above are still active — the top-level
    // `afterEach(cleanup)` (registered before this describe block, so it
    // runs AFTER this hook) would otherwise unmount AFTER the restore below,
    // and useAuthedBlobUrl's cleanup calls URL.revokeObjectURL on unmount,
    // which jsdom doesn't natively provide (see file-level comment above).
    cleanup();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it('fetches the thumbnail via authFetch (bearer header, since <img src> cannot send one), then tap opens the Lightbox', async () => {
    const fakeBlob = new Blob(['x'], { type: 'image/png' });
    authFetchMock.mockResolvedValue({ ok: true, blob: () => Promise.resolve(fakeBlob) });

    render(
      createElement(AttachPreviewItem, {
        ref_: {
          fullPath: '/Users/x/.claude-control/uploads/1717000000000-photo.jpg',
          basename: '1717000000000-photo.jpg',
          isImage: true,
        },
      }),
    );

    expect(authFetchMock).toHaveBeenCalledWith('/api/uploads/1717000000000-photo.jpg');
    await screen.findByAltText('1717000000000-photo.jpg'); // waits for the blob URL to resolve and replace the loading placeholder

    fireEvent.click(screen.getByRole('button', { name: 'Preview 1717000000000-photo.jpg' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('Preview: 1717000000000-photo.jpg');
  });
});
