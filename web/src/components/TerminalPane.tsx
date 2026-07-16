import { useEffect, useRef } from 'react';
import { XtermHost } from './XtermHost';
import gsap, { prefersReducedMotion } from '../lib/anim';

interface TerminalPaneProps {
  /** Selected pane id (tmux target) — re-arms the PTY attach on change. */
  sessionId: string;
}

/**
 * A plain (non-Claude) tmux pane rendered as a fully interactive terminal via
 * the same `XtermHost` the overlay panel uses, fed by the live A4 PTY byte
 * stream (no more `shell-capture` polling / diffed-textarea relay). Replaces
 * the read-only transcript fallback for terminals.
 */
export function TerminalPane({ sessionId }: TerminalPaneProps) {
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
      <XtermHost key={sessionId} sessionId={sessionId} className="terminal-pane-canvas" />
    </div>
  );
}
