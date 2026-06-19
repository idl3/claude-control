import { describe, it, expect } from 'vitest';
import { slashTokenAt, triggerTokenAt } from './slashToken';

describe('slashTokenAt', () => {
  // ── Basic detection ───────────────────────────────────────────────────────

  it('returns null when caret is at position 0 (nothing to the left)', () => {
    expect(slashTokenAt('', 0)).toBeNull();
    expect(slashTokenAt('/foo', 0)).toBeNull();
  });

  it('returns null when there is no slash before the caret', () => {
    expect(slashTokenAt('hello', 5)).toBeNull();
    expect(slashTokenAt('abc def', 7)).toBeNull();
  });

  it('detects a token at start of text (query is empty — just typed /)', () => {
    const result = slashTokenAt('/', 1);
    expect(result).toEqual({ query: '', start: 0, end: 1 });
  });

  it('detects a token at start of text with a partial name', () => {
    const result = slashTokenAt('/100x', 5);
    expect(result).toEqual({ query: '100x', start: 0, end: 5 });
  });

  it('detects a token with colons and dashes in the name', () => {
    const result = slashTokenAt('/100x:plan-hard', 15);
    expect(result).toEqual({ query: '100x:plan-hard', start: 0, end: 15 });
  });

  it('detects a token mid-text after a space', () => {
    const text = 'some prefix /foo';
    const caret = text.length; // 16
    const result = slashTokenAt(text, caret);
    // 'some prefix ' is 12 chars; '/' is at index 12
    expect(result).toEqual({ query: 'foo', start: 12, end: 16 });
  });

  it('detects an empty query token mid-text (user just typed /)', () => {
    const text = 'hello /';
    const result = slashTokenAt(text, 7);
    expect(result).toEqual({ query: '', start: 6, end: 7 });
  });

  it('detects caret mid-token (not at end)', () => {
    // caret after "100x" but before ":plan"
    const text = '/100x:plan';
    const result = slashTokenAt(text, 5); // caret at position 5 = after "100x"
    expect(result).toEqual({ query: '100x', start: 0, end: 5 });
  });

  // ── Non-triggering cases ──────────────────────────────────────────────────

  it('returns null for a path-like slash (not preceded by start or whitespace)', () => {
    // "src/foo" — the slash is preceded by a non-space char
    expect(slashTokenAt('src/foo', 7)).toBeNull();
    expect(slashTokenAt('a/b', 3)).toBeNull();
  });

  it('returns null when caret is before the slash token', () => {
    // text is "/foo" but caret is at 0
    expect(slashTokenAt('/foo', 0)).toBeNull();
  });

  it('returns null when there is text between the slash and caret that is not slash-name chars', () => {
    // " / foo" — space after slash breaks the token
    const text = ' / foo';
    // caret at end: the token before caret is "foo", preceded by space — no slash
    expect(slashTokenAt(text, 6)).toBeNull();
  });

  // ── Edge cases with underscores and numbers ────────────────────────────────

  it('accepts underscores in the token name', () => {
    const result = slashTokenAt('/plan_hard', 10);
    expect(result).toEqual({ query: 'plan_hard', start: 0, end: 10 });
  });

  it('accepts a token immediately following a newline (whitespace)', () => {
    const text = 'line one\n/cmd';
    const result = slashTokenAt(text, text.length);
    expect(result).toEqual({ query: 'cmd', start: 9, end: 13 });
  });

  it('accepts a token after a tab (whitespace)', () => {
    const text = 'some\t/skill';
    const result = slashTokenAt(text, text.length);
    expect(result).toEqual({ query: 'skill', start: 5, end: 11 });
  });

  it('returns null when caret is on the slash itself in a path', () => {
    expect(slashTokenAt('a/b', 2)).toBeNull(); // caret right after '/' in path — 'a' precedes '/'
  });

  // ── start and end offsets are correct for splice ──────────────────────────

  it('start and end allow correct splice: before + replacement + after', () => {
    const text = 'use /100x here';
    const caret = 9; // after "100x", at position 9
    const result = slashTokenAt(text, caret);
    expect(result).not.toBeNull();
    expect(result!.start).toBe(4); // index of '/'
    expect(result!.end).toBe(9);
    // Simulate splice: replace [start, end) with "/atl:plan-hard "
    const spliced = text.slice(0, result!.start) + '/atl:plan-hard ' + text.slice(result!.end);
    expect(spliced).toBe('use /atl:plan-hard  here');
  });
});

describe('triggerTokenAt', () => {
  it('slash token at start → trigger is /', () => {
    const result = triggerTokenAt('/foo', 4);
    expect(result).toEqual({ trigger: '/', query: 'foo', start: 0, end: 4 });
  });

  it('@arch token at caret 5 → trigger is @, query is arch', () => {
    const result = triggerTokenAt('@arch', 5);
    expect(result).toEqual({ trigger: '@', query: 'arch', start: 0, end: 5 });
  });

  it('@agent token mid-text after a space', () => {
    const text = 'help @planner here';
    const caret = 13; // after '@planner' = index 5..12, caret at 13
    const result = triggerTokenAt(text, caret);
    expect(result).toEqual({ trigger: '@', query: 'planner', start: 5, end: 13 });
  });

  it('@100x:100x-officer — colons and dashes in the name', () => {
    const text = '@100x:100x-officer';
    const result = triggerTokenAt(text, text.length);
    expect(result).toEqual({ trigger: '@', query: '100x:100x-officer', start: 0, end: text.length });
  });

  it('path a/b → null (slash preceded by non-space)', () => {
    expect(triggerTokenAt('a/b', 3)).toBeNull();
  });

  it('email foo@bar → null (@ preceded by non-space)', () => {
    expect(triggerTokenAt('foo@bar', 7)).toBeNull();
  });

  it('bare @ just typed (@, caret 1) → empty query', () => {
    const result = triggerTokenAt('@', 1);
    expect(result).toEqual({ trigger: '@', query: '', start: 0, end: 1 });
  });

  it('bare / just typed (/, caret 1) → empty slash query', () => {
    const result = triggerTokenAt('/', 1);
    expect(result).toEqual({ trigger: '/', query: '', start: 0, end: 1 });
  });

  it('returns null when caret is at position 0', () => {
    expect(triggerTokenAt('@foo', 0)).toBeNull();
    expect(triggerTokenAt('/foo', 0)).toBeNull();
  });
});
