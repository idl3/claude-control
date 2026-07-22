import { describe, it, expect } from 'vitest';
import { questionHasPreview, isFreeTextOption } from './AskQuestionForm';
import type { AskQuestion } from './types';

function makeQuestion(partial: Partial<AskQuestion>): AskQuestion {
  return { question: 'Choose an option', options: [], ...partial };
}

describe('questionHasPreview', () => {
  it('returns false when no options have a preview', () => {
    const q = makeQuestion({ options: [{ label: 'A' }, { label: 'B', description: 'd' }] });
    expect(questionHasPreview(q)).toBe(false);
  });

  it('returns true when at least one option has a non-empty preview', () => {
    const q = makeQuestion({
      options: [{ label: 'A' }, { label: 'B', preview: 'ascii art' }],
    });
    expect(questionHasPreview(q)).toBe(true);
  });

  it('returns false when preview is an empty string', () => {
    const q = makeQuestion({ options: [{ label: 'A', preview: '' }] });
    expect(questionHasPreview(q)).toBe(false);
  });

  it('returns false for an empty options array', () => {
    expect(questionHasPreview(makeQuestion({}))).toBe(false);
  });

  it('returns true even when only the last option has a preview', () => {
    const q = makeQuestion({
      options: [{ label: 'A' }, { label: 'B' }, { label: 'C', preview: 'x' }],
    });
    expect(questionHasPreview(q)).toBe(true);
  });
});

describe('isFreeTextOption', () => {
  it('matches "Type something" (case-insensitive)', () => {
    expect(isFreeTextOption('Type something')).toBe(true);
    expect(isFreeTextOption('type something')).toBe(true);
  });

  it('matches "Chat about this" (case-insensitive)', () => {
    expect(isFreeTextOption('Chat about this')).toBe(true);
    expect(isFreeTextOption('chat about this')).toBe(true);
  });

  it('returns false for normal option labels', () => {
    expect(isFreeTextOption('Yes')).toBe(false);
    expect(isFreeTextOption('Use option A (Recommended)')).toBe(false);
    expect(isFreeTextOption('Something else')).toBe(false);
  });

  it('matches when label contains the phrase', () => {
    expect(isFreeTextOption('Or type something here')).toBe(true);
  });
});
