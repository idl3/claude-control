import { describe, it, expect, beforeEach } from 'vitest';
import {
  resetIdCounter,
  nextAnnId,
  createPen,
  createArrow,
  createText,
  translateAnnotation,
  retargetArrow,
  recolorAnnotation,
  resizeText,
  editText,
  createHistory,
  pushHistory,
  undo,
  redo,
  canUndo,
  canRedo,
  type Annotation,
  type ArrowAnnotation,
  type TextAnnotation,
} from './annotationModel';

beforeEach(() => {
  resetIdCounter();
});

describe('id factory', () => {
  it('produces monotonic, distinct ids', () => {
    const a = nextAnnId();
    const b = nextAnnId();
    expect(a).not.toBe(b);
    expect(a).toBe('ann-1');
    expect(b).toBe('ann-2');
  });

  it('resetIdCounter restarts the sequence deterministically', () => {
    nextAnnId();
    nextAnnId();
    resetIdCounter();
    expect(nextAnnId()).toBe('ann-1');
  });
});

describe('creators', () => {
  it('createPen copies the points array (no aliasing)', () => {
    const pts = [{ x: 0, y: 0 }];
    const pen = createPen('#fff', pts);
    pts.push({ x: 1, y: 1 });
    expect(pen.points).toHaveLength(1);
    expect(pen.kind).toBe('pen');
  });

  it('createArrow copies start/end points', () => {
    const start = { x: 0, y: 0 };
    const arrow = createArrow('#fff', start, { x: 10, y: 10 });
    start.x = 99;
    expect(arrow.start).toEqual({ x: 0, y: 0 });
    expect(arrow.kind).toBe('arrow');
  });

  it('createText sets content/size/pos', () => {
    const text = createText('#fff', { x: 5, y: 5 }, 'hi', 20);
    expect(text).toMatchObject({ kind: 'text', content: 'hi', size: 20, pos: { x: 5, y: 5 } });
  });

  it('accepts an injected id for deterministic tests', () => {
    const pen = createPen('#fff', [{ x: 0, y: 0 }], 'fixed-id');
    expect(pen.id).toBe('fixed-id');
  });
});

describe('translateAnnotation (immutable)', () => {
  it('translates every point of a pen without mutating the original', () => {
    const pen = createPen('#fff', [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ]);
    const moved = translateAnnotation(pen, 5, -5);
    expect(moved.points).toEqual([
      { x: 5, y: -5 },
      { x: 15, y: 5 },
    ]);
    expect(pen.points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ]);
    expect(moved).not.toBe(pen);
  });

  it('translates arrow start and end', () => {
    const arrow = createArrow('#fff', { x: 0, y: 0 }, { x: 10, y: 0 });
    const moved = translateAnnotation(arrow, 2, 3);
    expect(moved.start).toEqual({ x: 2, y: 3 });
    expect(moved.end).toEqual({ x: 12, y: 3 });
    expect(arrow.start).toEqual({ x: 0, y: 0 });
  });

  it('translates text pos', () => {
    const text = createText('#fff', { x: 0, y: 0 }, 'hi', 20);
    const moved = translateAnnotation(text, 1, 1);
    expect(moved.pos).toEqual({ x: 1, y: 1 });
    expect(text.pos).toEqual({ x: 0, y: 0 });
  });
});

describe('retargetArrow', () => {
  const base: ArrowAnnotation = createArrow('#fff', { x: 0, y: 0 }, { x: 10, y: 10 });

  it('moves only the start endpoint', () => {
    const next = retargetArrow(base, 'start', { x: -5, y: -5 });
    expect(next.start).toEqual({ x: -5, y: -5 });
    expect(next.end).toEqual(base.end);
    expect(base.start).toEqual({ x: 0, y: 0 });
  });

  it('moves only the end endpoint', () => {
    const next = retargetArrow(base, 'end', { x: 20, y: 20 });
    expect(next.end).toEqual({ x: 20, y: 20 });
    expect(next.start).toEqual(base.start);
  });
});

describe('recolorAnnotation', () => {
  it('changes color without mutating original, for any kind', () => {
    const pen = createPen('#000', [{ x: 0, y: 0 }]);
    const recoloredPen = recolorAnnotation(pen, '#fff');
    expect(recoloredPen.color).toBe('#fff');
    expect(pen.color).toBe('#000');

    const text = createText('#000', { x: 0, y: 0 }, 'hi', 20);
    const recoloredText = recolorAnnotation(text, '#f00');
    expect(recoloredText.color).toBe('#f00');
  });
});

describe('resizeText / editText', () => {
  it('resizeText changes size only', () => {
    const text = createText('#fff', { x: 0, y: 0 }, 'hi', 20);
    const resized = resizeText(text, 40);
    expect(resized.size).toBe(40);
    expect(resized.content).toBe('hi');
    expect(text.size).toBe(20);
  });

  it('editText changes content only', () => {
    const text = createText('#fff', { x: 0, y: 0 }, 'hi', 20);
    const edited = editText(text, 'bye');
    expect(edited.content).toBe('bye');
    expect(edited.size).toBe(20);
    expect(text.content).toBe('hi');
  });
});

describe('history (undo/redo)', () => {
  it('createHistory starts empty with no undo/redo available', () => {
    const h = createHistory();
    expect(h.present).toEqual([]);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  it('pushHistory advances present and clears future (branches away from redo)', () => {
    const a: Annotation = createPen('#fff', [{ x: 0, y: 0 }]);
    const b: Annotation = createPen('#fff', [{ x: 1, y: 1 }]);
    let h = createHistory();
    h = pushHistory(h, [a]);
    h = pushHistory(h, [a, b]);
    expect(h.present).toEqual([a, b]);
    expect(canUndo(h)).toBe(true);

    const afterUndo = undo(h);
    expect(afterUndo.present).toEqual([a]);
    expect(canRedo(afterUndo)).toBe(true);

    // Pushing a new state while a future exists must drop the old future.
    const c: Annotation = createPen('#fff', [{ x: 2, y: 2 }]);
    const branched = pushHistory(afterUndo, [a, c]);
    expect(canRedo(branched)).toBe(false);
  });

  it('undo/redo round-trip restores prior states', () => {
    const a: Annotation = createPen('#fff', [{ x: 0, y: 0 }]);
    let h = createHistory();
    h = pushHistory(h, [a]);
    const afterUndo = undo(h);
    expect(afterUndo.present).toEqual([]);
    const afterRedo = redo(afterUndo);
    expect(afterRedo.present).toEqual([a]);
  });

  it('undo/redo are safe no-ops at the ends of history', () => {
    const h = createHistory();
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);

    const a: Annotation = createPen('#fff', [{ x: 0, y: 0 }]);
    const h2 = pushHistory(createHistory(), [a]);
    // no future yet
    expect(redo(h2)).toBe(h2);
  });

  it('does not mutate the annotation arrays passed into pushHistory', () => {
    const a: TextAnnotation = createText('#fff', { x: 0, y: 0 }, 'hi', 20);
    const list = [a];
    const h = pushHistory(createHistory(), list);
    list.push(createText('#fff', { x: 1, y: 1 }, 'bye', 20));
    expect(h.present).toHaveLength(1);
  });
});
