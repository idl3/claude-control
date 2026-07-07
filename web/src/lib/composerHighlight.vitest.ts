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

  it('does not match /goal mid-message', () => {
    expect(composerHighlightSegments('remember /goal later')).toEqual([
      { kind: 'text', text: 'remember /goal later' },
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
    ];
    for (const value of cases) expect(rebuild(value)).toBe(value);
  });
});
