import { describe, it, expect } from 'vitest';
import { initialFocusTarget, shouldCloseOnKey } from './terminalFocus';

// Regression guards for the "[✕] close button steals focus" bug: while the
// terminal iframe was open, the close button held focus, so an Enter/Space
// meant for the terminal activated it and closed the panel. The fix moves
// initial focus into the iframe and closes only on Escape.

describe('initialFocusTarget', () => {
  it('focuses the terminal iframe, never the close button', () => {
    // If this ever flips to 'close', stray Enter/Space would close the panel.
    expect(initialFocusTarget).toBe('frame');
  });
});

describe('shouldCloseOnKey', () => {
  it('closes on Escape', () => {
    expect(shouldCloseOnKey('Escape')).toBe(true);
  });

  it('does NOT close on Enter or Space — those go to the terminal', () => {
    expect(shouldCloseOnKey('Enter')).toBe(false);
    expect(shouldCloseOnKey(' ')).toBe(false);
    expect(shouldCloseOnKey('Spacebar')).toBe(false);
  });

  it('does NOT close on ordinary typing', () => {
    for (const key of ['a', 'Z', '1', 'Tab', 'ArrowUp', 'Backspace']) {
      expect(shouldCloseOnKey(key)).toBe(false);
    }
  });
});
