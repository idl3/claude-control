// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { Lightbox } from './AttachmentPreview';
import { MarkdownImg } from './EmbeddedMedia';

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

    // The <img> itself is unchanged (same src/alt the .aui-md img CSS still targets).
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

  it('leaves <embedded-image/> handling on the EmbeddedMedia path, not the new wrapper', () => {
    render(
      createElement(MarkdownImg, {
        'data-embed': 'image',
        'data-url': 'shot.png',
        'data-size': 'md',
      }),
    );
    // EmbeddedMedia's button carries its own class + aria-label shape — not
    // the plain-markdown-image wrapper's.
    expect(screen.getByRole('button', { name: 'Preview shot.png' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Preview shot\.png$/ })?.className).toBe(
      'embed-media-btn',
    );
  });
});
