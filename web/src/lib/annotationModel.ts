// Pure, immutable object model for Prototype Studio's retained-object
// annotation layer (SVG overlay). No DOM/React here — see annotationGeometry.ts
// for hit-testing/rendering and StudioAnnotate.tsx for the component that
// wires this up to pointer/keyboard events.

export type Point = { x: number; y: number };

export type AnnId = string;

export type PenAnnotation = { id: AnnId; kind: 'pen'; color: string; points: Point[] };
export type ArrowAnnotation = { id: AnnId; kind: 'arrow'; color: string; start: Point; end: Point };
export type TextAnnotation = { id: AnnId; kind: 'text'; color: string; pos: Point; content: string; size: number };

export type Annotation = PenAnnotation | ArrowAnnotation | TextAnnotation;

// --- id factory --------------------------------------------------------
// Monotonic counter is deterministic across test runs; resettable so each
// test file starts from a known id sequence.
let idCounter = 0;

export function resetIdCounter(start = 0): void {
  idCounter = start;
}

export function nextAnnId(): AnnId {
  idCounter += 1;
  return `ann-${idCounter}`;
}

// --- creators ------------------------------------------------------------

export function createPen(color: string, points: Point[], id: AnnId = nextAnnId()): PenAnnotation {
  return { id, kind: 'pen', color, points: [...points] };
}

export function createArrow(color: string, start: Point, end: Point, id: AnnId = nextAnnId()): ArrowAnnotation {
  return { id, kind: 'arrow', color, start: { ...start }, end: { ...end } };
}

export function createText(
  color: string,
  pos: Point,
  content: string,
  size: number,
  id: AnnId = nextAnnId(),
): TextAnnotation {
  return { id, kind: 'text', color, pos: { ...pos }, content, size };
}

// --- immutable mutators ---------------------------------------------------
// Every mutator returns a NEW annotation; inputs are never touched.

export function translateAnnotation<A extends Annotation>(a: A, dx: number, dy: number): A {
  if (a.kind === 'pen') {
    return { ...a, points: a.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) } as A;
  }
  if (a.kind === 'arrow') {
    return {
      ...a,
      start: { x: a.start.x + dx, y: a.start.y + dy },
      end: { x: a.end.x + dx, y: a.end.y + dy },
    } as A;
  }
  return { ...a, pos: { x: a.pos.x + dx, y: a.pos.y + dy } } as A;
}

export function retargetArrow(a: ArrowAnnotation, which: 'start' | 'end', p: Point): ArrowAnnotation {
  return which === 'start' ? { ...a, start: { ...p } } : { ...a, end: { ...p } };
}

export function recolorAnnotation<A extends Annotation>(a: A, color: string): A {
  return { ...a, color };
}

export function resizeText(a: TextAnnotation, size: number): TextAnnotation {
  return { ...a, size };
}

export function editText(a: TextAnnotation, content: string): TextAnnotation {
  return { ...a, content };
}

// --- history (undo/redo) --------------------------------------------------

export type History = {
  past: Annotation[][];
  present: Annotation[];
  future: Annotation[][];
};

export function createHistory(initial: Annotation[] = []): History {
  return { past: [], present: initial, future: [] };
}

export function pushHistory(h: History, next: Annotation[]): History {
  return { past: [...h.past, h.present], present: [...next], future: [] };
}

export function canUndo(h: History): boolean {
  return h.past.length > 0;
}

export function canRedo(h: History): boolean {
  return h.future.length > 0;
}

export function undo(h: History): History {
  if (h.past.length === 0) return h;
  const previous = h.past[h.past.length - 1];
  return { past: h.past.slice(0, -1), present: previous, future: [h.present, ...h.future] };
}

export function redo(h: History): History {
  if (h.future.length === 0) return h;
  const next = h.future[0];
  return { past: [...h.past, h.present], present: next, future: h.future.slice(1) };
}
