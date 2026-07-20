// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AgentTerminalOverlay } from './AgentTerminalOverlay';
import type { Session } from '../lib/types';

// XtermHost owns the real @xterm/xterm Terminal + WS wiring — out of scope
// here (jsdom has no canvas/WebGL; the pty stream is covered by
// pty-client.vitest.ts / test/pty-bridge.test.js). Mock it to a thin marker
// that echoes the props this overlay is responsible for passing through,
// plus a click handler standing in for xterm's own Cmd+Esc escape hatch
// (`onExit`) so tests can trigger it without a real Terminal instance.
vi.mock('./XtermHost', () => ({
  XtermHost: (props: {
    sessionId: string;
    className?: string;
    autoFocus?: boolean;
    onExit?: () => void;
    copyMode?: boolean;
  }) =>
    createElement('div', {
      'data-testid': 'xterm-host',
      'data-session-id': props.sessionId,
      'data-auto-focus': props.autoFocus ? 'true' : 'false',
      'data-copy-mode': props.copyMode ? 'true' : 'false',
      className: props.className,
      onClick: () => props.onExit?.(),
    }),
}));

// Stub GSAP so useModalTransition's enter/exit timelines resolve
// synchronously — same stub as ConfigModal.vitest.ts / StudioModal.vitest.ts.
vi.mock('gsap', () => {
  const noop = () => {};
  const makeTimeline = (opts?: { onComplete?: () => void }) => {
    const self = { fromTo: () => self, to: () => self, kill: noop };
    opts?.onComplete?.();
    return self;
  };
  return { default: { set: noop, timeline: makeTimeline } };
});

afterEach(() => {
  cleanup();
});

const SESSION: Session = { id: 'win-3', name: 'atlas-core' };

function renderOverlay(session: Session = SESSION) {
  const onClose = vi.fn();
  render(createElement(AgentTerminalOverlay, { session, onClose }));
  return { onClose };
}

describe('AgentTerminalOverlay', () => {
  it('mounts XtermHost against the agent: prefixed session id, autofocused', () => {
    renderOverlay();
    const host = screen.getByTestId('xterm-host');
    expect(host.getAttribute('data-session-id')).toBe('agent:win-3');
    expect(host.getAttribute('data-auto-focus')).toBe('true');
    expect(host.className).toBe('agent-term-canvas');
  });

  it('is a labelled aria-modal dialog (so global hotkey guards recognise it)', () => {
    renderOverlay();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Agent terminal — atlas-core');
  });

  it('falls back to the session id for the title when name is absent', () => {
    renderOverlay({ id: 'win-9' });
    expect(screen.getByText('Agent terminal — win-9')).toBeTruthy();
  });

  it('closes via the X button', () => {
    const { onClose } = renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes via XtermHost onExit (Cmd+Esc/Ctrl+Esc escape hatch)', () => {
    const { onClose } = renderOverlay();
    fireEvent.click(screen.getByTestId('xterm-host')); // stands in for onExit()
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT close on bare Escape — the mirrored pane must receive it (vim/tmux/etc.)', () => {
    const { onClose } = renderOverlay();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('toggles select/copy mode via the header button, flipping XtermHost copyMode', () => {
    renderOverlay();
    const toggle = screen.getByRole('button', { name: 'Enter selection / copy mode' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('xterm-host').getAttribute('data-copy-mode')).toBe('false');

    fireEvent.click(toggle);
    const toggleActive = screen.getByRole('button', { name: 'Selection mode on — return to typing' });
    expect(toggleActive.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('xterm-host').getAttribute('data-copy-mode')).toBe('true');

    fireEvent.click(toggleActive);
    const toggleBack = screen.getByRole('button', { name: 'Enter selection / copy mode' });
    expect(toggleBack.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('xterm-host').getAttribute('data-copy-mode')).toBe('false');
  });
});
