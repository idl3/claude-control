import { describe, it, expect } from 'vitest';
import { adaptNativeAsk } from './nativeAdapter';
import type { NativeAskInput } from './nativeAdapter';
import { QuestionKind, ASK_VERSION, serializeAsk, parseAsk } from './index';

describe('adaptNativeAsk', () => {
  it('maps a single-select question to k:0 with options + descriptions', () => {
    const native: NativeAskInput = {
      toolUseId: 'toolu_01abc',
      questions: [
        {
          question: 'Which auth method?',
          header: 'Auth',
          options: [
            { label: 'OAuth', description: 'OAuth 2.0 flow' },
            { label: 'API key', description: 'Static env key' },
          ],
        },
      ],
    };

    const ask = adaptNativeAsk(native);

    expect(ask.v).toBe(ASK_VERSION);
    expect(ask.qid).toBe('toolu_01abc');
    expect(ask.q).toEqual([
      {
        t: 'Which auth method?',
        h: 'Auth',
        k: QuestionKind.single,
        o: [
          { l: 'OAuth', d: 'OAuth 2.0 flow' },
          { l: 'API key', d: 'Static env key' },
        ],
      },
    ]);
  });

  it('maps multiSelect:true to k:1', () => {
    const native: NativeAskInput = {
      toolUseId: 'toolu_multi',
      questions: [
        {
          question: 'Which frameworks?',
          multiSelect: true,
          options: [{ label: 'React' }, { label: 'Vue' }],
        },
      ],
    };

    const ask = adaptNativeAsk(native);

    expect(ask.q[0].k).toBe(QuestionKind.multi);
    expect(ask.q[0].o).toEqual([{ l: 'React' }, { l: 'Vue' }]);
  });

  it('maps empty/absent options to k:2 free-text with no `o`', () => {
    const emptyOptions: NativeAskInput = {
      toolUseId: 'toolu_free',
      questions: [{ question: 'Anything else?', options: [] }],
    };

    const ask = adaptNativeAsk(emptyOptions);

    expect(ask.q[0].k).toBe(QuestionKind.freeText);
    expect(ask.q[0]).not.toHaveProperty('o');
    expect(ask.q[0]).not.toHaveProperty('ft');
  });

  it('does not add synthetic "Type something" / "Chat about this" rows', () => {
    const native: NativeAskInput = {
      toolUseId: 'toolu_no_synth',
      questions: [
        {
          question: 'Pick one',
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    };

    const ask = adaptNativeAsk(native);

    expect(ask.q[0].o).toHaveLength(2);
    expect(ask.q[0]).not.toHaveProperty('ft');
  });

  it('sets `r` to the index of a `(Recommended)`-suffixed label and strips the marker from `l`', () => {
    const native: NativeAskInput = {
      toolUseId: 'toolu_rec',
      questions: [
        {
          question: 'Which plan?',
          options: [
            { label: 'Basic' },
            { label: 'Pro (Recommended)', description: 'Most popular' },
            { label: 'Enterprise' },
          ],
        },
      ],
    };

    const ask = adaptNativeAsk(native);

    expect(ask.q[0].r).toBe(1);
    expect(ask.q[0].o?.[1]).toEqual({ l: 'Pro', d: 'Most popular' });
  });

  it('detects the marker case-insensitively', () => {
    const native: NativeAskInput = {
      toolUseId: 'toolu_rec_ci',
      questions: [
        {
          question: 'Which plan?',
          options: [{ label: 'Basic' }, { label: 'Pro (recommended)' }],
        },
      ],
    };

    const ask = adaptNativeAsk(native);

    expect(ask.q[0].r).toBe(1);
    expect(ask.q[0].o?.[1]).toEqual({ l: 'Pro' });
  });

  it('uses the FIRST marker when multiple options carry it', () => {
    const native: NativeAskInput = {
      toolUseId: 'toolu_rec_multi',
      questions: [
        {
          question: 'Which plan?',
          options: [
            { label: 'Basic (Recommended)' },
            { label: 'Pro (Recommended)' },
          ],
        },
      ],
    };

    const ask = adaptNativeAsk(native);

    expect(ask.q[0].r).toBe(0);
    expect(ask.q[0].o?.[0]).toEqual({ l: 'Basic' });
    expect(ask.q[0].o?.[1]).toEqual({ l: 'Pro' });
  });

  it('omits `h` when header is absent', () => {
    const native: NativeAskInput = {
      toolUseId: 'toolu_no_header',
      questions: [{ question: 'No header here', options: [{ label: 'X' }] }],
    };

    const ask = adaptNativeAsk(native);

    expect(ask.q[0]).not.toHaveProperty('h');
  });

  it('drops native `preview` (not mapped to `p`)', () => {
    const native: NativeAskInput = {
      toolUseId: 'toolu_preview',
      questions: [
        {
          question: 'Pick a layout',
          options: [{ label: 'Grid', preview: '[grid ascii]' }],
        },
      ],
    };

    const ask = adaptNativeAsk(native);

    expect(ask.q[0].o?.[0]).toEqual({ l: 'Grid' });
    expect(ask.q[0].o?.[0]).not.toHaveProperty('p');
  });

  it('qid === toolUseId verbatim', () => {
    const native: NativeAskInput = {
      toolUseId: 'toolu_verbatim_id_123',
      questions: [{ question: 'Q', options: [] }],
    };

    expect(adaptNativeAsk(native).qid).toBe('toolu_verbatim_id_123');
  });

  it('round-trips through serializeAsk -> parseAsk', () => {
    const native: NativeAskInput = {
      toolUseId: 'toolu_roundtrip',
      questions: [
        {
          question: 'Which auth method?',
          header: 'Auth',
          options: [
            { label: 'OAuth (Recommended)', description: 'OAuth 2.0 flow' },
            { label: 'API key' },
          ],
        },
        { question: 'Anything else?', options: [] },
      ],
    };

    const ask = adaptNativeAsk(native);
    const wire = serializeAsk(ask);
    const parsed = parseAsk(wire);

    expect(parsed).toEqual(ask);
  });

  it('does not mutate the input', () => {
    const native: NativeAskInput = {
      toolUseId: 'toolu_immutable',
      questions: [
        {
          question: 'Which plan?',
          header: 'Plan',
          multiSelect: true,
          options: [
            { label: 'Pro (Recommended)', description: 'Most popular', preview: 'ascii' },
          ],
        },
      ],
    };
    const snapshot = JSON.parse(JSON.stringify(native));

    adaptNativeAsk(native);

    expect(native).toEqual(snapshot);
  });
});
