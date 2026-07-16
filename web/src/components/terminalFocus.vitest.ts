import { afterEach, describe, expect, it } from 'vitest';
import { getTerminalPanelFocused, setTerminalPanelFocused } from './terminalFocus';

// Regression guard for the A1 hotkey-routing rule: App.tsx's global handlers
// gate on this flag (`if (getTerminalPanelFocused() && !e.metaKey) return;`),
// so the getter/setter round-trip and default value are load-bearing.

afterEach(() => {
  setTerminalPanelFocused(false); // reset the module-level singleton between tests
});

describe('terminal panel focus flag', () => {
  it('defaults to false (not focused)', () => {
    expect(getTerminalPanelFocused()).toBe(false);
  });

  it('round-trips true/false via the setter', () => {
    setTerminalPanelFocused(true);
    expect(getTerminalPanelFocused()).toBe(true);
    setTerminalPanelFocused(false);
    expect(getTerminalPanelFocused()).toBe(false);
  });

  it('is a plain module-level singleton, not per-instance state', () => {
    setTerminalPanelFocused(true);
    // A second "reader" (simulating a different handler/module) sees the same value.
    expect(getTerminalPanelFocused()).toBe(true);
  });
});
