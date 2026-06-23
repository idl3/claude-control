import { describe, it, expect } from 'vitest';
import { parseAskAnswers } from './MessageParts';

describe('parseAskAnswers', () => {
  it('parses a single question/answer pair', () => {
    const text =
      'Your questions have been answered: "How should X behave?"="Raw passthrough". You can now continue.';
    expect(parseAskAnswers(text)).toEqual([
      { question: 'How should X behave?', answer: 'Raw passthrough' },
    ]);
  });

  it('parses multiple pairs', () => {
    const text =
      'Your questions have been answered: "Q1"="A1", "Q2"="A2". You can now continue.';
    expect(parseAskAnswers(text)).toEqual([
      { question: 'Q1', answer: 'A1' },
      { question: 'Q2', answer: 'A2' },
    ]);
  });

  it('returns [] when there are no quoted pairs', () => {
    expect(parseAskAnswers('no pairs here')).toEqual([]);
    expect(parseAskAnswers('')).toEqual([]);
  });

  it('captures the answer up to the closing quote (ignores trailing preview junk)', () => {
    const text = 'answered: "Which?"="All prompt types" selected preview:\nstuff';
    expect(parseAskAnswers(text)).toEqual([{ question: 'Which?', answer: 'All prompt types' }]);
  });
});
