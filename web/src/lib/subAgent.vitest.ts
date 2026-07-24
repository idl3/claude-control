import { describe, it, expect } from 'vitest';
import { subAgentPrefix, applySubAgentPrefix } from './subAgent';

const GENERIC =
  'Dispatch this to a sub-agent — use the Task/Agent tool to delegate it, do not do the work yourself:';

describe('subAgentPrefix', () => {
  it('returns empty string when mode is false', () => {
    expect(subAgentPrefix(false)).toBe('');
  });

  it('returns the generic dispatch directive when mode is true', () => {
    expect(subAgentPrefix(true)).toBe(GENERIC);
  });

  it('names the agent in the directive for a string agent name', () => {
    expect(subAgentPrefix('researcher')).toBe(
      'Dispatch this to the researcher sub-agent — use the Task/Agent tool to delegate it, do not do the work yourself:',
    );
  });

  it('returns empty string for an empty string (off)', () => {
    expect(subAgentPrefix('')).toBe('');
  });

  it('is an imperative to delegate, not a passive hint (so the parent actually dispatches)', () => {
    // The old "Using a sub-agent" note read like a hint the parent ignored.
    expect(subAgentPrefix(true)).toMatch(/^Dispatch this to /);
    expect(subAgentPrefix(true)).toMatch(/do not do the work yourself/);
  });
});

describe('applySubAgentPrefix', () => {
  it('prepends the directive with a single-space separator when mode is on', () => {
    expect(applySubAgentPrefix('hello world', true)).toBe(`${GENERIC} hello world`);
  });

  it('returns original text unchanged when mode is off', () => {
    expect(applySubAgentPrefix('hello world', false)).toBe('hello world');
  });

  it('returns original text unchanged for empty text (do not send bare directive)', () => {
    expect(applySubAgentPrefix('', true)).toBe('');
  });

  it('works with a named agent', () => {
    expect(applySubAgentPrefix('do the thing', 'coder')).toBe(
      'Dispatch this to the coder sub-agent — use the Task/Agent tool to delegate it, do not do the work yourself: do the thing',
    );
  });

  it('separator is a single space; directive ends with a colon then exactly one space before the text', () => {
    const result = applySubAgentPrefix('x text', true);
    expect(result).toBe(`${GENERIC} x text`);
    expect(result).toMatch(/yourself: x text$/);
  });
});
