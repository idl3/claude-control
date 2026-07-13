import { describe, it, expect } from 'vitest';
import {
  clientToImagePoint,
  pxToImg,
  handleRadiusPx,
  computeArrowHeadPoints,
  distToSegment,
  hitTestAnnotation,
  topmostHit,
  nearestArrowHandle,
  annotationBounds,
  drawAnnotation,
  type DrawCtx,
} from './annotationGeometry';
import { createPen, createArrow, createText, type Annotation } from './annotationModel';

describe('clientToImagePoint', () => {
  it('maps 1:1 when the rect exactly matches the image size', () => {
    const rect = { left: 0, top: 0, width: 400, height: 320 };
    expect(clientToImagePoint(100, 50, rect, 400, 320)).toEqual({ x: 100, y: 50 });
  });

  it('scales when the display size differs from natural resolution', () => {
    // Displayed at half size: 200x160 on screen for a 400x320 image.
    const rect = { left: 10, top: 20, width: 200, height: 160 };
    expect(clientToImagePoint(110, 100, rect, 400, 320)).toEqual({ x: 200, y: 160 });
  });

  it('guards divide-by-zero when rect has no size (falls back to scale 1)', () => {
    const rect = { left: 0, top: 0, width: 0, height: 0 };
    expect(clientToImagePoint(5, 7, rect, 400, 320)).toEqual({ x: 5, y: 7 });
  });
});

describe('pxToImg / handleRadiusPx', () => {
  it('converts screen px to image units by dividing by displayScale', () => {
    expect(pxToImg(10, 2)).toBe(5);
    expect(pxToImg(10, 0.5)).toBe(20);
  });

  it('falls back to the raw px value when displayScale is zero/negative', () => {
    expect(pxToImg(10, 0)).toBe(10);
    expect(pxToImg(10, -1)).toBe(10);
  });

  it('handleRadiusPx is bigger for coarse (touch) pointers', () => {
    expect(handleRadiusPx(false)).toBe(7);
    expect(handleRadiusPx(true)).toBe(13);
  });
});

