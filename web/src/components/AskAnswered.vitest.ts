import { describe, it, expect } from 'vitest';
import { parseAskAnswers, normalizeAskQuestions } from './MessageParts';

describe('normalizeAskQuestions', () => {
  const QS = [{ question: 'Which format?', header: 'Slack card', options: [{ label: 'A', description: 'a' }] }];

  it('passes a well-formed array through', () => {
    expect(normalizeAskQuestions(QS)).toEqual(QS);
  });

  // The transcript-killer: `questions` recorded as one JSON string.
  it('parses a double-encoded questions array', () => {
    expect(normalizeAskQuestions(JSON.stringify(QS))).toEqual(QS);
  });

  it('returns [] for shapes that cannot be rendered', () => {
    for (const junk of [undefined, null, 'not json', '{"a":1}', 42, { questions: QS }]) {
      expect(normalizeAskQuestions(junk)).toEqual([]);
    }
  });

  // The shape that actually crashed the transcript: two JSON arrays concatenated
  // into one string. Unparseable → [] → caller renders the raw tool row instead.
  it('returns [] for concatenated JSON arrays without throwing', () => {
    const concat = JSON.stringify(QS) + JSON.stringify(QS);
    expect(() => normalizeAskQuestions(concat)).not.toThrow();
    expect(normalizeAskQuestions(concat)).toEqual([]);
  });

  it('drops a non-array options so `.find`/`.filter` cannot throw either', () => {
    const [q] = normalizeAskQuestions([{ question: 'Q', options: '[]' }]);
    expect(q.options).toBeUndefined();
  });
});

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
