// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement, createRef } from 'react';
import {
  toCanvasPoint,
  computeArrowHeadPoints,
  undoStrokes,
  drawStroke,
  StudioAnnotate,
  type DrawCtx,
  type Stroke,
  type StudioAnnotateHandle,
} from './StudioAnnotate';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * jsdom's HTMLImageElement never fires `load`/`error` for a `src` assignment
 * (no resource loading without jsdom's `resources: 'usable'` option, which
 * this project's vitest config doesn't set — verified directly: an
 * unstubbed `new Image()` with a data-URL `src` fires neither event, ever).
 * StudioAnnotate's real decode-detection (imgReady / onReady / onError,
 * Studio Phase D CP3 audit FIX 1) needs a synthetic Image that actually
 * fires one or the other, so tests exercising that path stub the global
 * constructor. `failSrcs` opts a specific `imageDataUrl` into the failure
 * (onerror) path; every other src succeeds (onload) on the next microtask.
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

describe('toCanvasPoint', () => {
  it('maps a viewport point 1:1 when the display size equals the buffer size', () => {
    const rect = { left: 10, top: 20, width: 100, height: 100 };
    expect(toCanvasPoint(60, 70, rect, 100, 100)).toEqual({ x: 50, y: 50 });
  });

  it('scales when the canvas is displayed smaller than its backing buffer', () => {
    // Displayed at half size (100 CSS px) but the buffer is 200px — a click
    // at the display's exact center must land at the buffer's center, not
    // half of it.
    const rect = { left: 0, top: 0, width: 100, height: 100 };
    expect(toCanvasPoint(50, 50, rect, 200, 200)).toEqual({ x: 100, y: 100 });
  });

  it('falls back to a 1:1 scale when rect width/height is 0 (never divides by zero)', () => {
    const rect = { left: 0, top: 0, width: 0, height: 0 };
    expect(toCanvasPoint(5, 5, rect, 200, 200)).toEqual({ x: 5, y: 5 });
  });
});

describe('computeArrowHeadPoints', () => {
  it('returns two barb points symmetric around the shaft, both behind the tip', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 100, y: 0 }; // pointing straight right
    const [left, right] = computeArrowHeadPoints(from, to);
    // Symmetric across the shaft line (y=0): equal-and-opposite y offsets.
    expect(left.y).toBeCloseTo(-right.y, 5);
    // Both barbs sit behind the tip (smaller x than `to.x`).
    expect(left.x).toBeLessThan(to.x);
    expect(right.x).toBeLessThan(to.x);
  });

  it('respects a custom head length', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 100, y: 0 };
    const [shortLeft] = computeArrowHeadPoints(from, to, 5);
    const [longLeft] = computeArrowHeadPoints(from, to, 50);
    const shortDist = Math.hypot(to.x - shortLeft.x, to.y - shortLeft.y);
    const longDist = Math.hypot(to.x - longLeft.x, to.y - longLeft.y);
    expect(longDist).toBeGreaterThan(shortDist);
  });
});

describe('undoStrokes', () => {
  it('drops the most recently committed stroke', () => {
    const a: Stroke = { tool: 'pen', color: '#000', points: [{ x: 0, y: 0 }] };
    const b: Stroke = { tool: 'pen', color: '#000', points: [{ x: 1, y: 1 }] };
    expect(undoStrokes([a, b])).toEqual([a]);
  });

  it('is a safe no-op on an empty list', () => {
    expect(undoStrokes([])).toEqual([]);
  });
});

function mockDrawCtx(): DrawCtx & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    font: '',
    beginPath: () => calls.push('beginPath'),
    moveTo: (x, y) => calls.push(`moveTo(${x},${y})`),
    lineTo: (x, y) => calls.push(`lineTo(${x},${y})`),
    closePath: () => calls.push('closePath'),
    stroke: () => calls.push('stroke'),
    fill: () => calls.push('fill'),
    fillText: (text, x, y) => calls.push(`fillText(${text},${x},${y})`),
  };
}

