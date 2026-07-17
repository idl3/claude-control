import type { Mods } from '../lib/terminalKeys';
import { XtermHost } from './XtermHost';
import { TerminalKeyBar } from './TerminalKeyBar';

interface TerminalViewProps {
  /** pty attach id — same value passed to XtermHost's `sessionId` prop. */
  ptySessionId: string;
  /** Send an allow-listed control key (Stop = C-c). */
  sendKey: (key: string) => boolean;
  /** Armed sticky modifiers (one-shot Ctrl/Opt), shown as pressed in the bar. */
  mods: Mods;
  /** Toggle a sticky modifier on/off. */
  onToggleMod: (m: keyof Mods) => void;
}

/**
 * Standalone terminal chrome — a header (terminal · cc-shell + Stop), the
 * embedded xterm.js pty (XtermHost), and the special-keys bar. Used by
 * `TerminalPane` for plain (non-Claude) tmux-pane sessions. The composer's own
 * terminal mode does NOT use this wrapper: it embeds XtermHost directly in the
 * composer card and hoists TerminalKeyBar into the composer action row (so the
 * composer window itself becomes the terminal).
 */
export function TerminalView({ ptySessionId, sendKey, mods, onToggleMod }: TerminalViewProps) {
  return (
    <div className="terminal-view">
      <div className="terminal-view-head">
        <span className="terminal-view-title">terminal · cc-shell</span>
        <button
          type="button"
          className="terminal-view-btn"
          onClick={() => sendKey('C-c')}
          title="Interrupt (Ctrl-C)"
        >
          Stop
        </button>
      </div>
      <XtermHost sessionId={ptySessionId} className="terminal-view-canvas" />
      <TerminalKeyBar sendKey={sendKey} mods={mods} onToggleMod={onToggleMod} />
    </div>
  );
}
