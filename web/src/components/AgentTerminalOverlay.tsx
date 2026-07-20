import { useEffect, useRef, useState } from 'react';
import { useModalTransition } from '../lib/anim';
import type { Session } from '../lib/types';
import { XtermHost } from './XtermHost';
import { XIcon, TypeIcon, MousePointerIcon } from './icons';

interface AgentTerminalOverlayProps {
  session: Session;
  onClose: () => void;
}

/**
 * Cmd+J: full-screen raw pass-through to the SESSION'S LIVE AGENT tmux pane
 * (the pane Claude/codex itself runs in) — mirrors the real TUI so the
 * operator can see and answer prompts, steer, etc. This is a different
 * surface from the composer's `>_` cc-shell scratch terminal (a throwaway
 * shell for running commands), which keeps working unchanged alongside it.
 *
 * `sessionId={'agent:' + session.id}` is the only wire change this needs —
 * the server derives the fifo/pipe-pane mirror mode from that prefix
 * (server.js's resolveTarget), no protocol-version bump required.
 *
 * Close affordances are deliberately NOT "bare Escape", unlike most modals
 * in this app (see ProcessPanel.tsx): a raw steering surface that eats Esc
 * is broken, since Esc is essential inside the mirrored TUI (vim, tmux
 * copy-mode, cancelling a prompt). So — exactly like the composer's own
 * terminal mode — only Cmd+Esc/Ctrl+Esc (XtermHost's `onExit`, wired below)
 * or the visible X button (the mandatory close path on mobile, which has no
 * physical Cmd key) close this overlay. Bare Escape always reaches the pty.
 */
export function AgentTerminalOverlay({ session, onClose: rawClose }: AgentTerminalOverlayProps) {
  const { rootRef, requestClose: onClose } = useModalTransition(rawClose);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const title = session.name || session.id;
  // Select/copy mode: flips XtermHost out of pty-passthrough so a drag-select
  // (or the guaranteed "Select all") + Copy can grab text without every
  // keystroke racing off to the live agent. See XtermHost's `copyMode` prop.
  const [copyMode, setCopyMode] = useState(false);

  // useModalTransition's own mount effect (registered above, so it fires
  // first — React runs one component's effects in hook-call order) moves
  // focus to the panel's first focusable descendant: the close button,
  // which precedes the terminal in DOM order so Tab order matches the
  // visual header-then-terminal layout. XtermHost's `autoFocus` already
  // focused xterm's hidden textarea a moment earlier (its effect runs
  // first of all, as a child) — this effect runs last and hands focus back,
  // so a keystroke reaches the pane immediately on open with no extra click.
  // Skipped in copy mode: stealing focus back to the textarea there would
  // raise the soft keyboard right after XtermHost's own blur put it away.
  useEffect(() => {
    if (copyMode) return;
    canvasWrapRef.current?.querySelector('textarea')?.focus();
  }, [copyMode]);

  return (
    <div className="agent-term-backdrop" ref={rootRef}>
      <div className="agent-term-panel" role="dialog" aria-modal={true} aria-label={`Agent terminal — ${title}`}>
        <div className="modal-head">
          <span className="modal-title">Agent terminal — {title}</span>
          <button
            type="button"
            className="modal-copytoggle"
            aria-pressed={copyMode}
            data-active={copyMode ? 'true' : undefined}
            aria-label={copyMode ? 'Selection mode on — return to typing' : 'Enter selection / copy mode'}
            title={copyMode ? 'Typing mode' : 'Select / copy'}
            onClick={() => setCopyMode((v) => !v)}
          >
            {copyMode ? <TypeIcon size={16} /> : <MousePointerIcon size={16} />}
            <span className="modal-copytoggle-label">{copyMode ? 'Typing' : 'Select'}</span>
          </button>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            <XIcon size={16} />
          </button>
        </div>
        <div ref={canvasWrapRef} className="agent-term-canvas-wrap">
          <XtermHost
            key={session.id}
            sessionId={`agent:${session.id}`}
            className="agent-term-canvas"
            autoFocus
            onExit={onClose}
            paneScale
            copyMode={copyMode}
          />
        </div>
      </div>
    </div>
  );
}
