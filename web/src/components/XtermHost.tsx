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
  /**
   * Exit affordance for surfaces where xterm OWNS focus and would otherwise trap
   * every key (the composer's terminal mode). Wired to a keyboard escape hatch
   * via xterm's `attachCustomKeyEventHandler`: **Cmd+Esc** (primary) or
   * **Ctrl+Esc** (non-mac fallback) fires this and is NOT forwarded to the pty,
   * so the user can always leave terminal mode from the keyboard. Bare `Esc` is
   * left alone and reaches the shell (vim/readline/the key-bar Esc).
   */
  onExit?: () => void;
  /** Focus the terminal on mount (so the user can just start typing on open). */
  autoFocus?: boolean;
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
export function XtermHost({ sessionId, className, onEscapeElsewhere, onExit, autoFocus }: XtermHostProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [connState, setConnState] = useState<PtyConnState>('connecting');
  // Keep the latest onExit callable without re-running the attach effect (its
  // sole dep is sessionId — the custom key handler is installed once per attach).
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

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

    // Hardware-accelerated rendering — best-effort. WebGL contexts are flaky in
    // some browsers (notably Brave's fingerprint protection / GPU-process
    // recycling) and can be lost after init. On context loss, drop the addon so
    // xterm reverts to its default DOM renderer, then force a repaint — without
    // the refresh the fallback can leave a blank/black canvas.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        try { term.refresh(0, term.rows - 1); } catch { /* term may be disposing */ }
      });
      term.loadAddon(webgl);
    } catch {
      /* WebGL unsupported — xterm's default DOM renderer handles it. */
    }

    // Keyboard escape hatch. Once focused, xterm forwards keydown to the pty, so
    // a user in the composer's terminal mode has no keyboard way out. This
    // handler runs BEFORE xterm forwards the key: Cmd+Esc (primary) / Ctrl+Esc
    // (non-mac fallback) exits terminal mode and is NOT sent to the shell
    // (return false). Bare Esc — and every other key — returns true and flows to
    // the pty normally (vim/readline/the key-bar Esc keep working).
    term.attachCustomKeyEventHandler((e) => {
      if (
        e.type === 'keydown' &&
        (e.metaKey || e.ctrlKey) &&
        (e.key === 'Escape' || e.code === 'Escape')
      ) {
        onExitRef.current?.();
        return false;
      }
      return true;
    });

    // Focus on open so the user can start typing immediately (composer terminal
    // mode). Focuses xterm's hidden input; harmless for hosts that omit it.
    if (autoFocus) {
      try { term.focus(); } catch { /* not ready — ResizeObserver/attach will settle it */ }
    }

    const client = new PtyClient(sessionId);

    // Bounded, self-limiting fit. The host now lives in a container with a
    // DEFINITE height (CSS: `.terminal-view` fixed height + `.term-canvas`
    // position:absolute/inset:0), so `.term-canvas` can never be pushed taller
    // by its own content and `fit()` always reads a stable box. We ALSO guard
    // against a fit -> resize -> fit storm defensively: coalesce a burst of
    // ResizeObserver callbacks into ONE rAF-batched fit, skip entirely while the
    // box is zero-sized (kept-warm/hidden overlay mount — fitting a 0px box
    // yields garbage rows and strands output off-screen), and only push a resize
    // to the pty when cols/rows ACTUALLY change. This was the root cause of the
    // unbounded-growth black screen (xterm grew to 6000px+ in a height:auto box).
    let lastCols = 0;
    let lastRows = 0;
    let rafId = 0;
    const applyFit = () => {
      rafId = 0;
      const el = containerRef.current;
      if (!el || el.clientHeight < 2 || el.clientWidth < 2) return;
      try { fit.fit(); } catch { /* renderer not ready yet */ }
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        client.resize(term.cols, term.rows);
      }
    };
    const scheduleFit = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(applyFit);
    };

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
        // Once attach is confirmed, re-fit and tell the server our real size —
        // sending this any earlier races the server's async attach handshake
        // (see pty-client.ts's `resize`/`write` queuing comment).
        scheduleFit();
        client.resize(term.cols, term.rows);
      }
    });

    const disposeOnData = term.onData((data) => {
      client.write(data);
    });

    const resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(container);

    const onFocus = () => setTerminalPanelFocused(true);
    const onBlur = () => setTerminalPanelFocused(false);
    term.textarea?.addEventListener('focus', onFocus);
    term.textarea?.addEventListener('blur', onBlur);

    scheduleFit(); // initial fit, deferred one frame so layout has settled
    client.connect();

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
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
