import type { Mods } from '../lib/terminalKeys';

interface TerminalKeyBarProps {
  /** Send an allow-listed control key (SHELL_KEYS) to the pty's pane. */
  sendKey: (key: string) => boolean;
  /** Armed sticky modifiers (one-shot Ctrl/Opt), shown as pressed. */
  mods: Mods;
  /** Toggle a sticky modifier on/off. */
  onToggleMod: (m: keyof Mods) => void;
  /** Extra class on the toolbar wrapper (layout hook for its two hosts). */
  className?: string;
}

// On-screen special-keys row: keys a phone keyboard can't physically produce,
// mapped to tmux send-keys tokens (must stay within the backend SHELL_KEYS
// allow-list). Sticky Ctrl/Opt (rendered separately) cover arbitrary
// Ctrl-/Opt-<letter>; this row keeps the high-frequency one-tap keys.
// label → tmux key; 'gap' === visual separator.
//
// Wired to `sendKey` (shell.key → shell-key op → tmux send-keys into the SAME
// cc-shell pane the xterm pty attaches to): physical typing goes straight to
// the pty via xterm (instant, native echo); this bar is a tap-helper for keys a
// soft keyboard can't produce. Both paths feed the same pane tty — no conflict.
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
 * The terminal special-keys bar (Ctrl · Opt · arrows · Tab · Esc · ^C..^L ·
 * Home/End/PgUp/PgDn). Shared by the standalone `TerminalPane` chrome and the
 * composer's terminal-mode action row, so both stay in lock-step. Keys route
 * through `sendKey`; sticky Ctrl/Opt let a soft keyboard chord Ctrl-<letter> in
 * succession (tap Ctrl, then a letter — handled by the consumer's key logic).
 */
export function TerminalKeyBar({ sendKey, mods, onToggleMod, className }: TerminalKeyBarProps) {
  return (
    <div className={`terminal-key-bar${className ? ` ${className}` : ''}`} role="toolbar" aria-label="Terminal keys">
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
            // Keep focus off the button (preventDefault) so the xterm keeps focus
            // and the mobile keyboard doesn't dismiss.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => sendKey(item.key)}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