describe('drawStroke', () => {
  it('pen: strokes a path through every point', () => {
    const ctx = mockDrawCtx();
    const stroke: Stroke = {
      tool: 'pen',
      color: '#ff0000',
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ],
    };
    drawStroke(ctx, stroke);
    expect(ctx.strokeStyle).toBe('#ff0000');
    expect(ctx.calls).toEqual(['beginPath', 'moveTo(0,0)', 'lineTo(1,1)', 'lineTo(2,2)', 'stroke']);
  });

  it('pen: a single-point stroke (a click with no drag) draws nothing — needs at least 2 points', () => {
    const ctx = mockDrawCtx();
    drawStroke(ctx, { tool: 'pen', color: '#000', points: [{ x: 0, y: 0 }] });
    expect(ctx.calls).toEqual([]);
  });

  it('arrow: strokes the shaft, then strokes both barbs from the tip', () => {
    const ctx = mockDrawCtx();
    const stroke: Stroke = { tool: 'arrow', color: '#00ff00', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] };
    drawStroke(ctx, stroke);
    expect(ctx.calls[0]).toBe('beginPath');
    expect(ctx.calls).toContain('moveTo(0,0)');
    expect(ctx.calls).toContain('lineTo(10,0)');
    // Second beginPath for the two barbs, both starting from the tip (10,0).
    const secondBeginPathIdx = ctx.calls.indexOf('beginPath', 1);
    expect(secondBeginPathIdx).toBeGreaterThan(0);
    expect(ctx.calls[secondBeginPathIdx + 1]).toBe('moveTo(10,0)');
  });

  it('text: sets a font and draws the string at the anchor point', () => {
    const ctx = mockDrawCtx();
    drawStroke(ctx, { tool: 'text', color: '#0000ff', points: [{ x: 5, y: 9 }], text: 'hi' });
    expect(ctx.font).toBe('20px sans-serif');
    expect(ctx.calls).toEqual(['fillText(hi,5,9)']);
  });
});

