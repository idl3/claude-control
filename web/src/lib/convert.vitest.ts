import { describe, it, expect } from 'vitest';
import {
  convertMessages,
  compactSystemText,
  toolSummary,
  toolInput,
  toolResult,
} from './convert';
import type { Msg } from './types';

// Narrow helpers so assertions read cleanly without `any`.
type AnyPart = Record<string, unknown> & { type: string };
function parts(m: { content: unknown }): AnyPart[] {
  return (m.content as AnyPart[]) ?? [];
}

describe('convertMessages — role mapping', () => {
  it('maps a user text message to role "user"', () => {
    const msgs: Msg[] = [
      { uuid: 'u1', role: 'user', blocks: [{ kind: 'text', text: 'hello' }] },
    ];
    const out = convertMessages(msgs);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
    expect(parts(out[0])).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('maps an assistant text message to role "assistant"', () => {
    const msgs: Msg[] = [
      { uuid: 'a1', role: 'assistant', blocks: [{ kind: 'text', text: 'hi' }] },
    ];
    const out = convertMessages(msgs);
    expect(out[0].role).toBe('assistant');
  });

  it('renders system messages as assistant role, tagged via metadata.cockpitRole', () => {
    const msgs: Msg[] = [
      { uuid: 's1', role: 'system', blocks: [{ kind: 'text', text: 'note' }] },
    ];
    const out = convertMessages(msgs);
    expect(out[0].role).toBe('assistant');
    expect((out[0].metadata as { custom?: Record<string, unknown> }).custom)
      .toMatchObject({ cockpitRole: 'system' });
  });
});

describe('convertMessages — block kinds', () => {
  it('maps thinking blocks to reasoning parts', () => {
    const msgs: Msg[] = [
      {
        uuid: 'a1',
        role: 'assistant',
        blocks: [{ kind: 'thinking', text: 'let me think' }],
      },
    ];
    const out = convertMessages(msgs);
    expect(parts(out[0])).toEqual([{ type: 'reasoning', text: 'let me think' }]);
  });

  it('drops empty / whitespace-only thinking blocks', () => {
    const msgs: Msg[] = [
      {
        uuid: 'a1',
        role: 'assistant',
        blocks: [
          { kind: 'thinking', text: '   ' },
          { kind: 'text', text: 'real' },
        ],
      },
    ];
    const out = convertMessages(msgs);
    expect(parts(out[0])).toEqual([{ type: 'text', text: 'real' }]);
  });

  it('drops empty text blocks (assistant-ui rejects them)', () => {
    const msgs: Msg[] = [
      {
        uuid: 'a1',
        role: 'assistant',
        blocks: [
          { kind: 'text', text: '' },
          { kind: 'text', text: 'kept' },
        ],
      },
    ];
    const out = convertMessages(msgs);
    expect(parts(out[0])).toEqual([{ type: 'text', text: 'kept' }]);
  });

  it('maps tool_use to a tool-call part with structured args + summary', () => {
    const msgs: Msg[] = [
      {
        uuid: 'a1',
        role: 'assistant',
        blocks: [
          {
            kind: 'tool_use',
            id: 't1',
            name: 'Bash',
            input: { command: 'ls' },
            inputSummary: 'ls',
          },
        ],
      },
    ];
    const out = convertMessages(msgs);
    const p = parts(out[0])[0];
    expect(p.type).toBe('tool-call');
    expect(p.toolCallId).toBe('t1');
    expect(p.toolName).toBe('Bash');
    expect(p.argsText).toBe('ls');
    // structured input survives, with the reserved summary key alongside it.
    expect(toolInput(p.args)).toEqual({ command: 'ls' });
    expect(toolSummary(p.args)).toBe('ls');
  });

  it('wraps a non-object tool_use input under {value}', () => {
    const msgs: Msg[] = [
      {
        uuid: 'a1',
        role: 'assistant',
        blocks: [
          { kind: 'tool_use', id: 't1', name: 'X', input: 'rawstring' },
        ],
      },
    ];
    const out = convertMessages(msgs);
    expect(toolInput(parts(out[0])[0].args)).toEqual({ value: 'rawstring' });
  });

  it('defaults a missing tool name to "tool" and missing input to {}', () => {
    const msgs: Msg[] = [
      {
        uuid: 'a1',
        role: 'assistant',
        blocks: [{ kind: 'tool_use', id: 't1', name: '' }],
      },
    ];
    const out = convertMessages(msgs);
    const p = parts(out[0])[0];
    expect(p.toolName).toBe('tool');
    expect(toolInput(p.args)).toEqual({});
  });
});

describe('convertMessages — tool_result folding by toolUseId', () => {
  it('folds a tool_result from a LATER message into the matching tool-call', () => {
    const msgs: Msg[] = [
      {
        uuid: 'a1',
        role: 'assistant',
        blocks: [{ kind: 'tool_use', id: 't1', name: 'Bash' }],
      },
      {
        uuid: 'u2',
        role: 'user',
        blocks: [{ kind: 'tool_result', forId: 't1', text: 'output here' }],
      },
    ];
    const out = convertMessages(msgs);
    // The result-only message is dropped; only the assistant tool-call remains.
    expect(out).toHaveLength(1);
    const p = parts(out[0])[0];
    expect(p.type).toBe('tool-call');
    expect(toolResult(p.result)).toEqual({ text: 'output here', isError: false });
  });

  it('marks isError on both the part and the wrapped result', () => {
    const msgs: Msg[] = [
      {
        uuid: 'a1',
        role: 'assistant',
        blocks: [{ kind: 'tool_use', id: 't1', name: 'Bash' }],
      },
      {
        uuid: 'u2',
        role: 'user',
        blocks: [
          { kind: 'tool_result', forId: 't1', text: 'boom', isError: true },
        ],
      },
    ];
    const out = convertMessages(msgs);
    const p = parts(out[0])[0];
    expect(p.isError).toBe(true);
    expect(toolResult(p.result)).toEqual({ text: 'boom', isError: true });
  });

  it('leaves result undefined for a tool-call with no matching result', () => {
    const msgs: Msg[] = [
      {
        uuid: 'a1',
        role: 'assistant',
        blocks: [{ kind: 'tool_use', id: 't1', name: 'Bash' }],
      },
    ];
    const out = convertMessages(msgs);
    expect(parts(out[0])[0].result).toBeUndefined();
  });

  it('drops a message containing ONLY tool_result blocks', () => {
    const msgs: Msg[] = [
      {
        uuid: 'u1',
        role: 'user',
        blocks: [{ kind: 'tool_result', forId: 'unknown', text: 'x' }],
      },
    ];
    expect(convertMessages(msgs)).toHaveLength(0);
  });

  it('uses the LAST tool_result when an id appears more than once', () => {
    const msgs: Msg[] = [
      {
        uuid: 'a1',
        role: 'assistant',
        blocks: [{ kind: 'tool_use', id: 't1', name: 'Bash' }],
      },
      {
        uuid: 'u2',
        role: 'user',
        blocks: [{ kind: 'tool_result', forId: 't1', text: 'first' }],
      },
      {
        uuid: 'u3',
        role: 'user',
        blocks: [{ kind: 'tool_result', forId: 't1', text: 'second' }],
      },
    ];
    const out = convertMessages(msgs);
    expect(toolResult(parts(out[0])[0].result)?.text).toBe('second');
  });

  it('keeps mixed text + tool_use in the same assistant message', () => {
    const msgs: Msg[] = [
      {
        uuid: 'a1',
        role: 'assistant',
        blocks: [
          { kind: 'text', text: 'running it' },
          { kind: 'tool_use', id: 't1', name: 'Bash' },
        ],
      },
    ];
    const out = convertMessages(msgs);
    const ps = parts(out[0]);
    expect(ps.map((p) => p.type)).toEqual(['text', 'tool-call']);
  });
});

describe('convertMessages — ids, timestamps, edge inputs', () => {
  it('returns [] for empty input', () => {
    expect(convertMessages([])).toEqual([]);
  });

  it('tolerates a message with no blocks', () => {
    const msgs = [{ uuid: 'a1', role: 'assistant' } as unknown as Msg];
    expect(convertMessages(msgs)).toHaveLength(0);
  });

  it('uses uuid as id and falls back to index when uuid is empty', () => {
    const msgs: Msg[] = [
      { uuid: '', role: 'user', blocks: [{ kind: 'text', text: 'x' }] },
    ];
    expect(convertMessages(msgs)[0].id).toBe('m-0');
  });

  it('converts ts to a Date createdAt', () => {
    const msgs: Msg[] = [
      { uuid: 'u1', role: 'user', ts: 1700000000000, blocks: [{ kind: 'text', text: 'x' }] },
    ];
    const ca = convertMessages(msgs)[0].createdAt;
    expect(ca).toBeInstanceOf(Date);
    expect((ca as Date).getTime()).toBe(1700000000000);
  });
});

describe('convertMessages — user system-plumbing compaction', () => {
  it('compacts a <system-reminder> user block to a one-liner', () => {
    const msgs: Msg[] = [
      {
        uuid: 'u1',
        role: 'user',
        blocks: [{ kind: 'text', text: '<system-reminder>noisy</system-reminder>' }],
      },
    ];
    expect(parts(convertMessages(msgs)[0])[0].text).toBe('⚙ system reminder');
  });

  it('does NOT compact normal user prose', () => {
    const msgs: Msg[] = [
      { uuid: 'u1', role: 'user', blocks: [{ kind: 'text', text: 'do the thing' }] },
    ];
    expect(parts(convertMessages(msgs)[0])[0].text).toBe('do the thing');
  });

  it('does NOT compact plumbing-looking text on ASSISTANT turns', () => {
    const msgs: Msg[] = [
      {
        uuid: 'a1',
        role: 'assistant',
        blocks: [{ kind: 'text', text: '<system-reminder>x</system-reminder>' }],
      },
    ];
    expect(parts(convertMessages(msgs)[0])[0].text).toBe(
      '<system-reminder>x</system-reminder>',
    );
  });
});

describe('compactSystemText', () => {
  it('returns null for non-tag text', () => {
    expect(compactSystemText('hello')).toBeNull();
  });
  it('compacts task-notification with summary', () => {
    expect(
      compactSystemText('<task-notification><summary>did X</summary></task-notification>'),
    ).toBe('⚙ background task — did X');
  });
  it('compacts task-notification without summary', () => {
    expect(compactSystemText('<task-notification></task-notification>')).toBe(
      '⚙ background task update',
    );
  });
  it('compacts slash command echoes', () => {
    expect(compactSystemText('<command-name>/foo</command-name>')).toBe('⌘ slash command');
    expect(compactSystemText('<command-message>x</command-message>')).toBe('⌘ slash command');
  });
  it('compacts local-command-stdout', () => {
    expect(compactSystemText('<local-command-stdout>out</local-command-stdout>')).toBe(
      '⌘ command output',
    );
  });
  it('compacts session hooks', () => {
    expect(compactSystemText('<user-prompt-submit-hook>')).toBe('⚙ session hook');
    expect(compactSystemText('<session-start>')).toBe('⚙ session hook');
  });
  it('returns null for an unrecognized leading tag', () => {
    expect(compactSystemText('<unknown>x</unknown>')).toBeNull();
  });
  it('tolerates leading whitespace before the tag', () => {
    expect(compactSystemText('   <system-reminder>x</system-reminder>')).toBe(
      '⚙ system reminder',
    );
  });
});

describe('toolSummary / toolInput / toolResult accessors', () => {
  it('toolSummary returns "" for non-objects and missing key', () => {
    expect(toolSummary(null)).toBe('');
    expect(toolSummary('str')).toBe('');
    expect(toolSummary({ a: 1 })).toBe('');
  });
  it('toolInput passes through non-objects unchanged', () => {
    expect(toolInput(null)).toBeNull();
    expect(toolInput('x')).toBe('x');
  });
  it('toolResult coerces text and returns null for non-result shapes', () => {
    expect(toolResult({ text: 5, isError: 1 })).toEqual({ text: '5', isError: true });
    expect(toolResult({})).toBeNull();
    expect(toolResult(null)).toBeNull();
  });
});

describe('convertMessages — assistant turn merging', () => {
  it('merges consecutive assistant messages into one turn (id = turn start)', () => {
    const out = convertMessages([
      { uuid: 'a1', role: 'assistant', blocks: [{ kind: 'thinking', text: 'pondering' }] },
      { uuid: 'a2', role: 'assistant', blocks: [{ kind: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
      { uuid: 'a3', role: 'assistant', blocks: [{ kind: 'text', text: 'done' }] },
    ] as Msg[]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('a1');
    expect(parts(out[0]).map((p) => p.type)).toEqual(['reasoning', 'tool-call', 'text']);
  });

  it('does NOT merge across a real user message (turn boundary)', () => {
    const out = convertMessages([
      { uuid: 'a1', role: 'assistant', blocks: [{ kind: 'text', text: 'first' }] },
      { uuid: 'u1', role: 'user', blocks: [{ kind: 'text', text: 'reply' }] },
      { uuid: 'a2', role: 'assistant', blocks: [{ kind: 'text', text: 'second' }] },
    ] as Msg[]);
    expect(out.map((m) => m.id)).toEqual(['a1', 'u1', 'a2']);
  });

  it('does NOT merge a tagged system message into an assistant turn', () => {
    const out = convertMessages([
      { uuid: 'a1', role: 'assistant', blocks: [{ kind: 'text', text: 'a' }] },
      { uuid: 's1', role: 'system', blocks: [{ kind: 'text', text: 'sys' }] },
      { uuid: 'a2', role: 'assistant', blocks: [{ kind: 'text', text: 'b' }] },
    ] as Msg[]);
    expect(out).toHaveLength(3);
    expect(out[1].metadata?.custom?.cockpitRole).toBe('system');
  });
});

describe('convertMessages id dedupe', () => {
  // assistant-ui's MessageRepository THROWS on duplicate ids (crashes the thread).
  // Compacted/resumed transcripts can repeat a uuid, so ids must be made unique.
  it('produces unique ids even when the transcript repeats a uuid', () => {
    const out = convertMessages([
      { uuid: 'dup', role: 'user', ts: 1, blocks: [{ kind: 'text', text: 'first' }] },
      { uuid: 'dup', role: 'user', ts: 2, blocks: [{ kind: 'text', text: 'second' }] },
      { uuid: 'other', role: 'user', ts: 3, blocks: [{ kind: 'text', text: 'third' }] },
    ] as Msg[]);
    const ids = out.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(ids).toContain('dup'); // first occurrence keeps the original id
  });
});
