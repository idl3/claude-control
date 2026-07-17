// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TerminalView } from './TerminalView';

// XtermHost owns the real @xterm/xterm Terminal + WS wiring — out of scope for
// this component's tests (jsdom has no canvas/WebGL, and the pty stream is
// covered by pty-client.vitest.ts / test/pty-bridge.test.js). Mock it to a
// thin marker that echoes the props TerminalView is responsible for passing
// through, so this file can assert the "chrome" contract stays intact around
// whatever XtermHost renders.
vi.mock('./XtermHost', () => ({
  XtermHost: (props: { sessionId: string; className?: string }) =>
    createElement('div', {
      'data-testid': 'xterm-host',
      'data-session-id': props.sessionId,
      className: props.className,
    }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderTerminal(overrides: Partial<Parameters<typeof TerminalView>[0]> = {}) {
  const sendKey = vi.fn(() => true);
  const onToggleMod = vi.fn();
  const view = render(
    createElement(TerminalView, {
      ptySessionId: 'cc-shell:abc123',
      sendKey,
      mods: { ctrl: false, alt: false },
      onToggleMod,
      ...overrides,
    }),
  );
  return { ...view, sendKey, onToggleMod };
}

describe('TerminalView chrome', () => {
  it('mounts XtermHost with the pty session id and canvas class', () => {
    renderTerminal();
    const host = screen.getByTestId('xterm-host');
    expect(host.getAttribute('data-session-id')).toBe('cc-shell:abc123');
    expect(host.className).toBe('terminal-view-canvas');
  });

  it('re-mounts XtermHost with a fresh session id when ptySessionId changes', () => {
    const { rerender } = renderTerminal({ ptySessionId: 'cc-shell:first' });
    expect(screen.getByTestId('xterm-host').getAttribute('data-session-id')).toBe('cc-shell:first');
    rerender(
      createElement(TerminalView, {
        ptySessionId: 'cc-shell:second',
        sendKey: vi.fn(() => true),
        mods: { ctrl: false, alt: false },
        onToggleMod: vi.fn(),
      }),
    );
    expect(screen.getByTestId('xterm-host').getAttribute('data-session-id')).toBe('cc-shell:second');
  });

  it('keeps the header title, and Stop sends C-c', () => {
    const { sendKey } = renderTerminal();
    expect(screen.getByText('terminal · cc-shell')).toBeTruthy();
    // The Stop button and the ^C key-bar button share the 'Interrupt (Ctrl-C)'
    // title, so target Stop by its visible text.
    const stop = screen.getByRole('button', { name: 'Stop' });
    stop.click();
    expect(sendKey).toHaveBeenCalledWith('C-c');
  });

  it('renders the key bar and wires taps to sendKey', () => {
    const { sendKey } = renderTerminal();
    const up = screen.getByTitle('Up');
    up.click();
    expect(sendKey).toHaveBeenCalledWith('Up');
    const tab = screen.getByTitle('Tab');
    tab.click();
    expect(sendKey).toHaveBeenCalledWith('Tab');
  });

  it('wires the sticky Ctrl/Opt toggles', () => {
    const { onToggleMod } = renderTerminal();
    screen.getByTitle('Sticky Ctrl — applies to the next key').click();
    expect(onToggleMod).toHaveBeenCalledWith('ctrl');
    screen.getByTitle('Sticky Opt/Meta — applies to the next key').click();
    expect(onToggleMod).toHaveBeenCalledWith('alt');
  });

  it('reflects armed sticky modifiers via aria-pressed/data-on', () => {
    renderTerminal({ mods: { ctrl: true, alt: false } });
    const ctrlBtn = screen.getByTitle('Sticky Ctrl — applies to the next key');
    expect(ctrlBtn.getAttribute('aria-pressed')).toBe('true');
    expect(ctrlBtn.getAttribute('data-on')).toBe('true');
    const optBtn = screen.getByTitle('Sticky Opt/Meta — applies to the next key');
    expect(optBtn.getAttribute('aria-pressed')).toBe('false');
    expect(optBtn.getAttribute('data-on')).toBeNull();
  });
});
