// @vitest-environment jsdom
//
// Pure geometry/model logic (coordinate transforms, hit-testing, history,
// canvas export drawing) now lives in lib/annotationModel.ts and
// lib/annotationGeometry.ts with their own unit tests — this file covers
// only the mounted <StudioAnnotate> component: the SVG-overlay retained
// object model, tool switching, pointer-driven draw/move/retarget/delete,
// in-place text editing, undo/redo, and the imgReady/onReady/onError/
// exportPng() contract StudioModal.tsx depends on.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, createRef } from 'react';
import { StudioAnnotate, type StudioAnnotateHandle } from './StudioAnnotate';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * jsdom's HTMLImageElement never fires `load`/`error` for a `src` assignment
 * (no resource loading without jsdom's `resources: 'usable'` option, which
 * this project's vitest config doesn't set). StudioAnnotate's decode probe
 * is a DETACHED `new Image()` (deliberately separate from the visible <img>
 * it renders, which React creates via `document.createElement('img')` and
 * which this stub therefore does NOT intercept) — stubbing the global
 * constructor only affects that probe, matching the real component's dual-
 * image strategy. `failSrcs` opts a specific `imageDataUrl` into the
 * failure (onerror) path; every other src succeeds (onload) on the next
 * microtask.
 */
function stubImageLoad(failSrcs: Set<string> = new Set()) {
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 400;
    naturalHeight = 320;
    set src(value: string) {
      queueMicrotask(() => {
        if (failSrcs.has(value)) this.onerror?.();
        else this.onload?.();
      });
    }
  }
  vi.stubGlobal('Image', FakeImage);
}

const IMG_URL = 'data:image/png;base64,AAAA';

// The overlay <svg viewBox="0 0 400 320"> is displayed 1:1 in every test
// (rect matches the natural resolution stubImageLoad() reports), so client
// coordinates == image-space coordinates and every assertion below can use
// plain numbers without doing displayScale math by hand.
const NATURAL_RECT = {
  left: 0,
  top: 0,
  width: 400,
  height: 320,
  right: 400,
  bottom: 320,
  x: 0,
  y: 0,
  toJSON: () => ({}),
} as DOMRect;

async function renderReady(
  overrides: { imageDataUrl?: string; onReady?: ReturnType<typeof vi.fn>; onError?: ReturnType<typeof vi.fn> } = {},
  ref?: React.RefObject<StudioAnnotateHandle>,
) {
  stubImageLoad();
  const onReady = overrides.onReady ?? vi.fn();
  const utils = render(
    createElement(StudioAnnotate, { imageDataUrl: overrides.imageDataUrl ?? IMG_URL, onReady, onError: overrides.onError, ref }),
  );
  const svg = screen.getByTestId('studio-annotate-canvas');
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(NATURAL_RECT);
  await waitFor(() => expect(onReady).toHaveBeenCalledWith(true));
  return { ...utils, svg, onReady };
}

function pointer(svg: Element, type: 'pointerDown' | 'pointerMove' | 'pointerUp', x: number, y: number) {
  fireEvent[type](svg, { clientX: x, clientY: y, pointerId: 1, bubbles: true });
}

function drawPen(svg: Element, points: Array<{ x: number; y: number }>) {
  fireEvent.click(screen.getByRole('button', { name: 'pen' }));
  pointer(svg, 'pointerDown', points[0].x, points[0].y);
  for (const p of points.slice(1)) pointer(svg, 'pointerMove', p.x, p.y);
  pointer(svg, 'pointerUp', points[points.length - 1].x, points[points.length - 1].y);
}

function drawArrow(svg: Element, from: { x: number; y: number }, to: { x: number; y: number }) {
  fireEvent.click(screen.getByRole('button', { name: 'arrow' }));
  pointer(svg, 'pointerDown', from.x, from.y);
  pointer(svg, 'pointerMove', to.x, to.y);
  pointer(svg, 'pointerUp', to.x, to.y);
}

