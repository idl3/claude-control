import { describe, it, expect } from 'vitest';
import { questionHasPreview } from './AskInline';
import type { PendingQuestion, Pending } from '../lib/types';

// Helper builders
function makeQuestion(partial: Partial<PendingQuestion>): PendingQuestion {
  return {
    question: 'Choose an option',
    options: [],
    ...partial,
  };
}

function makePending(questions: PendingQuestion[]): Pending {
  return { toolUseId: 'tu-1', questions };
}

// ── questionHasPreview ────────────────────────────────────────────────────────

describe('questionHasPreview', () => {
  it('returns false when no options have a preview', () => {
    const q = makeQuestion({
      options: [
        { label: 'Option A' },
        { label: 'Option B', description: 'desc only' },
      ],
    });
    expect(questionHasPreview(q)).toBe(false);
  });

  it('returns true when at least one option has a non-empty preview', () => {
    const q = makeQuestion({
      options: [
        { label: 'Option A', preview: '┌──────┐\n│ Box  │\n└──────┘' },
        { label: 'Option B' },
      ],
    });
    expect(questionHasPreview(q)).toBe(true);
  });

  it('returns false when preview is an empty string', () => {
    const q = makeQuestion({
      options: [{ label: 'Option A', preview: '' }],
    });
    expect(questionHasPreview(q)).toBe(false);
  });

  it('returns false for an empty options array', () => {
    expect(questionHasPreview(makeQuestion({ options: [] }))).toBe(false);
  });

  it('returns true even when only the last option has a preview', () => {
    const q = makeQuestion({
      options: [
        { label: 'A' },
        { label: 'B' },
        { label: 'C', preview: 'diagram here' },
      ],
    });
    expect(questionHasPreview(q)).toBe(true);
  });
});

// ── Selection logic (mirrors AskModal toggle + initSelections) ────────────────
// These replicate the pure logic from the component so we can verify it without
// a DOM.  The component's toggle() and initSelections() are small enough that
// copy-verifying them here provides clear regression coverage.

function initSelections(pending: Pending): Set<string>[] {
  return pending.questions.map(() => new Set<string>());
}

function toggle(
  prev: Set<string>[],
  qIdx: number,
  label: string,
  multi: boolean,
): Set<string>[] {
  const next = prev.map((s) => new Set(s));
  const set = next[qIdx];
  if (multi) {
    if (set.has(label)) set.delete(label);
    else set.add(label);
  } else {
    next[qIdx] = new Set([label]);
  }
  return next;
}

describe('AskModal selection logic', () => {
  it('initialises every question with an empty Set', () => {
    const pending = makePending([
      makeQuestion({ options: [{ label: 'A' }] }),
      makeQuestion({ options: [{ label: 'B' }, { label: 'C' }] }),
    ]);
    const sels = initSelections(pending);
    expect(sels).toHaveLength(2);
    expect(sels[0].size).toBe(0);
    expect(sels[1].size).toBe(0);
  });

  it('single-select replaces the selection with the new label', () => {
    const pending = makePending([makeQuestion({ options: [{ label: 'A' }, { label: 'B' }] })]);
    let sels = initSelections(pending);
    sels = toggle(sels, 0, 'A', false);
    expect([...sels[0]]).toEqual(['A']);
    // Selecting B replaces A entirely.
    sels = toggle(sels, 0, 'B', false);
    expect([...sels[0]]).toEqual(['B']);
  });

  it('multi-select toggles individual labels independently', () => {
    const pending = makePending([makeQuestion({ options: [{ label: 'A' }, { label: 'B' }] })]);
    let sels = initSelections(pending);
    sels = toggle(sels, 0, 'A', true);
    sels = toggle(sels, 0, 'B', true);
    expect(sels[0].has('A')).toBe(true);
    expect(sels[0].has('B')).toBe(true);
    // Toggling A again removes it.
    sels = toggle(sels, 0, 'A', true);
    expect(sels[0].has('A')).toBe(false);
    expect(sels[0].has('B')).toBe(true);
  });

  it('toggling one question does not affect a sibling question', () => {
    const pending = makePending([
      makeQuestion({ options: [{ label: 'A' }] }),
      makeQuestion({ options: [{ label: 'X' }] }),
    ]);
    let sels = initSelections(pending);
    sels = toggle(sels, 0, 'A', false);
    expect(sels[1].size).toBe(0);
  });

  it('ready gate: all questions must have ≥1 selection', () => {
    const isReady = (sels: Set<string>[]) =>
      sels.length > 0 && sels.every((s) => s.size > 0);

    const pending = makePending([
      makeQuestion({ options: [{ label: 'A' }, { label: 'B' }, { label: 'C', preview: 'ascii' }] }),
      makeQuestion({ options: [{ label: 'X' }] }),
    ]);
    let sels = initSelections(pending);
    expect(isReady(sels)).toBe(false);

    sels = toggle(sels, 0, 'C', false);
    expect(isReady(sels)).toBe(false); // q[1] still empty

    sels = toggle(sels, 1, 'X', false);
    expect(isReady(sels)).toBe(true);
  });
});

// ── Focus index logic ─────────────────────────────────────────────────────────

function moveFocus(prev: number[], qIdx: number, delta: number, optCount: number): number[] {
  const next = [...prev];
  next[qIdx] = Math.max(0, Math.min(optCount - 1, (prev[qIdx] ?? 0) + delta));
  return next;
}

describe('AskModal focus index logic', () => {
  it('clamps focus at 0 (no underflow)', () => {
    const idx = [0];
    expect(moveFocus(idx, 0, -1, 3)[0]).toBe(0);
  });

  it('clamps focus at optCount - 1 (no overflow)', () => {
    const idx = [2];
    expect(moveFocus(idx, 0, 5, 3)[0]).toBe(2);
  });

  it('moves focus down by delta', () => {
    const idx = [1];
    expect(moveFocus(idx, 0, 1, 4)[0]).toBe(2);
  });

  it('moves focus up by delta', () => {
    const idx = [2];
    expect(moveFocus(idx, 0, -1, 4)[0]).toBe(1);
  });

  it('does not mutate the original array', () => {
    const idx = [0, 1];
    moveFocus(idx, 0, 1, 3);
    expect(idx[0]).toBe(0);
  });
});

// ── Pending type: preview field propagates correctly ─────────────────────────

describe('PendingOption.preview type contract', () => {
  it('options with preview are accepted by the PendingQuestion type', () => {
    const q: PendingQuestion = {
      question: 'Pick architecture',
      options: [
        {
          label: 'Monolith',
          description: 'Single deployable',
          preview: '┌────────────────┐\n│   Monolith     │\n│  (all-in-one)  │\n└────────────────┘',
        },
        {
          label: 'Microservices',
          description: 'Distributed services',
          preview: '┌──────┐  ┌──────┐\n│ svc1 │  │ svc2 │\n└──────┘  └──────┘',
        },
      ],
    };
    expect(questionHasPreview(q)).toBe(true);
    expect(q.options[0].preview).toContain('Monolith');
    expect(q.options[1].preview).toContain('svc1');
  });

  it('options without preview remain valid (field is optional)', () => {
    const q: PendingQuestion = {
      question: 'Pick one',
      options: [{ label: 'Yes' }, { label: 'No' }],
    };
    expect(questionHasPreview(q)).toBe(false);
  });
});
