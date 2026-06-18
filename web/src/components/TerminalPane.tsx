import { useEffect, useMemo, useRef } from 'react';
import { TerminalView } from './TerminalView';
import { useTerminalRelay } from '../hooks/useTerminalRelay';
import gsap, { prefersReducedMotion } from '../lib/anim';

interface TerminalPaneProps {
  /** Selected pane id (tmux target) — re-arms capture on change. */
  sessionId: string;
  /** Latest ANSI capture of the pane (cockpit store). */
  capture: string | null;
  /** Poll the pane capture; `escapes` toggles ANSI passthrough. */
  requestCapture: (lines?: number, escapes?: boolean) => boolean;
  clearCapture: () => void;
  /** Relay a literal char / control key to the selected pane. */
  sendText: (text: string) => boolean;
  sendKey: (key: string) => boolean;
}

/**
 * A plain (non-Claude) tmux pane rendered as a fully interactive terminal: the
 * live ANSI view + key bar (TerminalView), plus a visible input the user types
 * into that relays keystrokes to THAT pane (Tab-complete, sticky Ctrl/Opt). The
 * pane is the echo. Replaces the read-only transcript fallback for terminals.
 */
export function TerminalPane({
  sessionId,
  capture,
  requestCapture,
  clearCapture,
  sendText,
  sendKey,
}: TerminalPaneProps) {
  // Bake ANSI escapes into capture requests so colours render in the view.
  const pollCapture = useMemo(
    () => (lines?: number) => requestCapture(lines, true),
    [requestCapture],
  );
  const ops = useMemo(
    () => ({ sendText: (s: string) => void sendText(s), sendKey: (k: string) => void sendKey(k) }),
    [sendText, sendKey],
  );
  const relay = useTerminalRelay(ops);

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
      <div className="thread-fade" aria-hidden="true" />
      <TerminalView
        key={sessionId}
        output={capture}
        requestCapture={pollCapture}
        clearOutput={clearCapture}
        sendKey={sendKey}
        mods={relay.sticky}
        onToggleMod={relay.toggleMod}
      />
      <div className="terminal-pane-input">
        <textarea
          className="composer-input"
          aria-label="Terminal input"
          placeholder="Keys go to the pane…"
          rows={1}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          value={relay.value}
          onChange={relay.onChange}
          onKeyDown={relay.onKeyDown}
        />
      </div>
    </div>
  );
}
