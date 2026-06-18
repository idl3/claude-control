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
  onClose: () => void;
}

/**
 * Full-screen overlay hosting the raw ttyd terminal for a session in an iframe.
 * Mobile-friendly (fills the viewport), keyboard-dismissable (Esc), with a
 * new-tab fallback for environments where the iframe is awkward (e.g. some
 * mobile keyboards). The iframe loads `/term/<id>?token=…`, served by
 * claude-control's token-gated reverse proxy in front of a loopback ttyd.
 */
export function TerminalPanel({ sessionId, label, visible, onClose }: TerminalPanelProps) {
  const url = terminalUrl(sessionId);
  const frameRef = useRef<HTMLIFrameElement>(null);

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
  const attachFrameKeys = () => {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    try {
      win.removeEventListener('keydown', frameKeyHandler.current, true);
      win.addEventListener('keydown', frameKeyHandler.current, true);
    } catch {
      /* cross-origin or detached frame — ignore */
    }
  };
  const onFrameLoad = () => {
    focusFrame();
    attachFrameKeys();
  };
  useEffect(() => {
    attachFrameKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="term-overlay"
      data-visible={visible ? 'true' : 'false'}
      role="dialog"
      aria-modal="true"
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
      <iframe
        ref={frameRef}
        className="term-frame"
        src={url}
        title={`Raw terminal for ${label}`}
        onLoad={onFrameLoad}
      />
    </div>
  );
}