describe('StudioAnnotate (mounted component)', () => {
  it('renders pen/arrow/text tool buttons, a color picker, an undo button, and the canvas', () => {
    render(createElement(StudioAnnotate, { imageDataUrl: 'data:image/png;base64,AAAA' }));
    expect(document.querySelector('[data-testid="studio-annotate-canvas"]')).toBeTruthy();
    expect(document.querySelectorAll('.studio-annotate-tool-btn')).toHaveLength(3);
    expect(document.querySelector('.studio-annotate-color')).toBeTruthy();
    expect(document.querySelector('.studio-annotate-undo')).toBeTruthy();
  });

  it('undo starts disabled, and enables once a stroke is drawn via pointer events (mouse-style pointerType)', () => {
    render(createElement(StudioAnnotate, { imageDataUrl: 'data:image/png;base64,AAAA' }));
    const canvas = document.querySelector('[data-testid="studio-annotate-canvas"]') as HTMLCanvasElement;
    const undoBtn = document.querySelector('.studio-annotate-undo') as HTMLButtonElement;
    expect(undoBtn.disabled).toBe(true);

    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerType: 'mouse' });
    fireEvent.pointerMove(canvas, { clientX: 20, clientY: 20, pointerType: 'mouse' });
    fireEvent.pointerUp(canvas, { clientX: 20, clientY: 20, pointerType: 'mouse' });

    expect(undoBtn.disabled).toBe(false);
  });

  it('touch-style pointer events (pointerType: touch) draw exactly the same way as mouse events', () => {
    render(createElement(StudioAnnotate, { imageDataUrl: 'data:image/png;base64,AAAA' }));
    const canvas = document.querySelector('[data-testid="studio-annotate-canvas"]') as HTMLCanvasElement;
    const undoBtn = document.querySelector('.studio-annotate-undo') as HTMLButtonElement;

    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerDown(canvas, { clientX: 5, clientY: 5, pointerType: 'touch' });
    fireEvent.pointerMove(canvas, { clientX: 15, clientY: 15, pointerType: 'touch' });
    fireEvent.pointerUp(canvas, { clientX: 15, clientY: 15, pointerType: 'touch' });

    expect(undoBtn.disabled).toBe(false);
  });

  it('the text tool prompts for text and commits a stroke without entering the drag-drawing path', () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('hello');
    render(createElement(StudioAnnotate, { imageDataUrl: 'data:image/png;base64,AAAA' }));
    const canvas = document.querySelector('[data-testid="studio-annotate-canvas"]') as HTMLCanvasElement;
    const undoBtn = document.querySelector('.studio-annotate-undo') as HTMLButtonElement;
    const textBtn = Array.from(document.querySelectorAll('.studio-annotate-tool-btn')).find(
      (b) => b.textContent === 'text',
    ) as HTMLButtonElement;

    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);

    fireEvent.click(textBtn);
    fireEvent.pointerDown(canvas, { clientX: 5, clientY: 5, pointerType: 'mouse' });

    expect(promptSpy).toHaveBeenCalled();
    expect(undoBtn.disabled).toBe(false);
    promptSpy.mockRestore();
  });

  it('undo removes the most recently committed stroke and disables again once the list is empty', () => {
    render(createElement(StudioAnnotate, { imageDataUrl: 'data:image/png;base64,AAAA' }));
    const canvas = document.querySelector('[data-testid="studio-annotate-canvas"]') as HTMLCanvasElement;
    const undoBtn = document.querySelector('.studio-annotate-undo') as HTMLButtonElement;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerDown(canvas, { clientX: 1, clientY: 1, pointerType: 'mouse' });
    fireEvent.pointerUp(canvas, { clientX: 1, clientY: 1, pointerType: 'mouse' });
    expect(undoBtn.disabled).toBe(false);

    fireEvent.click(undoBtn);
    expect(undoBtn.disabled).toBe(true);
  });

  it('exposes exportPng() via the forwarded ref and resolves once the source image has decoded (imgReady)', async () => {
    // jsdom has no real canvas rendering backend without the optional
    // `canvas` npm package: canvas.toDataURL() resolves to `null` there
    // (verified directly against jsdom), not a data URL string — a real
    // browser always returns a string. This only asserts the ref-forwarded
    // call resolves cleanly once decode succeeds; the actual dataUrl content
    // is exercised for real in StudioModal.vitest.ts's D3 save-flow test via
    // a mocked fetch.
    stubImageLoad();
    const ref = createRef<StudioAnnotateHandle>();
    const onReady = vi.fn();
    render(createElement(StudioAnnotate, { ref, imageDataUrl: 'data:image/png;base64,AAAA', onReady }));
    await waitFor(() => expect(onReady).toHaveBeenCalledWith(true));

    let out: string | null | undefined;
    await act(async () => {
      out = await ref.current?.exportPng();
    });
    expect(out === null || typeof out === 'string').toBe(true);
  });

  // Studio Phase D CP3 audit, FIX 1 coverage: the source image's decode
  // state now gates exportPng() itself (StudioModal additionally disables
  // the Save button on the same signal — see StudioModal.vitest.ts) so a
  // malformed/undecodable capture can never silently produce a blank-canvas
  // PNG, regardless of caller.

  it('exportPng() rejects while the source image has not (yet, or ever) finished decoding — never silently exports a blank canvas', async () => {
    // No stubImageLoad() here: default jsdom never fires onload/onerror at
    // all for an <img> src assignment, which IS the "still decoding, or a
    // decode that will never resolve" state this guard exists for.
    const ref = createRef<StudioAnnotateHandle>();
    render(createElement(StudioAnnotate, { ref, imageDataUrl: 'data:image/png;base64,AAAA' }));
    await expect(ref.current?.exportPng()).rejects.toThrow(/not ready/);
  });

  it('a malformed/undecodable dataUrl fires the source image onerror, calls onError(), and never reaches onReady(true)', async () => {
    const malformed = 'data:image/png;base64,not-actually-a-png';
    stubImageLoad(new Set([malformed]));
    const onReady = vi.fn();
    const onError = vi.fn();
    render(createElement(StudioAnnotate, { imageDataUrl: malformed, onReady, onError }));

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onReady).not.toHaveBeenCalledWith(true);
  });

  it('sizes the canvas backing buffer to the image natural resolution once decode succeeds', async () => {
    stubImageLoad();
    render(createElement(StudioAnnotate, { imageDataUrl: 'data:image/png;base64,AAAA' }));
    const canvas = document.querySelector('[data-testid="studio-annotate-canvas"]') as HTMLCanvasElement;
    await waitFor(() => expect(canvas.width).toBe(400));
    expect(canvas.height).toBe(320);
  });
});