function drawText(svg: Element, at: { x: number; y: number }, content: string) {
  fireEvent.click(screen.getByRole('button', { name: 'text' }));
  pointer(svg, 'pointerDown', at.x, at.y);
  const input = screen.getByTestId('studio-annotate-text-editor');
  fireEvent.change(input, { target: { value: content } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('StudioAnnotate — rendering & tools', () => {
  it('renders select (default, pressed)/pen/arrow/text tool buttons, a color picker, undo/redo/delete, and the overlay canvas', () => {
    render(createElement(StudioAnnotate, { imageDataUrl: IMG_URL }));
    expect(screen.getByTestId('studio-annotate-canvas')).toBeTruthy();
    expect(document.querySelectorAll('.studio-annotate-tool-btn')).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'select' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'pen' }).getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.studio-annotate-color')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'delete annotation' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('switching tools updates aria-pressed and the svg data-tool attribute (cursor affordance hook)', () => {
    render(createElement(StudioAnnotate, { imageDataUrl: IMG_URL }));
    const svg = screen.getByTestId('studio-annotate-canvas');
    expect(svg.getAttribute('data-tool')).toBe('select');
    fireEvent.click(screen.getByRole('button', { name: 'arrow' }));
    expect(svg.getAttribute('data-tool')).toBe('arrow');
    expect(screen.getByRole('button', { name: 'arrow' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'select' }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('StudioAnnotate — decode gating (imgReady / onReady / onError / exportPng)', () => {
  it('exportPng() rejects while the source image has not (yet, or ever) finished decoding', async () => {
    const ref = createRef<StudioAnnotateHandle>();
    render(createElement(StudioAnnotate, { ref, imageDataUrl: IMG_URL }));
    await expect(ref.current?.exportPng()).rejects.toThrow(/not ready/);
  });

  it('exposes exportPng() via the forwarded ref and resolves once the source image decodes', async () => {
    const ref = createRef<StudioAnnotateHandle>();
    const { onReady } = await renderReady({}, ref);
    expect(onReady).toHaveBeenCalledWith(true);
    let out: string | null | undefined;
    await act(async () => {
      out = await ref.current?.exportPng();
    });
    // jsdom has no real canvas rendering backend without the optional
    // `canvas` npm package, so toDataURL()'s exact bytes aren't asserted
    // here — only that the ref-forwarded call resolves cleanly. Real
    // dataUrl content is exercised in StudioModal.vitest.ts's save flow.
    expect(out === null || typeof out === 'string').toBe(true);
  });

  it('a malformed/undecodable dataUrl fires onerror, calls onError(), and never reaches onReady(true)', async () => {
    const malformed = 'data:image/png;base64,not-actually-a-png';
    stubImageLoad(new Set([malformed]));
    const onReady = vi.fn();
    const onError = vi.fn();
    render(createElement(StudioAnnotate, { imageDataUrl: malformed, onReady, onError }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onReady).not.toHaveBeenCalledWith(true);
  });

  it('sets the svg viewBox to the natural resolution once decode succeeds', async () => {
    const { svg } = await renderReady();
    expect(svg.getAttribute('viewBox')).toBe('0 0 400 320');
  });
});

describe('StudioAnnotate — pen tool', () => {
  it('a multi-point stroke commits a visible path and enables Undo', async () => {
    const { svg } = await renderReady();
    drawPen(svg, [{ x: 50, y: 50 }, { x: 80, y: 80 }]);
    const path = svg.querySelector('[data-ann-kind="pen"]');
    expect(path).toBeTruthy();
    expect(path.getAttribute('d')).toBe('M50,50 L80,80');
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a single-point stroke (click with no drag) is discarded — needs at least 2 points', async () => {
    const { svg } = await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'pen' }));
    pointer(svg, 'pointerDown', 10, 10);
    pointer(svg, 'pointerUp', 10, 10);
    expect(svg.querySelector('[data-ann-kind="pen"]')).toBeNull();
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('StudioAnnotate — arrow tool', () => {
  it('drags out an arrow, commits it, auto-selects it, and switches back to select', async () => {
    const { svg } = await renderReady();
    drawArrow(svg, { x: 0, y: 0 }, { x: 100, y: 0 });
    const line = svg.querySelector('[data-ann-kind="arrow"] line');
    expect(line).toBeTruthy();
    expect(line.getAttribute('x1')).toBe('0');
    expect(line.getAttribute('y1')).toBe('0');
    expect(line.getAttribute('x2')).toBe('100');
    expect(line.getAttribute('y2')).toBe('0');
    expect(screen.getByRole('button', { name: 'select' }).getAttribute('aria-pressed')).toBe('true');
    expect(svg.querySelector('.studio-annotate-selection-outline')).toBeTruthy();
  });

  it('a degenerate arrow (start === end) is discarded', async () => {
    const { svg } = await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'arrow' }));
    pointer(svg, 'pointerDown', 10, 10);
    pointer(svg, 'pointerUp', 10, 10);
    expect(svg.querySelector('[data-ann-kind="arrow"]')).toBeNull();
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('StudioAnnotate — text tool', () => {
  it('commits typed text, switches to select, and selects the new annotation', async () => {
    const { svg } = await renderReady();
    drawText(svg, { x: 50, y: 50 }, 'Hello');
    const text = svg.querySelector('[data-ann-kind="text"]');
    expect(text).toBeTruthy();
    expect(text?.textContent).toBe('Hello');
    expect(text.getAttribute('x')).toBe('50');
    expect(text.getAttribute('y')).toBe('50');
    expect(screen.getByRole('button', { name: 'select' }).getAttribute('aria-pressed')).toBe('true');
    expect(svg.querySelector('.studio-annotate-selection-outline')).toBeTruthy();
  });

  it('Escape cancels a fresh (never-committed) text annotation', async () => {
    const { svg } = await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'text' }));
    pointer(svg, 'pointerDown', 30, 30);
    const input = screen.getByTestId('studio-annotate-text-editor');
    fireEvent.change(input, { target: { value: 'discard me' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(svg.querySelector('[data-ann-kind="text"]')).toBeNull();
    expect(screen.queryByTestId('studio-annotate-text-editor')).toBeNull();
  });

  it('committing an empty draft discards the annotation instead of leaving a blank label', async () => {
    const { svg } = await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'text' }));
    pointer(svg, 'pointerDown', 40, 40);
    const input = screen.getByTestId('studio-annotate-text-editor');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(svg.querySelector('[data-ann-kind="text"]')).toBeNull();
    expect(screen.queryByTestId('studio-annotate-text-editor')).toBeNull();
  });
});

describe('StudioAnnotate — select tool: move / retarget / delete / edit-in-place', () => {
  it('dragging the shaft translates the whole arrow (handles stay a fixed offset apart)', async () => {
    const { svg } = await renderReady();
    drawArrow(svg, { x: 0, y: 0 }, { x: 100, y: 0 }); // auto-selected, tool is now 'select'
    pointer(svg, 'pointerDown', 50, 0); // midpoint of the shaft, far from either handle
    pointer(svg, 'pointerMove', 55, 10); // dx=5, dy=10
    pointer(svg, 'pointerUp', 55, 10);
    const line = svg.querySelector('[data-ann-kind="arrow"] line');
    expect(line.getAttribute('x1')).toBe('5');
    expect(line.getAttribute('y1')).toBe('10');
    expect(line.getAttribute('x2')).toBe('105');
    expect(line.getAttribute('y2')).toBe('10');
  });

  it('dragging a handle retargets only that endpoint', async () => {
    const { svg } = await renderReady();
    drawArrow(svg, { x: 0, y: 0 }, { x: 100, y: 0 });
    pointer(svg, 'pointerDown', 2, 0); // within tolerance of the start handle
    pointer(svg, 'pointerMove', 20, 30);
    pointer(svg, 'pointerUp', 20, 30);
    const line = svg.querySelector('[data-ann-kind="arrow"] line');
    expect(line.getAttribute('x1')).toBe('20');
    expect(line.getAttribute('y1')).toBe('30');
    expect(line.getAttribute('x2')).toBe('100');
    expect(line.getAttribute('y2')).toBe('0');
  });

  it('Delete/Backspace removes the current selection when the root has focus', async () => {
    const { svg, container } = await renderReady();
    drawArrow(svg, { x: 0, y: 0 }, { x: 100, y: 0 });
    fireEvent.keyDown(container.querySelector('.studio-annotate') as Element, { key: 'Delete', bubbles: true });
    expect(svg.querySelector('[data-ann-kind="arrow"]')).toBeNull();
    expect(svg.querySelector('.studio-annotate-selection-outline')).toBeNull();
  });

  it('the floating delete chip and the toolbar Delete button both remove the selection', async () => {
    const { svg } = await renderReady();
    drawPen(svg, [{ x: 10, y: 10 }, { x: 20, y: 20 }]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete annotation' })); // floating chip
    expect(svg.querySelector('[data-ann-kind="pen"]')).toBeNull();

    drawPen(svg, [{ x: 10, y: 10 }, { x: 20, y: 20 }]);
    fireEvent.click(screen.getByRole('button', { name: 'delete annotation' })); // toolbar button
    expect(svg.querySelector('[data-ann-kind="pen"]')).toBeNull();
  });

  it('clicking empty space deselects (selection chrome and floating delete disappear)', async () => {
    const { svg } = await renderReady();
    drawArrow(svg, { x: 0, y: 0 }, { x: 100, y: 0 });
    pointer(svg, 'pointerDown', 300, 300); // empty area, well away from the arrow
    pointer(svg, 'pointerUp', 300, 300);
    expect(svg.querySelector('.studio-annotate-selection-outline')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete annotation' })).toBeNull();
  });

  it('double-clicking a text annotation reopens the inline editor pre-filled with its content', async () => {
    const { svg } = await renderReady();
    drawText(svg, { x: 50, y: 50 }, 'Hi');
    fireEvent.doubleClick(svg, { clientX: 55, clientY: 45 }); // inside the approximate text bbox
    const input = screen.getByTestId('studio-annotate-text-editor') as HTMLInputElement;
    expect(input.value).toBe('Hi');
    fireEvent.change(input, { target: { value: 'Hi there' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const texts = svg.querySelectorAll('[data-ann-kind="text"]');
    expect(texts).toHaveLength(1);
    expect(texts[0].textContent).toBe('Hi there');
  });
});

describe('StudioAnnotate — undo/redo (buttons + keyboard)', () => {
  it('the Undo/Redo buttons walk history backward and forward', async () => {
    const { svg } = await renderReady();
    drawArrow(svg, { x: 0, y: 0 }, { x: 100, y: 0 });
    expect(svg.querySelector('[data-ann-kind="arrow"]')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(svg.querySelector('[data-ann-kind="arrow"]')).toBeNull();
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(svg.querySelector('[data-ann-kind="arrow"]')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Cmd/Ctrl+Z undoes and Shift+Cmd/Ctrl+Z redoes, scoped to the focusable root', async () => {
    const { svg, container } = await renderReady();
    drawPen(svg, [{ x: 1, y: 1 }, { x: 2, y: 2 }]);
    const root = container.querySelector('.studio-annotate') as Element;

    fireEvent.keyDown(root, { key: 'z', metaKey: true, bubbles: true });
    expect(svg.querySelector('[data-ann-kind="pen"]')).toBeNull();

    fireEvent.keyDown(root, { key: 'z', metaKey: true, shiftKey: true, bubbles: true });
    expect(svg.querySelector('[data-ann-kind="pen"]')).toBeTruthy();
  });
});

describe('StudioAnnotate — color & size controls', () => {
  it('changing the color input recolors the current selection', async () => {
    const { svg } = await renderReady();
    drawPen(svg, [{ x: 10, y: 10 }, { x: 20, y: 20 }]); // auto-selected after commit
    const colorInput = document.querySelector('.studio-annotate-color') as HTMLInputElement;
    fireEvent.change(colorInput, { target: { value: '#00ff00' } });
    expect(svg.querySelector('[data-ann-kind="pen"]').getAttribute('stroke')).toBe('#00ff00');
  });

  it('the size slider only appears for a selected text annotation, and resizes it', async () => {
    const { svg } = await renderReady();
    expect(document.querySelector('.studio-annotate-size')).toBeNull(); // nothing selected yet

    drawText(svg, { x: 5, y: 5 }, 'X'); // auto-selected
    const sizeInput = document.querySelector('.studio-annotate-size') as HTMLInputElement;
    expect(sizeInput).toBeTruthy();
    expect(sizeInput.value).toBe('20');

    fireEvent.change(sizeInput, { target: { value: '40' } });
    const text = svg.querySelector('[data-ann-kind="text"]') as SVGTextElement;
    expect(text.getAttribute('font-size')).toBe('40');
  });
});

describe('StudioAnnotate — keyboard guard (form controls swallow Delete/undo)', () => {
  it('pressing Delete while a toolbar input has focus does not delete the current selection', async () => {
    const { svg } = await renderReady();
    drawArrow(svg, { x: 0, y: 0 }, { x: 100, y: 0 });
    const colorInput = document.querySelector('.studio-annotate-color') as HTMLInputElement;
    fireEvent.keyDown(colorInput, { key: 'Delete', bubbles: true });
    expect(svg.querySelector('[data-ann-kind="arrow"]')).toBeTruthy();
  });
});

describe('StudioAnnotate — resets on a new source image', () => {
  it('clears annotation history and disables Undo when imageDataUrl changes', async () => {
    const { svg, rerender } = await renderReady({ imageDataUrl: IMG_URL });
    drawArrow(svg, { x: 0, y: 0 }, { x: 100, y: 0 });
    expect(svg.querySelector('[data-ann-kind="arrow"]')).toBeTruthy();

    const onReady2 = vi.fn();
    rerender(createElement(StudioAnnotate, { imageDataUrl: 'data:image/png;base64,BBBB', onReady: onReady2 }));
    await waitFor(() => expect(onReady2).toHaveBeenCalledWith(true));

    expect(svg.querySelector('[data-ann-kind="arrow"]')).toBeNull();
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
