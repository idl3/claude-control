import { useModalTransition } from '../lib/anim';
import { XtermHost } from './XtermHost';

interface TerminalPanelProps {
  /** Session id == tmux target (e.g. `name:0`). */
  sessionId: string;
  /** Display label for the panel header. */
  label: string;
  /** Send a raw tmux key to the selected session's pane (on-screen action row only). */
  sendKey: (key: string) => boolean;
  onClose: () => void;
}

// On-screen keys so a phone can drive the tmux TUI without a keyboard. Values
// are tmux key names (whitelisted server-side in lib/shell.js SHELL_KEYS).
// Unchanged from the pre-xterm.js panel: this row is orthogonal to the PTY
// migration — it already round-trips through the server's own tmux
// send-keys op (cockpit.sendPaneKey), independent of which surface renders
// the pane, so there was nothing here that needed rewiring.
const ACTION_KEYS: { key: string; glyph: string; title: string }[] = [
  { key: 'Escape', glyph: 'Esc', title: 'Escape' },
  { key: 'Left', glyph: '←', title: 'Left arrow' },
  { key: 'Up', glyph: '↑', title: 'Up arrow' },
  { key: 'Down', glyph: '↓', title: 'Down arrow' },
  { key: 'Right', glyph: '→', title: 'Right arrow' },
  { key: 'Enter', glyph: '⏎', title: 'Enter' },
];

/**
 * Full-screen overlay hosting an in-app `@xterm/xterm` terminal (via
 * `XtermHost`) for a session, fed by the A4 binary PTY WebSocket bridge — no
 * iframe, no ttyd. Mounted only while open (matching every other
 * `useModalTransition` consumer — CommandPalette, ConfigModal, …); the A4
 * bridge's own server-side idle-grace (~30s) + reuse-by-sessionId already
 * gives a fast reattach on reopen, so this doesn't need the old ttyd-era
 * multi-panel warm-mount cache (see A5 task report for the full reasoning).
 *
 * DOM shape follows the A1 design exactly: `.term-canvas` (inside
 * `XtermHost`, `tabIndex 0`) is the FIRST focusable descendant of `.term-panel`
 * in DOM order (so `useModalTransition` focuses it on open — never the close
 * button), with `.term-head`/`.term-keys` reordered visually back to their
 * usual top/bottom slots via CSS `order` (see styles.css).
 */
export function TerminalPanel({ sessionId, label, sendKey, onClose }: TerminalPanelProps) {
  const { rootRef, requestClose } = useModalTransition(onClose);

  return (
    <div
      ref={rootRef}
      className="term-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Raw terminal — ${label}`}
    >
      <div className="term-panel">
        <XtermHost
          sessionId={sessionId}
          className="term-panel-canvas"
          onEscapeElsewhere={requestClose}
        />
        <header className="term-head">
          <span className="term-title">
            <span aria-hidden="true">⛶</span> {label}
          </span>
          <span className="term-actions">
            <button
              type="button"
              className="term-close"
              aria-label="Close terminal"
              onClick={requestClose}
            >
              ✕
            </button>
          </span>
        </header>
        {/* On-screen keys — drive the tmux TUI on a phone with no keyboard.
            preventDefault on pointerdown keeps focus off the button so a mobile
            keyboard never pops up; keys route through the existing pane-key op. */}
        <nav className="term-keys" aria-label="Terminal keys">
          {ACTION_KEYS.map(({ key, glyph, title }) => (
            <button
              key={key}
              type="button"
              className="term-key"
              title={title}
              aria-label={title}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => sendKey(key)}
            >
              {glyph}
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}
