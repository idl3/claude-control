import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { parseGoalInvocation, splitUltrathink, remarkUltrathink } from './reservedTokens';

describe('parseGoalInvocation', () => {
  it('detects /goal with trailing arguments', () => {
    expect(parseGoalInvocation('/goal ship the login flow')).toEqual({
      token: '/goal',
      rest: ' ship the login flow',
    });
  });

  it('detects bare /goal with no arguments', () => {
    expect(parseGoalInvocation('/goal')).toEqual({ token: '/goal', rest: '' });
  });

  it('tolerates leading whitespace before the token', () => {
    expect(parseGoalInvocation('  /goal do the thing')).toEqual({
      token: '/goal',
      rest: ' do the thing',
    });
  });

  it('does not match a longer command name sharing the prefix', () => {
    expect(parseGoalInvocation('/goalx do the thing')).toBeNull();
    expect(parseGoalInvocation('/goal-plan do the thing')).toBeNull();
    expect(parseGoalInvocation('/goal:sub do the thing')).toBeNull();
  });

  it('does not match /goal mid-message', () => {
    expect(parseGoalInvocation('remember /goal later')).toBeNull();
  });

  it('does not match plain text', () => {
    expect(parseGoalInvocation('goal without a slash')).toBeNull();
  });
});

describe('splitUltrathink', () => {
  it('returns the whole string as one non-matching segment when absent', () => {
    expect(splitUltrathink('just a plain message')).toEqual([
      { text: 'just a plain message', ultrathink: false },
    ]);
  });

  it('flags a lowercase match', () => {
    expect(splitUltrathink('please ultrathink about this')).toEqual([
      { text: 'please ', ultrathink: false },
      { text: 'ultrathink', ultrathink: true },
      { text: ' about this', ultrathink: false },
    ]);
  });

  it('preserves original casing for uppercase and mixed-case matches', () => {
    expect(splitUltrathink('ULTRATHINK now')).toEqual([
      { text: 'ULTRATHINK', ultrathink: true },
      { text: ' now', ultrathink: false },
    ]);
    expect(splitUltrathink('UltraThink now')).toEqual([
      { text: 'UltraThink', ultrathink: true },
      { text: ' now', ultrathink: false },
    ]);
  });

  it('does not match the word inside another word (prefix or suffix)', () => {
    expect(splitUltrathink('ultrathinking about it')).toEqual([
      { text: 'ultrathinking about it', ultrathink: false },
    ]);
    expect(splitUltrathink('megaultrathink now')).toEqual([
      { text: 'megaultrathink now', ultrathink: false },
    ]);
  });

  it('flags every occurrence across multiple matches', () => {
    expect(splitUltrathink('ultrathink then ultrathink again')).toEqual([
      { text: 'ultrathink', ultrathink: true },
      { text: ' then ', ultrathink: false },
      { text: 'ultrathink', ultrathink: true },
      { text: ' again', ultrathink: false },
    ]);
  });

  it('segments concatenate back to the original text', () => {
    const text = 'a UltraThink b ultrathink c ultrathinking d';
    const rebuilt = splitUltrathink(text)
      .map((s) => s.text)
      .join('');
    expect(rebuilt).toBe(text);
  });
});

// Render markdown through the same plugin + component override MarkdownText
// uses for user-role text, mirroring embeds.vitest.ts's render() convention.
function render(md: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkUltrathink],
      components: { mark: (p: { children?: React.ReactNode }) =>
        createElement('mark', { className: 'ultrathink-text' }, p.children) },
      children: md,
    }),
  );
}

describe('remarkUltrathink (markdown pipeline)', () => {
  it('wraps the matched word in a <mark class="ultrathink-text"> element', () => {
    const html = render('please ultrathink about this');
    expect(html).toContain('<mark class="ultrathink-text">ultrathink</mark>');
    expect(html).toContain('please');
    expect(html).toContain('about this');
  });

  it('leaves text without the word untouched', () => {
    const html = render('nothing special here');
    expect(html).not.toContain('<mark');
    expect(html).toContain('nothing special here');
  });

  it('wraps multiple occurrences independently', () => {
    const html = render('ultrathink and ULTRATHINK both');
    expect(html).toContain('<mark class="ultrathink-text">ultrathink</mark>');
    expect(html).toContain('<mark class="ultrathink-text">ULTRATHINK</mark>');
  });
});
