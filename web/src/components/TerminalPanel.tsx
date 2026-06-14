import { useEffect, useRef } from 'react';
import { terminalUrl } from '../lib/api';

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
  const closeRef = useRef<HTMLButtonElement>(null);

  // Esc closes; focus the close button on open for keyboard users.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
            ref={closeRef}
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
        className="term-frame"
        src={url}
        title={`Raw terminal for ${label}`}
      />
    </div>
  );
}
