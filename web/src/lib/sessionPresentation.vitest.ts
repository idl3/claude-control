import { describe, expect, it } from 'vitest';
import { isTerminalPresentation, isThreadPresentation } from './sessionPresentation';

describe('session presentation', () => {
  it('renders CodeWhale terminal mode as a terminal without erasing its harness kind', () => {
    const session = { kind: 'codewhale' as const, presentation: 'terminal' as const };
    expect(isTerminalPresentation(session)).toBe(true);
    expect(isThreadPresentation(session)).toBe(false);
  });

  it('allows a future CodeWhale Runtime row to use the thread presentation', () => {
    expect(isThreadPresentation({ kind: 'codewhale', presentation: 'thread' })).toBe(true);
  });

  it('keeps the legacy terminal-kind fallback for older servers', () => {
    expect(isTerminalPresentation({ kind: 'terminal' })).toBe(true);
    expect(isTerminalPresentation({ kind: 'claude' })).toBe(false);
  });
});
