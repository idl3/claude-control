import { describe, it, expect } from 'vitest';
import { latestAgentSummary } from './agentSummary';
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
