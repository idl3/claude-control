import { describe, it, expect } from 'vitest';
import { findMatches } from './transcriptSearch';

describe('findMatches', () => {
  it('empty query → no matches', () => {
    expect(findMatches('hello world', '')).toEqual([]);
  });

  it('whitespace-only query → no matches', () => {
    expect(findMatches('hello world', '   ')).toEqual([]);
  });

  it('empty text → no matches', () => {
    expect(findMatches('', 'hello')).toEqual([]);
  });

  it('no match in text', () => {
    expect(findMatches('hello world', 'xyz')).toEqual([]);
  });

  it('single match', () => {
    expect(findMatches('hello world', 'world')).toEqual([{ start: 6, end: 11 }]);
  });

  it('multiple non-overlapping matches', () => {
    expect(findMatches('aababab', 'ab')).toEqual([
      { start: 1, end: 3 },
      { start: 3, end: 5 },
      { start: 5, end: 7 },
    ]);
  });

  it('case-insensitive matching', () => {
    expect(findMatches('Hello World HELLO', 'hello')).toEqual([
      { start: 0, end: 5 },
      { start: 12, end: 17 },
    ]);
  });

  it('match at the very start', () => {
    expect(findMatches('foo bar', 'foo')).toEqual([{ start: 0, end: 3 }]);
  });

  it('match at the very end', () => {
    expect(findMatches('foo bar', 'bar')).toEqual([{ start: 4, end: 7 }]);
  });

  it('query longer than text → no match', () => {
    expect(findMatches('hi', 'hello')).toEqual([]);
  });

  it('exact full-string match', () => {
    expect(findMatches('hello', 'hello')).toEqual([{ start: 0, end: 5 }]);
  });

  it('returns count via array length', () => {
    const matches = findMatches('the cat sat on the mat', 'the');
    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({ start: 0, end: 3 });
    expect(matches[1]).toEqual({ start: 15, end: 18 });
  });
});
