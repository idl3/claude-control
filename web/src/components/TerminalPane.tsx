import { useMemo } from 'react';
import { TerminalView } from './TerminalView';
import { useTerminalRelay } from '../hooks/useTerminalRelay';

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

  return (
    <div className="thread-root terminal-pane-root">
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
