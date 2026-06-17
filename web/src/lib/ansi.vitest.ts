import { describe, it, expect } from 'vitest';
import { parseAnsi, splitUrls } from './ansi';

describe('parseAnsi', () => {
  it('returns one plain segment for text with no codes', () => {
    const s = parseAnsi('hello world');
    expect(s).toHaveLength(1);
    expect(s[0].text).toBe('hello world');
    expect(s[0].fg).toBeUndefined();
  });

  it('applies foreground color then resets', () => {
    const s = parseAnsi('\x1b[31mred\x1b[0m plain');
    expect(s[0].text).toBe('red');
    expect(s[0].fg).toBeTruthy();
    expect(s[1].text).toBe(' plain');
    expect(s[1].fg).toBeUndefined();
  });

  it('handles bold + reset-intensity', () => {
    const s = parseAnsi('\x1b[1mB\x1b[22mN');
    expect(s[0].bold).toBe(true);
    expect(s[1].bold).toBe(false);
  });

  it('strips non-SGR escape sequences (e.g. erase-line)', () => {
    const s = parseAnsi('a\x1b[2Kb\x1b[0m');
    expect(s.map((x) => x.text).join('')).toBe('ab');
  });
});

describe('splitUrls', () => {
  it('splits a url out of surrounding text', () => {
    expect(splitUrls('see https://example.com/x now')).toEqual([
      { text: 'see ' },
      { text: 'https://example.com/x', href: 'https://example.com/x' },
      { text: ' now' },
    ]);
  });

  it('trims trailing punctuation off the link', () => {
    const p = splitUrls('go to https://npmjs.com/login.');
    expect(p.find((x) => x.href)?.href).toBe('https://npmjs.com/login');
    expect(p[p.length - 1].text).toBe('.');
  });

  it('returns plain text when there is no url', () => {
    expect(splitUrls('nothing here')).toEqual([{ text: 'nothing here' }]);
  });
});