describe('computeArrowHeadPoints', () => {
  it('returns symmetric barbs for a horizontal arrow', () => {
    const [left, right] = computeArrowHeadPoints({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(left.y).toBeCloseTo(-right.y, 5);
    expect(left.x).toBeCloseTo(right.x, 5);
  });

  it('respects a custom head length', () => {
    const [left] = computeArrowHeadPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, 28);
    const dist = Math.hypot(left.x - 100, left.y - 0);
    expect(dist).toBeCloseTo(28, 5);
  });
});

describe('distToSegment', () => {
  it('is zero for a point on the segment', () => {
    expect(distToSegment({ x: 5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(0, 6);
  });

  it('measures perpendicular distance to a segment', () => {
    expect(distToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(3, 6);
  });

  it('clamps to the nearest endpoint beyond the segment', () => {
    expect(distToSegment({ x: -5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5, 6);
  });

  it('degenerate segment (a === b) falls back to point distance', () => {
    expect(distToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(5, 6);
  });
});

describe('hitTestAnnotation', () => {
  it('pen: hits when within tolerance of any segment', () => {
    const pen = createPen('#fff', [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
    expect(hitTestAnnotation(pen, { x: 5, y: 1 }, 2)).toBe(true);
    expect(hitTestAnnotation(pen, { x: 10, y: 5 }, 2)).toBe(true);
    expect(hitTestAnnotation(pen, { x: 50, y: 50 }, 2)).toBe(false);
  });

  it('pen: a single-point stroke hit-tests against that point', () => {
    const pen = createPen('#fff', [{ x: 5, y: 5 }]);
    expect(hitTestAnnotation(pen, { x: 6, y: 5 }, 2)).toBe(true);
    expect(hitTestAnnotation(pen, { x: 50, y: 5 }, 2)).toBe(false);
  });

  it('arrow: hits along the shaft, including near the endpoints', () => {
    const arrow = createArrow('#fff', { x: 0, y: 0 }, { x: 20, y: 0 });
    expect(hitTestAnnotation(arrow, { x: 10, y: 1 }, 2)).toBe(true);
    expect(hitTestAnnotation(arrow, { x: 0, y: 1 }, 2)).toBe(true);
    expect(hitTestAnnotation(arrow, { x: 10, y: 10 }, 2)).toBe(false);
  });

  it('text: hits within the approximate bbox spanning upward from the baseline', () => {
    const text = createText('#fff', { x: 100, y: 100 }, 'hi', 20);
    // Just above-left of the baseline point should be inside the box.
    expect(hitTestAnnotation(text, { x: 102, y: 95 }, 1)).toBe(true);
    // Far away should not.
    expect(hitTestAnnotation(text, { x: 500, y: 500 }, 1)).toBe(false);
  });
});

describe('topmostHit', () => {
  it('returns null when nothing is hit', () => {
    const anns: Annotation[] = [createPen('#fff', [{ x: 0, y: 0 }])];
    expect(topmostHit(anns, { x: 500, y: 500 }, 2)).toBeNull();
  });

  it('returns the LAST (topmost) annotation when overlapping', () => {
    const bottom = createPen('#fff', [{ x: 0, y: 0 }], 'bottom');
    const top = createPen('#fff', [{ x: 0, y: 0 }], 'top');
    expect(topmostHit([bottom, top], { x: 0, y: 0 }, 2)).toBe('top');
    expect(topmostHit([top, bottom], { x: 0, y: 0 }, 2)).toBe('bottom');
  });
});

describe('nearestArrowHandle', () => {
  const arrow = createArrow('#fff', { x: 0, y: 0 }, { x: 100, y: 0 });

  it('detects the start handle', () => {
    expect(nearestArrowHandle(arrow, { x: 1, y: 0 }, 5)).toBe('start');
  });

  it('detects the end handle', () => {
    expect(nearestArrowHandle(arrow, { x: 99, y: 0 }, 5)).toBe('end');
  });

  it('returns null when neither endpoint is within tolerance', () => {
    expect(nearestArrowHandle(arrow, { x: 50, y: 0 }, 5)).toBeNull();
  });
});

describe('annotationBounds', () => {
  it('pen: tight bbox around all points', () => {
    const pen = createPen('#fff', [
      { x: 0, y: 5 },
      { x: 10, y: -5 },
    ]);
    expect(annotationBounds(pen)).toEqual({ x: 0, y: -5, w: 10, h: 10 });
  });

  it('arrow: bbox regardless of start/end direction', () => {
    const arrow = createArrow('#fff', { x: 10, y: 10 }, { x: 0, y: 0 });
    expect(annotationBounds(arrow)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });

  it('text: bbox spans upward from the baseline and scales with content length', () => {
    const short = createText('#fff', { x: 0, y: 0 }, 'a', 20);
    const long = createText('#fff', { x: 0, y: 0 }, 'a much longer string', 20);
    expect(annotationBounds(short).w).toBeLessThan(annotationBounds(long).w);
    expect(annotationBounds(short).y).toBeLessThan(0); // spans upward from baseline y=0
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

describe('drawAnnotation', () => {
  it('pen: draws a polyline through every point', () => {
    const ctx = mockDrawCtx();
    const pen = createPen('#f00', [
      { x: 0, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 0 },
    ]);
    drawAnnotation(ctx, pen);
    expect(ctx.calls).toEqual(['beginPath', 'moveTo(0,0)', 'lineTo(5,5)', 'lineTo(10,0)', 'stroke']);
    expect(ctx.strokeStyle).toBe('#f00');
  });

  it('pen: a single-point stroke draws nothing', () => {
    const ctx = mockDrawCtx();
    drawAnnotation(ctx, createPen('#f00', [{ x: 0, y: 0 }]));
    expect(ctx.calls).toEqual([]);
  });

  it('arrow: draws the shaft plus two head barbs', () => {
    const ctx = mockDrawCtx();
    const arrow = createArrow('#0f0', { x: 0, y: 0 }, { x: 100, y: 0 });
    drawAnnotation(ctx, arrow);
    expect(ctx.calls[0]).toBe('beginPath');
    expect(ctx.calls).toContain('moveTo(0,0)');
    expect(ctx.calls).toContain('lineTo(100,0)');
    // second beginPath starts the head-barb path
    expect(ctx.calls.filter((c) => c === 'beginPath')).toHaveLength(2);
    expect(ctx.calls.filter((c) => c === 'stroke')).toHaveLength(2);
  });

  it('text: sets a size-scaled font and calls fillText at pos', () => {
    const ctx = mockDrawCtx();
    const text = createText('#00f', { x: 12, y: 34 }, 'hello', 40);
    drawAnnotation(ctx, text);
    expect(ctx.font).toBe('40px ui-monospace, "SF Mono", Menlo, monospace');
    expect(ctx.calls).toEqual(['fillText(hello,12,34)']);
  });
});
