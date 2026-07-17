import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { PtyClient, type PtyConnState } from '../lib/pty-client';
import { setTerminalPanelFocused, getTerminalPanelFocused } from './terminalFocus';

export interface XtermHostProps {
  /** Session id == tmux target (e.g. `name:0`); a fresh mount per id re-attaches. */
  sessionId: string;
  /** Extra class on the outer wrapper (layout hook for the two thin hosts). */
  className?: string;
  /**
   * Escape pressed while the terminal panel has focus but NOT on the canvas
   * itself (header, close button, on-screen keys) — the A1 "focus-target
   * split" (docs/design/cockpit-protocol-split-native-heads.md §1): canvas
   * focused → Escape is NEVER intercepted here and always reaches the PTY
   * (vim insert mode, tmux copy-mode exit, shell line-cancel); any other
   * focus target inside the panel → this fires (wired to `requestClose()` by
   * the overlay host). Omit for surfaces with no close affordance (the
   * inline `TerminalPane` — Escape there always reaches the PTY, matching
   * the routing table's "canvas OR inline pane" wording).
   */
  onEscapeElsewhere?: () => void;
}

const TYPED_ERROR_FRAME =
  '\r\n\x1b[31m[session ended — this tmux target no longer exists]\x1b[0m\r\n';

// A11y/legibility: match the monospace stack already used everywhere else in
// this app's terminal-flavoured surfaces (terminal-view-body, term-key, …).
const TERMINAL_FONT_FAMILY = "ui-monospace, 'SF Mono', Menlo, monospace";

/**
 * Owns ONE `@xterm/xterm` `Terminal` instance + its `pty-client.ts` socket —
 * the single shared implementation `TerminalPanel.tsx` (overlay chrome) and
 * `TerminalPane.tsx` (inline chrome) both wrap, per the A1 design's "one
 * shared component" decision. Binary wiring: xterm's `onData` (user
 * keystrokes / paste) writes 0x00-framed bytes out via `pty-client.write()`;
 * `pty-client.onData` (server PTY output) writes straight into the terminal
 * via `term.write()`. No OSC-52 handler is registered anywhere in this file
 * — that omission IS the T6 "OSC-52 disabled by default" mitigation (a
 * decision to withhold code, not a config flag; see A1 §3).
 */
export function XtermHost({ sessionId, className, onEscapeElsewhere }: XtermHostProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [connState, setConnState] = useState<PtyConnState>('connecting');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      scrollback: 10000,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 13,
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    // Hardware-accelerated rendering (best-effort — falls back to xterm's
    // default canvas renderer if WebGL is unavailable, e.g. headless/older
    // browsers; never fatal to the terminal itself).
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* WebGL unsupported — canvas2D fallback xterm ships by default. */
    }

    fit.fit();

    const client = new PtyClient(sessionId);

    const offData = client.onData((bytes) => {
      term.write(bytes);
    });
    const offState = client.onState((state) => {
      setConnState(state);
      if (state === 'session-ended') {
        // The A4 "typed error frame" — literally written into the terminal's
        // own scrollback rather than a React overlay (A1 §4, state 3).
        term.write(TYPED_ERROR_FRAME);
      } else if (state === 'connected') {
        // Once attach is confirmed, tell the server our real size — sending
        // this any earlier races the server's async attach handshake (see
        // pty-client.ts's `resize`/`write` queuing comment).
        client.resize(term.cols, term.rows);
      }
    });

    const disposeOnData = term.onData((data) => {
      client.write(data);
    });

    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      client.resize(term.cols, term.rows);
    });
    resizeObserver.observe(container);

    const onFocus = () => setTerminalPanelFocused(true);
    const onBlur = () => setTerminalPanelFocused(false);
    term.textarea?.addEventListener('focus', onFocus);
    term.textarea?.addEventListener('blur', onBlur);

    client.connect();

    return () => {
      offData();
      offState();
      disposeOnData.dispose();
      resizeObserver.disconnect();
      term.textarea?.removeEventListener('focus', onFocus);
      term.textarea?.removeEventListener('blur', onBlur);
      client.close();
      term.dispose();
      setTerminalPanelFocused(false);
    };
    // sessionId is the sole trigger for a fresh mount — attach is per-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Escape focus-target split (A1 §1): only wired when the host wants a
  // close affordance (TerminalPanel). Canvas-focused Escape is left alone —
  // `getTerminalPanelFocused()` is exactly "is the canvas currently focused".
  useEffect(() => {
    if (!onEscapeElsewhere) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (getTerminalPanelFocused()) return; // canvas owns Escape -> PTY
      onEscapeElsewhere();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onEscapeElsewhere]);

  return (
    <div className={`term-canvas-wrap${className ? ` ${className}` : ''}`}>
      {(connState === 'connecting' || connState === 'reconnecting') && (
        <span className={`term-conn-pill conn-dot conn-${connState}`} role="status">
          {connState === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
        </span>
      )}
      <div ref={containerRef} className="term-canvas" tabIndex={0} />
    </div>
  );
}
