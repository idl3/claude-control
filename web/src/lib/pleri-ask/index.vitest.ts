import { describe, it, expect } from 'vitest';
import {
  ASK_VERSION,
  QuestionKind,
  OptionFlag,
  PreviewType,
  WireframeElement,
  WireframeVariant,
  kindLabel,
  previewTypeLabel,
  serializeAsk,
  parseAsk,
  serializeAnswer,
  parseAnswer,
  serializeAskBlock,
  serializeAnswerBlock,
  assertSingleLineAnswerBlock,
  extractBlock,
  parseAskBlock,
  parseAnswerBlock,
  correlate,
  ASK_TAG,
  ANSWER_TAG,
} from './index';
import type { AskEnvelope, AnswerEnvelope } from './index';

// The design's reference ask (docs/design/ask-protocol.md "Wire for that"):
// a multi-question set with an option carrying a wireframe preview.
const REFERENCE_ASK: AskEnvelope = {
  v: 1,
  qid: 'a1',
  q: [
    {
      h: 'Auth',
      t: 'Which auth method?',
      k: QuestionKind.single,
      r: 0,
      o: [
        { l: 'OAuth', d: 'OAuth 2.0 flow' },
        { l: 'API key', d: 'Static env key' },
        {
          l: 'mTLS',
          d: 'Client certs',
          p: {
            pt: PreviewType.wireframe,
            w: [
              [
                WireframeElement.frame,
                {},
                [
                  [WireframeElement.text, { x: 'Which auth?' }],
                  [
                    WireframeElement.row,
                    {},
                    [
                      [WireframeElement.button, { x: 'OAuth', v: WireframeVariant.primary }],
                      [WireframeElement.button, { x: 'API key' }],
                    ],
                  ],
                  [WireframeElement.input, { x: 'key…', g: 1 }],
                ],
              ],
            ],
          },
        },
      ],
    },
    {
      h: 'Scope',
      t: 'Grant scopes (multi):',
      k: QuestionKind.multi,
      o: [{ l: 'read' }, { l: 'write' }, { l: 'admin' }],
    },
  ],
};

describe('pleri-ask: enum schema', () => {
  it('ASK_VERSION is 1', () => {
    expect(ASK_VERSION).toBe(1);
  });

  it('exposes the documented enum codes', () => {
    expect([QuestionKind.single, QuestionKind.multi, QuestionKind.freeText, QuestionKind.confirm]).toEqual([0, 1, 2, 3]);
    expect([OptionFlag.plain, OptionFlag.danger]).toEqual([0, 1]);
    expect([PreviewType.markdown, PreviewType.code, PreviewType.wireframe, PreviewType.diagram]).toEqual([0, 1, 2, 3]);
    expect(WireframeElement.frame).toBe(0);
    expect(WireframeElement.img).toBe(9);
  });

  it('label resolvers degrade gracefully on unknown codes', () => {
    expect(kindLabel(QuestionKind.multi)).toBe('multi-select');
    expect(kindLabel(99)).toBe('kind:99');
    expect(previewTypeLabel(99)).toBe('preview:99');
  });
});

describe('pleri-ask: ask round-trip', () => {
  it('serialize → parse is loss-less for the reference multi-question ask', () => {
    const wire = serializeAsk(REFERENCE_ASK);
    const back = parseAsk(wire);
    expect(back).toEqual(REFERENCE_ASK);
  });

  it('serializes to a single compact line carrying only codes (no type metadata)', () => {
    const wire = serializeAsk(REFERENCE_ASK);
    expect(wire.includes('\n')).toBe(false);
    // H1: no field-definition / verbose categorical metadata on the wire.
    expect(wire).not.toContain('multiSelect');
    expect(wire).not.toContain('single-select');
    expect(wire).not.toContain('question');
    expect(wire).not.toContain('header');
  });

  it('parseAsk accepts an already-parsed object', () => {
    expect(parseAsk(REFERENCE_ASK)).toEqual(REFERENCE_ASK);
  });
});

describe('pleri-ask: answer kinds (positional, type-discriminated)', () => {
  it('single-select → int', () => {
    const a: AnswerEnvelope = { v: 1, qid: 'a1', a: [0] };
    expect(parseAnswer(serializeAnswer(a))).toEqual(a);
  });

  it('multi-select → array of ints', () => {
    const a: AnswerEnvelope = { v: 1, qid: 'a1', a: [[1, 2]] };
    expect(parseAnswer(serializeAnswer(a))).toEqual(a);
  });

  it('free-text / "Other" → string', () => {
    const a: AnswerEnvelope = { v: 1, qid: 'a1', a: ['a custom value'] };
    expect(parseAnswer(serializeAnswer(a))).toEqual(a);
  });

  it('confirm → 0 / 1', () => {
    const yes: AnswerEnvelope = { v: 1, qid: 'a1', a: [1] };
    const no: AnswerEnvelope = { v: 1, qid: 'a1', a: [0] };
    expect(parseAnswer(serializeAnswer(yes))).toEqual(yes);
    expect(parseAnswer(serializeAnswer(no))).toEqual(no);
  });

  it('multi-question answer mixes slot types in q[] order', () => {
    const a: AnswerEnvelope = { v: 1, qid: 'a1', a: [0, [1, 2], 'custom'] };
    expect(parseAnswer(serializeAnswer(a))).toEqual(a);
  });

  it('carries the whole-set cancel flag', () => {
    const a: AnswerEnvelope = { v: 1, qid: 'a1', a: [], x: 1 };
    expect(parseAnswer(serializeAnswer(a))).toEqual(a);
  });
});

