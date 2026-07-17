import type { Mods } from '../lib/terminalKeys';
import { XtermHost } from './XtermHost';

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

// On-screen key bar: keys a phone keyboard can't physically produce, mapped to
// tmux send-keys tokens (must stay within the backend SHELL_KEYS allow-list).
// Sticky Ctrl/Opt (handled separately) cover arbitrary Ctrl-/Opt-<letter>; this
// row keeps the high-frequency one-tap keys. label → tmux key; gap === separator.
//
// This bar stays wired to `sendKey` (shell.key → shell-key op → tmux send-keys
// into the SAME cc-shell pane XtermHost's pty attaches to) rather than being
// converted to raw pty escape bytes: physical typing goes straight to the pty
// via xterm (instant, native echo); the key bar is a mobile tap-helper for keys
// a soft keyboard can't produce. Both paths feed the same pane tty — no conflict.
type KeyBarItem = { label: string; key: string; title: string } | 'gap';
const KEY_BAR: KeyBarItem[] = [
  { label: '↑', key: 'Up', title: 'Up' },
  { label: '↓', key: 'Down', title: 'Down' },
  { label: '←', key: 'Left', title: 'Left' },
  { label: '→', key: 'Right', title: 'Right' },
  'gap',
  { label: 'Tab', key: 'Tab', title: 'Tab' },
  { label: 'Esc', key: 'Escape', title: 'Escape' },
  'gap',
  { label: '^C', key: 'C-c', title: 'Interrupt (Ctrl-C)' },
  { label: '^D', key: 'C-d', title: 'EOF (Ctrl-D)' },
  { label: '^R', key: 'C-r', title: 'Reverse search (Ctrl-R)' },
  { label: '^Z', key: 'C-z', title: 'Suspend (Ctrl-Z)' },
  { label: '^L', key: 'C-l', title: 'Clear (Ctrl-L)' },
  'gap',
  { label: 'Home', key: 'Home', title: 'Home' },
  { label: 'End', key: 'End', title: 'End' },
  { label: 'PgUp', key: 'PPage', title: 'Page Up' },
  { label: 'PgDn', key: 'NPage', title: 'Page Down' },
];

/**
 * Live view of the server's dedicated shell pane, shown while the composer is in
 * terminal (>_) mode. Streams the pane's pty over WebSocket into an embedded
 * xterm.js instance (XtermHost) — real terminal emulation (native echo, cursor
 * addressing, TUI apps) in place of the old poll+<pre> capture render.
 * Includes a Stop button (sends C-c) for interrupting a running command.
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
      {/* Tappable special-keys row — the only way to reach arrows / Esc / Ctrl-*
          from a phone. Scrolls horizontally; keeps textarea focus so the iOS
          keyboard stays up. ponytail: discrete buttons, no sticky modifier —
          add a sticky Ctrl/Opt toggle if Ctrl+<any letter> is ever needed. */}
      <div className="terminal-key-bar" role="toolbar" aria-label="Terminal keys">
        {/* Sticky one-shot modifiers: tap Ctrl, then a letter, for Ctrl-<letter>
            "in succession" — the soft keyboard can't chord. */}
        <button
          type="button"
          className="terminal-key terminal-key-mod"
          aria-pressed={mods.ctrl}
          data-on={mods.ctrl ? 'true' : undefined}
          title="Sticky Ctrl — applies to the next key"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onToggleMod('ctrl')}
        >
          Ctrl
        </button>
        <button
          type="button"
          className="terminal-key terminal-key-mod"
          aria-pressed={mods.alt}
          data-on={mods.alt ? 'true' : undefined}
          title="Sticky Opt/Meta — applies to the next key"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onToggleMod('alt')}
        >
          Opt
        </button>
        <span className="terminal-key-gap" aria-hidden="true" />
        {KEY_BAR.map((item, i) =>
          item === 'gap' ? (
            <span key={`gap-${i}`} className="terminal-key-gap" aria-hidden="true" />
          ) : (
            <button
              key={item.key}
              type="button"
              className="terminal-key"
              title={item.title}
              aria-label={item.title}
              // Keep focus in the textarea so the mobile keyboard doesn't dismiss.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => sendKey(item.key)}
            >
              {item.label}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
