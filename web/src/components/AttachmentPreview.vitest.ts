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
  it('tapping the image itself dismisses (no stopPropagation)', () => {
    const onClose = vi.fn();
    render(createElement(Lightbox, { src: 'blob:fake', alt: 'a screenshot', onClose }));
    fireEvent.click(screen.getByAltText('a screenshot'));
    expect(onClose).toHaveBeenCalledTimes(1);
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

describe('Lightbox — scroll position preservation (opening the modal must not scroll the page)', () => {
  // A synthetic scroll container standing in for `.thread-viewport` (or any
  // other pane) — findScrollParent() is class-name-agnostic (walks ancestors
  // for computed overflow-y + real overflow), so a plain styled/stubbed div
  // is enough; it does not need the real class name to be picked up.
  function makeScrollParent(initialScrollTop: number): { scrollParent: HTMLElement; container: HTMLElement } {
    const scrollParent = document.createElement('div');
    scrollParent.style.overflowY = 'auto';
    Object.defineProperty(scrollParent, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollParent, 'clientHeight', { value: 300, configurable: true });
    document.body.appendChild(scrollParent);
    const container = document.createElement('div');
    scrollParent.appendChild(container);
    scrollParent.scrollTop = initialScrollTop;
    return { scrollParent, container };
  }

  it('focuses the dialog with preventScroll (the actual fix for the reported jump)', () => {
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    render(createElement(Lightbox, { src: 'blob:fake', alt: 'shot', onClose: () => {} }));
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    focusSpy.mockRestore();
  });

  it('leaves the scroll parent untouched on mount (no real DOM jump in jsdom, sanity check)', () => {
    const { scrollParent, container } = makeScrollParent(240);
    render(createElement(Lightbox, { src: 'blob:fake', alt: 'shot', onClose: () => {} }), { container });
    expect(scrollParent.scrollTop).toBe(240);
    document.body.removeChild(scrollParent);
  });

  it('restores the scroll parent immediately if focusing the dialog moved it (simulated engine jump)', () => {
    const { scrollParent, container } = makeScrollParent(240);
    // Simulate the real-world bug this fixes: some engines scroll an
    // ancestor container to "reveal" a newly focused descendant even though
    // the dialog is position:fixed and already fills the viewport.
    const focusSpy = vi
      .spyOn(HTMLElement.prototype, 'focus')
      .mockImplementation(() => {
        scrollParent.scrollTop = 0;
      });

    render(createElement(Lightbox, { src: 'blob:fake', alt: 'shot', onClose: () => {} }), { container });

    expect(scrollParent.scrollTop).toBe(240); // restored right after the simulated jump
    focusSpy.mockRestore();
    document.body.removeChild(scrollParent);
  });

  it('restores the pre-open scrollTop on unmount (dismiss)', () => {
    const { scrollParent, container } = makeScrollParent(180);
    const { unmount } = render(
      createElement(Lightbox, { src: 'blob:fake', alt: 'shot', onClose: () => {} }),
      { container },
    );
    expect(scrollParent.scrollTop).toBe(180);

    scrollParent.scrollTop = 999; // drifted somehow while the Lightbox was open
    unmount();
    expect(scrollParent.scrollTop).toBe(180); // reverted to where the user had it

    document.body.removeChild(scrollParent);
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
