import { describe, it, expect } from 'vitest';
import { composerHighlightSegments } from './composerHighlight';

// Concatenating segment text always reconstructs the original value exactly.
function rebuild(value: string): string {
  return composerHighlightSegments(value)
    .map((s) => s.text)
    .join('');
}

describe('composerHighlightSegments', () => {
  it('returns a single text segment when nothing matches', () => {
    expect(composerHighlightSegments('just a plain message')).toEqual([
      { kind: 'text', text: 'just a plain message' },
    ]);
  });

  it('returns an empty array for an empty value', () => {
    expect(composerHighlightSegments('')).toEqual([]);
  });

  it('splits a /goal invocation with multiline arguments', () => {
    expect(composerHighlightSegments('/goal ship the login flow\nfix the bug too')).toEqual([
      { kind: 'goal', text: '/goal' },
      { kind: 'text', text: ' ship the login flow\nfix the bug too' },
    ]);
  });

  it('flags ultrathink at the start of the message', () => {
    expect(composerHighlightSegments('ultrathink about this')).toEqual([
      { kind: 'ultrathink', text: 'ultrathink' },
      { kind: 'text', text: ' about this' },
    ]);
  });

  it('flags ultrathink at the end of the message', () => {
    expect(composerHighlightSegments('please ultrathink')).toEqual([
      { kind: 'text', text: 'please ' },
      { kind: 'ultrathink', text: 'ultrathink' },
    ]);
  });

  it('combines a leading /goal token with an ultrathink match in the rest', () => {
    expect(composerHighlightSegments('/goal use ultrathink now')).toEqual([
      { kind: 'goal', text: '/goal' },
      { kind: 'text', text: ' use ' },
      { kind: 'ultrathink', text: 'ultrathink' },
      { kind: 'text', text: ' now' },
    ]);
  });

  it('preserves leading whitespace before /goal as its own text segment', () => {
    expect(composerHighlightSegments('  /goal do the thing')).toEqual([
      { kind: 'text', text: '  ' },
      { kind: 'goal', text: '/goal' },
      { kind: 'text', text: ' do the thing' },
    ]);
  });

  it('does not treat a longer command name sharing the /goal prefix as a match', () => {
    expect(composerHighlightSegments('/goalx do the thing')).toEqual([
      { kind: 'text', text: '/goalx do the thing' },
    ]);
  });

  it('detects /goal mid-message, not just at the start', () => {
    expect(composerHighlightSegments('deploy then /goal ship it now')).toEqual([
      { kind: 'text', text: 'deploy then ' },
      { kind: 'goal', text: '/goal' },
      { kind: 'text', text: ' ship it now' },
    ]);
  });

  it('detects every /goal occurrence when there are multiple', () => {
    expect(composerHighlightSegments('/goal one /goal two')).toEqual([
      { kind: 'goal', text: '/goal' },
      { kind: 'text', text: ' one ' },
      { kind: 'goal', text: '/goal' },
      { kind: 'text', text: ' two' },
    ]);
  });

  it('flags a /goal token directly adjacent to an ultrathink match', () => {
    expect(composerHighlightSegments('ultrathink /goal')).toEqual([
      { kind: 'ultrathink', text: 'ultrathink' },
      { kind: 'text', text: ' ' },
      { kind: 'goal', text: '/goal' },
    ]);
  });

  it('does not match a /goal-looking substring with no preceding whitespace or start (path-like)', () => {
    expect(composerHighlightSegments('remember foo/goal later')).toEqual([
      { kind: 'text', text: 'remember foo/goal later' },
    ]);
  });

  it('does not treat /goal-plan (a longer command sharing the prefix) as a match', () => {
    expect(composerHighlightSegments('/goal-plan do the thing')).toEqual([
      { kind: 'text', text: '/goal-plan do the thing' },
    ]);
  });

  it('handles a value ending in a newline, segments still rebuild exactly', () => {
    const value = '/goal fix the flaky test\n';
    expect(rebuild(value)).toBe(value);
    expect(composerHighlightSegments(value)).toEqual([
      { kind: 'goal', text: '/goal' },
      { kind: 'text', text: ' fix the flaky test\n' },
    ]);
  });

  it('rebuilds every case back to the original value', () => {
    const cases = [
      'just a plain message',
      '',
      '/goal ship the login flow\nfix the bug too',
      'ultrathink about this',
      'please ultrathink',
      '/goal use ultrathink now',
      '  /goal do the thing',
      '/goalx do the thing',
      'remember /goal later',
      '/goal fix the flaky test\n',
      'ultrathink then ultrathink again',
      'deploy then /goal ship it now',
      '/goal one /goal two',
      'ultrathink /goal',
      'remember foo/goal later',
      '/goal-plan do the thing',
    ];
    for (const value of cases) expect(rebuild(value)).toBe(value);
  });
});
