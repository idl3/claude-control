import { useEffect, useRef } from 'react';
import { terminalUrl } from '../lib/api';
import { initialFocusTarget, shouldCloseOnKey } from './terminalFocus';

interface TerminalPanelProps {
  /** Session id == tmux target (e.g. `name:0`). */
  sessionId: string;
  /** Display label for the panel header. */
  label: string;
  /** When false the panel is mounted but hidden (warm/preloaded). */
  visible: boolean;
  /** Send a raw tmux key to the selected session's pane (e.g. 'Up', 'Escape'). */
  sendKey: (key: string) => boolean;
  onClose: () => void;
}

// On-screen keys so a phone can drive the tmux TUI without a keyboard. Values
// are tmux key names (whitelisted server-side in lib/shell.js SHELL_KEYS).
const ACTION_KEYS: { key: string; glyph: string; title: string }[] = [
  { key: 'Escape', glyph: 'Esc', title: 'Escape' },
  { key: 'Left', glyph: '←', title: 'Left arrow' },
  { key: 'Up', glyph: '↑', title: 'Up arrow' },
  { key: 'Down', glyph: '↓', title: 'Down arrow' },
  { key: 'Right', glyph: '→', title: 'Right arrow' },
  { key: 'Enter', glyph: '⏎', title: 'Enter' },
];

/**
 * Full-screen overlay hosting the raw ttyd terminal for a session in an iframe.
 * Mobile-friendly (fills the viewport), keyboard-dismissable (Esc), with a
 * new-tab fallback for environments where the iframe is awkward (e.g. some
 * mobile keyboards). The iframe loads `/term/<id>?token=…`, served by
 * claude-control's token-gated reverse proxy in front of a loopback ttyd.
 */
export function TerminalPanel({ sessionId, label, visible, sendKey, onClose }: TerminalPanelProps) {
  const url = terminalUrl(sessionId);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // Live `visible` for handlers attached inside the iframe document.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // A warm/hidden panel must be COMPLETELY untargetable — its ttyd iframe can't
  // be focused or receive keystrokes when off-screen (the bug: Cmd+1-9 session
  // switches were landing focus in a background terminal). `inert` removes the
  // whole subtree from the tab order + focus + pointer/keyboard interaction.
  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    if (visible) el.removeAttribute('inert');
    else el.setAttribute('inert', '');
  }, [visible]);

  // Esc closes — only while visible (the panel stays mounted but hidden when
  // warm/preloaded, and a hidden panel must not swallow Escape).
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (shouldCloseOnKey(e.key)) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, visible]);

  // Move focus into the terminal iframe (never the close button) when the panel
  // becomes visible, so typing goes straight to ttyd. The iframe keeps its src
  // loaded while hidden, so this is instant on a warm panel.
  const focusFrame = () => {
    if (visible && initialFocusTarget === 'frame') frameRef.current?.focus();
  };
  // When hiding, pull focus OUT of the (now hidden) iframe back into the parent
  // document — otherwise focus stays trapped in the ttyd frame and window-level
  // hotkeys (⌘J to reopen, etc.) don't fire until the user clicks the page.
  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible) {
      focusFrame();
    } else if (wasVisible.current) {
      try {
        frameRef.current?.blur();
      } catch {
        /* ignore */
      }
      const el = document.querySelector<HTMLElement>('.detail-body') ?? document.body;
      el.setAttribute('tabindex', '-1');
      el.focus({ preventScroll: true });
    }
    wasVisible.current = visible;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // ⌘/Ctrl+J closes — but while the iframe has focus, tmux/xterm swallow the
  // keystroke, so the parent window never sees it. The ttyd surface is served
  // same-origin (via our /term proxy), so we can attach a capture-phase keydown
  // listener INSIDE the iframe document to catch the close shortcut there too.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // One stable handler so re-attaching across loads never stacks duplicates.
  const frameKeyHandler = useRef((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'j' || e.key === 'J')) {
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
    }
  });
  // ttyd/xterm auto-focuses its terminal on load + on reconnect. When the panel
  // is HIDDEN (warm/preloaded) that silently steals focus into the iframe —
  // popping the keyboard and eating hotkeys — and a parent focusin listener
  // can't see it (focus moving into an iframe's own document fires no event in
  // the parent). Since ttyd is same-origin, catch the focus INSIDE the iframe
  // and immediately blur it whenever the panel isn't visible. (We focus the
  // frame deliberately on reveal via focusFrame.)
  const frameFocusGuard = useRef(() => {
    if (visibleRef.current) return; // visible → legit focus, leave it
    const doc = frameRef.current?.contentDocument;
    (doc?.activeElement as HTMLElement | null)?.blur?.();
    // Land in the composer (ready to type) rather than parking on the body.
    const ci = document.querySelector<HTMLTextAreaElement>('.composer-input');
    if (ci) ci.focus({ preventScroll: true });
    else {
      const host = document.querySelector<HTMLElement>('.detail-body') ?? document.body;
      host.setAttribute('tabindex', '-1');
      host.focus({ preventScroll: true });
    }
  });
  const attachFrameKeys = () => {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    try {
      win.removeEventListener('keydown', frameKeyHandler.current, true);
      win.addEventListener('keydown', frameKeyHandler.current, true);
      win.removeEventListener('focusin', frameFocusGuard.current, true);
      win.addEventListener('focusin', frameFocusGuard.current, true);
    } catch {
      /* cross-origin or detached frame — ignore */
    }
  };
  const onFrameLoad = () => {
    focusFrame();
    attachFrameKeys();
    // ttyd auto-focuses the terminal on load — if we're warm/hidden, bounce that
    // focus straight back out (the guard no-ops when visible).
    frameFocusGuard.current();
  };
  useEffect(() => {
    attachFrameKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={overlayRef}
      className="term-overlay"
      data-visible={visible ? 'true' : 'false'}
      role="dialog"
      aria-modal={visible ? 'true' : 'false'}
      aria-hidden={visible ? undefined : 'true'}
      aria-label={`Raw terminal — ${label}`}
    >
      <header className="term-head">
        <span className="term-title">
          <span aria-hidden="true">⛶</span> {label}
        </span>
        <span className="term-actions">
          <a
            className="term-newtab"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in a new tab"
          >
            ↗ New tab
          </a>
          <button
            type="button"
            className="term-close"
            aria-label="Close terminal"
            onClick={onClose}
          >
            ✕
          </button>
        </span>
      </header>
      {/* Scroll wrapper: on narrow screens the iframe is forced wider/taller than
          the viewport (see .term-frame min-width/height) so this container can
          pan the oversized terminal instead of clipping it. Desktop is untouched
          (min-* sit below the viewport, so width/height:100% win). */}
      <div className="term-scroll">
        <iframe
          ref={frameRef}
          className="term-frame"
          src={url}
          title={`Raw terminal for ${label}`}
          onLoad={onFrameLoad}
        />
      </div>
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
            tabIndex={visible ? 0 : -1}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => sendKey(key)}
          >
            {glyph}
          </button>
        ))}
      </nav>
    </div>
  );
}