describe('pleri-ask: single-line answer invariant (OQ17)', () => {
  it('serializeAnswer never emits a raw newline even for newline-bearing free-text', () => {
    const a: AnswerEnvelope = { v: 1, qid: 'a1', a: ['line one\nline two\r\nline three'] };
    const wire = serializeAnswer(a);
    expect(wire.includes('\n')).toBe(false);
    expect(wire.includes('\r')).toBe(false);
    // and the newlines survive the escape → parse round-trip byte-exact.
    expect(parseAnswer(wire)?.a[0]).toBe('line one\nline two\r\nline three');
  });

  it('serializeAnswerBlock is a single physical line', () => {
    const a: AnswerEnvelope = { v: 1, qid: 'a1', a: ['multi\nline'] };
    const block = serializeAnswerBlock(a);
    expect(block.includes('\n')).toBe(false);
    expect(block.startsWith(`<${ANSWER_TAG}>`)).toBe(true);
    expect(block.endsWith(`</${ANSWER_TAG}>`)).toBe(true);
  });

  it('assertSingleLineAnswerBlock passes a single-line block and rejects a multi-line one', () => {
    const ok = serializeAnswerBlock({ v: 1, qid: 'a1', a: [0] });
    expect(assertSingleLineAnswerBlock(ok)).toBe(ok);
    expect(() => assertSingleLineAnswerBlock('<pleri:answer>{"v":1,\n"qid":"a1"}</pleri:answer>')).toThrow();
    expect(() => assertSingleLineAnswerBlock('<pleri:answer>line\r\nbreak</pleri:answer>')).toThrow();
  });
});

describe('pleri-ask: forward-compat (H3 — never throws, never drops)', () => {
  it('keeps an unknown question-kind code without dropping the set', () => {
    const back = parseAsk('{"v":1,"qid":"a1","q":[{"t":"x","k":99}]}');
    expect(back).not.toBeNull();
    expect(back!.q).toHaveLength(1);
    expect(back!.q[0].k).toBe(99);
  });

  it('keeps unknown preview / flag codes', () => {
    const back = parseAsk('{"v":1,"qid":"a1","q":[{"t":"x","k":0,"o":[{"l":"o","f":99,"p":{"pt":42,"s":"?"}}]}]}');
    expect(back).not.toBeNull();
    expect(back!.q[0].o![0].f).toBe(99);
    expect(back!.q[0].o![0].p!.pt).toBe(42);
  });

  it('preserves an unrecognized extra key (does not strip it)', () => {
    const back = parseAsk('{"v":1,"qid":"a1","q":[{"t":"x","k":0}],"zz":{"future":true}}');
    expect(back).not.toBeNull();
    expect((back as Record<string, unknown>).zz).toEqual({ future: true });
  });

  it('tolerates an unknown answer key', () => {
    const back = parseAnswer('{"v":1,"qid":"a1","a":[0],"future":7}');
    expect(back).not.toBeNull();
    expect((back as Record<string, unknown>).future).toBe(7);
  });
});

describe('pleri-ask: lenient parse returns null (never throws) on invalid input', () => {
  it('malformed JSON → null', () => {
    expect(parseAsk('{not json')).toBeNull();
    expect(parseAnswer(']['))
      .toBeNull();
  });

  it('missing required skeleton → null', () => {
    expect(parseAsk('{"qid":"a1","q":[]}')).toBeNull(); // no v
    expect(parseAsk('{"v":1,"q":[]}')).toBeNull(); // no qid
    expect(parseAsk('{"v":1,"qid":"a1"}')).toBeNull(); // no q
    expect(parseAnswer('{"v":1,"qid":"a1"}')).toBeNull(); // no a
  });

  it('non-object / wrong types → null', () => {
    expect(parseAsk('42')).toBeNull();
    expect(parseAsk('[]')).toBeNull();
    expect(parseAsk(null)).toBeNull();
    expect(parseAsk(undefined)).toBeNull();
    expect(parseAnswer('"a string"')).toBeNull();
  });
});

describe('pleri-ask: wire framing + correlation', () => {
  it('ask block wraps + round-trips', () => {
    const block = serializeAskBlock(REFERENCE_ASK);
    expect(block.startsWith(`<${ASK_TAG}>`)).toBe(true);
    expect(parseAskBlock(`prefix ${block} suffix`)).toEqual(REFERENCE_ASK);
  });

  it('answer block wraps + round-trips out of surrounding text', () => {
    const a: AnswerEnvelope = { v: 1, qid: 'a1', a: [0, [1, 2], 'custom'] };
    const block = serializeAnswerBlock(a);
    expect(parseAnswerBlock(`please: ${block}\n(sent)`)).toEqual(a);
  });

  it('extractBlock returns null when the tag is absent', () => {
    expect(extractBlock('no tags here', ANSWER_TAG)).toBeNull();
    expect(parseAnswerBlock('no tags here')).toBeNull();
  });

  it('correlate matches on qid only', () => {
    expect(correlate({ qid: 'a1' }, { qid: 'a1' })).toBe(true);
    expect(correlate({ qid: 'a1' }, { qid: 'b2' })).toBe(false);
    expect(correlate({}, { qid: 'a1' })).toBe(false);
  });
});
