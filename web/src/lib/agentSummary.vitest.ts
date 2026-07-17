import { describe, it, expect } from 'vitest';
import { latestAgentSummary, recentAgentSummaries } from './agentSummary';
import type { SubAgent } from './types';

function agent(partial: Partial<SubAgent>): SubAgent {
  return {
    agentId: 'a1',
    toolUseId: null,
    agentType: 'coder',
    description: null,
    status: 'running',
    messages: [],
    ...partial,
  };
}

describe('latestAgentSummary', () => {
  it('returns the last text output, collapsed', () => {
    const a = agent({
      messages: [
        { uuid: '1', role: 'assistant', blocks: [{ kind: 'text', text: 'first' }] },
        { uuid: '2', role: 'assistant', blocks: [{ kind: 'text', text: 'second  line' }] },
      ],
    });
    expect(latestAgentSummary(a)).toBe('second line');
  });

  it('skips trailing messages with no text and uses the most recent that has it', () => {
    const a = agent({
      messages: [
        { uuid: '1', role: 'assistant', blocks: [{ kind: 'text', text: 'real work' }] },
        { uuid: '2', role: 'assistant', blocks: [{ kind: 'tool_use', id: 't', name: 'Bash' }] },
      ],
    });
    expect(latestAgentSummary(a)).toBe('real work');
  });

  it('falls back to thinking text when no plain text block exists', () => {
    const a = agent({
      messages: [{ uuid: '1', role: 'assistant', blocks: [{ kind: 'thinking', text: 'pondering' }] }],
    });
    expect(latestAgentSummary(a)).toBe('pondering');
  });

  it('falls back to description when there are no messages', () => {
    expect(latestAgentSummary(agent({ messages: [], description: 'fix the bug' }))).toBe('fix the bug');
  });

  it('returns empty string when nothing is available', () => {
    expect(latestAgentSummary(agent({ messages: [], description: null }))).toBe('');
  });

  it('truncates long summaries', () => {
    const long = 'x'.repeat(200);
    const a = agent({ messages: [{ uuid: '1', role: 'assistant', blocks: [{ kind: 'text', text: long }] }] });
    const out = latestAgentSummary(a);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('recentAgentSummaries', () => {
  it('returns the last N distinct lines, oldest first / most recent last', () => {
    const a = agent({
      messages: [
        { uuid: '1', role: 'assistant', blocks: [{ kind: 'text', text: 'one' }] },
        { uuid: '2', role: 'assistant', blocks: [{ kind: 'text', text: 'two' }] },
        { uuid: '3', role: 'assistant', blocks: [{ kind: 'text', text: 'three' }] },
      ],
    });
    expect(recentAgentSummaries(a, 5)).toEqual(['one', 'two', 'three']);
  });

  it('caps at `limit`, keeping the most recent lines', () => {
    const a = agent({
      messages: Array.from({ length: 8 }, (_, i) => ({
        uuid: String(i),
        role: 'assistant' as const,
        blocks: [{ kind: 'text' as const, text: `line ${i}` }],
      })),
    });
    expect(recentAgentSummaries(a, 5)).toEqual(['line 3', 'line 4', 'line 5', 'line 6', 'line 7']);
  });

  it('collapses consecutive duplicate lines to one', () => {
    const a = agent({
      messages: [
        { uuid: '1', role: 'assistant', blocks: [{ kind: 'text', text: 'working on it' }] },
        { uuid: '2', role: 'assistant', blocks: [{ kind: 'thinking', text: 'working on it' }] },
        { uuid: '3', role: 'assistant', blocks: [{ kind: 'text', text: 'done' }] },
      ],
    });
    expect(recentAgentSummaries(a, 5)).toEqual(['working on it', 'done']);
  });

  it('skips messages with no text (tool_use/tool_result only)', () => {
    const a = agent({
      messages: [
        { uuid: '1', role: 'assistant', blocks: [{ kind: 'text', text: 'first' }] },
        { uuid: '2', role: 'assistant', blocks: [{ kind: 'tool_use', id: 't', name: 'Bash' }] },
        {
          uuid: '3',
          role: 'assistant',
          blocks: [{ kind: 'tool_result', forId: 't', text: 'output' }],
        },
        { uuid: '4', role: 'assistant', blocks: [{ kind: 'text', text: 'second' }] },
      ],
    });
    expect(recentAgentSummaries(a, 5)).toEqual(['first', 'second']);
  });

  it('falls back to description when there is no message text at all', () => {
    expect(recentAgentSummaries(agent({ messages: [], description: 'fix the bug' }))).toEqual([
      'fix the bug',
    ]);
  });

  it('returns an empty array when nothing is available', () => {
    expect(recentAgentSummaries(agent({ messages: [], description: null }))).toEqual([]);
  });
});
