import { useEffect, useRef } from 'react';
import { terminalUrl } from '../lib/api';
import { initialFocusTarget, shouldCloseOnKey } from './terminalFocus';

interface TerminalPanelProps {
  /** Session id == tmux target (e.g. `name:0`). */
  sessionId: string;
  /** Display label for the panel header. */
  label: string;
  onClose: () => void;
}

/**
 * Full-screen overlay hosting the raw ttyd terminal for a session in an iframe.
 * Mobile-friendly (fills the viewport), keyboard-dismissable (Esc), with a
 * new-tab fallback for environments where the iframe is awkward (e.g. some
 * mobile keyboards). The iframe loads `/term/<id>?token=…`, served by
 * claude-control's token-gated reverse proxy in front of a loopback ttyd.
 */
export function TerminalPanel({ sessionId, label, onClose }: TerminalPanelProps) {
  const url = terminalUrl(sessionId);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // Esc closes. We deliberately do NOT focus the close button on open: if it
  // held focus, a stray Enter/Space (meant for the terminal) would activate it
  // and close the panel. Only Escape closes (see shouldCloseOnKey); Enter/Space
  // are left for the terminal. The close button stays Tab-reachable.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldCloseOnKey(e.key)) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Move focus into the terminal iframe (initialFocusTarget === 'frame'), never
  // the close button, so typing goes straight to ttyd. Focusing the <iframe>
  // element (same-origin proxy) hands keyboard input to the embedded document.
  // We focus on the iframe's load event and also eagerly on mount, in case the
  // frame is already loaded when the effect runs (cached / instant load).
  const focusFrame = () => {
    if (initialFocusTarget === 'frame') frameRef.current?.focus();
  };
  useEffect(() => {
    focusFrame();
  }, []);

  return (
    <div
      className="term-overlay"
      role="dialog"
      aria-modal="true"
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
      <iframe
        ref={frameRef}
        className="term-frame"
        src={url}
        title={`Raw terminal for ${label}`}
        onLoad={focusFrame}
      />
    </div>
  );
}
