import { describe, it, expect } from 'vitest';
import { relayDiff, controlToken, interceptToken, type Mods } from './terminalKeys';

const CTRL: Mods = { ctrl: true, alt: false };
const ALT: Mods = { ctrl: false, alt: true };
const NO: Mods = { ctrl: false, alt: false };

describe('relayDiff', () => {
  it('no change → nothing', () => {
    expect(relayDiff('ls', 'ls')).toEqual({ removed: 0, added: '' });
  });

  it('append one char', () => {
    expect(relayDiff('l', 'ls')).toEqual({ removed: 0, added: 's' });
  });

  it('append several (paste / fast type)', () => {
    expect(relayDiff('', 'git status')).toEqual({ removed: 0, added: 'git status' });
  });

  it('backspace at end', () => {
    expect(relayDiff('ls ', 'ls')).toEqual({ removed: 1, added: '' });
    expect(relayDiff('ls -la', 'ls')).toEqual({ removed: 4, added: '' });
  });

  it('autocorrect replacement → BSpace tail + new tail', () => {
    // "teh " → "the ": delete "eh", insert "he"
    expect(relayDiff('teh ', 'the ')).toEqual({ removed: 2, added: 'he' });
  });

  it('clear everything', () => {
    expect(relayDiff('echo hi', '')).toEqual({ removed: 7, added: '' });
  });
});

describe('controlToken', () => {
  it('builds C-/M- tokens for letters', () => {
    expect(controlToken(CTRL, 'a')).toBe('C-a');
    expect(controlToken(CTRL, 'R')).toBe('C-r');
    expect(controlToken(ALT, 'b')).toBe('M-b');
  });

  it('returns null for non-letters or no modifier', () => {
    expect(controlToken(CTRL, '1')).toBeNull();
    expect(controlToken(NO, 'a')).toBeNull();
  });
});

describe('interceptToken', () => {
  it('intercepts Enter, Tab/BTab, Escape', () => {
    expect(interceptToken('Enter')).toBe('Enter');
    expect(interceptToken('Tab')).toBe('Tab');
    expect(interceptToken('Tab', true)).toBe('BTab');
    expect(interceptToken('Escape')).toBe('Escape');
  });

  it('lets buffer-editing keys through (null)', () => {
    expect(interceptToken('a')).toBeNull();
    expect(interceptToken('Backspace')).toBeNull();
    expect(interceptToken('ArrowLeft')).toBeNull();
  });
});
