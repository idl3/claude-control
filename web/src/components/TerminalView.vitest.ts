// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { TerminalView } from './TerminalView';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// TerminalView polls the shell-capture op unconditionally WHILE MOUNTED — there
// is no `active` prop; visibility is controlled by the parent (Composer /
// TerminalPane) mounting/unmounting it, so "hidden" == "not mounted".
function renderTerminal() {
  const requestCapture = vi.fn(() => true);
  const clearOutput = vi.fn();
  const sendKey = vi.fn(() => true);
  const view = render(
    createElement(TerminalView, {
      output: null,
      requestCapture,
      clearOutput,
      sendKey,
      mods: { ctrl: false, alt: false },
      onToggleMod: vi.fn(),
    }),
  );
  return { ...view, requestCapture, clearOutput };
}

describe('TerminalView polling', () => {
  it('polls immediately on mount, then on the poll interval', () => {
    vi.useFakeTimers();
    const { requestCapture } = renderTerminal();

    expect(requestCapture).toHaveBeenCalledTimes(1); // immediate on mount
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(requestCapture).toHaveBeenCalledTimes(2); // one poll tick later
  });

  it('clears output and stops polling on unmount', () => {
    vi.useFakeTimers();
    const { requestCapture, clearOutput, unmount } = renderTerminal();

    expect(requestCapture).toHaveBeenCalledTimes(1);
    unmount();
    expect(clearOutput).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(2400);
    });
    expect(requestCapture).toHaveBeenCalledTimes(1); // no further polls after unmount
  });
});
