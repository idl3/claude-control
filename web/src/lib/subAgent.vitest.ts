import { describe, it, expect } from 'vitest';
import { subAgentPrefix, applySubAgentPrefix } from './subAgent';

describe('subAgentPrefix', () => {
  it('returns empty string when mode is false', () => {
    expect(subAgentPrefix(false)).toBe('');
  });

  it('returns "Using a sub-agent" when mode is true', () => {
    expect(subAgentPrefix(true)).toBe('Using a sub-agent');
  });

  it('returns named prefix for a string agent name', () => {
    expect(subAgentPrefix('researcher')).toBe('Using the researcher sub-agent');
  });

  it('returns empty string for an empty string (off)', () => {
    expect(subAgentPrefix('')).toBe('');
  });
});

describe('applySubAgentPrefix', () => {
  it('prepends prefix with separator when mode is on', () => {
    expect(applySubAgentPrefix('hello world', true)).toBe(
      'Using a sub-agent. hello world',
    );
  });

  it('returns original text unchanged when mode is off', () => {
    expect(applySubAgentPrefix('hello world', false)).toBe('hello world');
  });

  it('returns original text unchanged for empty text (do not send bare prefix)', () => {
    expect(applySubAgentPrefix('', true)).toBe('');
  });

  it('works with a named agent', () => {
    expect(applySubAgentPrefix('do the thing', 'coder')).toBe(
      'Using the coder sub-agent. do the thing',
    );
  });

  it('separator is a single period+space; no extra spaces injected between prefix and text', () => {
    // Use text that starts with "x" so we can assert the exact separator boundary.
    const result = applySubAgentPrefix('x text', true);
    // The separator is ". " (period + exactly one space before the text).
    expect(result).toBe('Using a sub-agent. x text');
    expect(result).toMatch(/sub-agent\. x/);
  });
});
