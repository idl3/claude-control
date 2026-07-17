import { useEffect, useRef, useState } from 'react';
import { TerminalView } from './TerminalView';
import gsap, { prefersReducedMotion } from '../lib/anim';
import type { Mods } from '../lib/terminalKeys';

interface TerminalPaneProps {
  /** App session id (kind === 'terminal') — resolved server-side to the pane's
      tmux target and attached as a pty (`pane:<id>`). */
  sessionId: string;
  /** Send an allow-listed control key to the pane (on-screen key bar). */
  sendKey: (key: string) => boolean;
}

/**
 * A plain (non-Claude) tmux pane rendered as a fully interactive terminal. The
 * pane's pty is streamed over the `/pty` WebSocket into an embedded xterm.js
 * instance (via TerminalView → XtermHost) — real terminal emulation with native
 * echo, cursor addressing, Tab-complete, history and TUI apps. Replaces the old
 * poll(`capture-pane`)+relay(`send-keys`) model (and its local-echo/backspace
 * race): physical typing now goes straight to the pty, which is the echo.
 */
export function TerminalPane({ sessionId, sendKey }: TerminalPaneProps) {
  // On-screen sticky Ctrl/Opt state for the key bar (mobile helper). The
  // arm-then-physical-letter chord is a deferred mobile-polish item; the bar's
  // discrete ^C/^D/^R/^Z/^L keys cover the high-frequency control keys directly.
  const [sticky, setSticky] = useState<Mods>({ ctrl: false, alt: false });
  const toggleMod = (m: keyof Mods) => setSticky((s) => ({ ...s, [m]: !s[m] }));

  // Fade + zoom in when the pane mounts (selecting a terminal session).
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || prefersReducedMotion()) return;
    gsap.fromTo(
      el,
      { opacity: 0, scale: 0.97 },
      { opacity: 1, scale: 1, duration: 0.24, ease: 'power3.out', transformOrigin: 'center top' },
    );
  }, []);

  return (
    <div className="thread-root terminal-pane-root" ref={rootRef}>
      <TerminalView
        key={sessionId}
        ptySessionId={`pane:${sessionId}`}
        sendKey={sendKey}
        mods={sticky}
        onToggleMod={toggleMod}
      />
    </div>
  );
}
