import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { PtyClient, type PtyConnState } from '../lib/pty-client';
import { setTerminalPanelFocused, getTerminalPanelFocused } from './terminalFocus';
import { copyText, isCopyShortcut } from '../lib/terminalClipboard';

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
  /**
   * agent-kind sessions only (Cmd+J full-screen pane mirror): the real tmux
   * pane has a FIXED size the app deliberately never resizes (see
   * pty-bridge.js's resizeClient early-return, and pty-client.ts's
   * `onPaneSize` doc comment) — pinning the grid to whatever size the local
   * container happens to be (the normal FitAddon flow every other host
   * uses) would show the pane's 80-col-formatted content occupying only a
   * fraction of a much wider grid. Instead: pin the xterm grid to the
   * pane's exact cols/rows, then zoom the RENDERED text (fontSize) to fill
   * the container — the inverse of the normal "fit the grid to the
   * container" flow.
   */
  paneScale?: boolean;
  /**
   * Select/copy mode (agent-kind sessions only, toggled by
   * `AgentTerminalOverlay`'s header button): when true, keystrokes are NEVER
   * forwarded to the pty (see the `onData` gate below) so a drag-select or
   * "Select all" can grab text without racing input off to the live agent.
   * Also blurs xterm's hidden textarea (drops the mobile soft keyboard and
   * stops the cursor while selecting) and, on exit, clears the selection and
   * refocuses for typing.
   */
  copyMode?: boolean;
}

const TYPED_ERROR_FRAME =
  '\r\n\x1b[31m[session ended — this tmux target no longer exists]\x1b[0m\r\n';

// A11y/legibility: match the monospace stack already used everywhere else in
// this app's terminal-flavoured surfaces (terminal-view-body, term-key, …).
const TERMINAL_FONT_FAMILY = "ui-monospace, 'SF Mono', Menlo, monospace";

// pane-scale only: a safety floor for `applyPaneScale`'s convergence loop so
// a mid-layout/zero-sized measure (a rect read before the box has settled)
// can't converge to an unreadably small font. NOT a target to force up to —
// keep this conservative and tune it on-device (measured against a real iOS
// pane mirror, not a simulator default).
const MIN_PANE_FONT_PX = 9;

// pane-scale only: a safety ceiling for the same loop. Convergence is
// height-only (see applyPaneScale below) — a pane with few rows relative to
// the viewport's height (a short pane, or a tall phone viewport) would
// otherwise converge to an oversized font. 22 stays comfortably above the
// 14px construction default (room for genuinely short panes to look
// intentional, not just "big") without tipping into a cartoonish scale.
const MAX_PANE_FONT_PX = 22;

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
export function XtermHost({ sessionId, className, onEscapeElsewhere, onExit, autoFocus, paneScale, copyMode }: XtermHostProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [connState, setConnState] = useState<PtyConnState>('connecting');
  // Keep the latest onExit callable without re-running the attach effect (its
  // sole dep is sessionId — the custom key handler is installed once per attach).
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  // Live ref so the `onData` gate (installed once per attach, closure-captured
  // at mount) always reads the CURRENT copyMode rather than the value from
  // whenever the effect last ran — same pattern as onExitRef above.
  const copyModeRef = useRef(copyMode);
  copyModeRef.current = copyMode;
  // Live Terminal instance, reachable from the Copy button's click handler
  // (rendered outside the mount effect's closure). null while unmounted/torn
  // down between session attaches.
  const termRef = useRef<Terminal | null>(null);
  // Mobile copy affordance: xterm canvases have no native selection→copy, and
  // touch users have no physical Cmd key, so `term.onSelectionChange` drives a
  // floating button that's the ONLY copy path they have. null hides it;
  // 'Copy' / 'Copied ✓' otherwise.
  const [copyButtonLabel, setCopyButtonLabel] = useState<string | null>(null);
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      scrollback: 10000,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 14,
      allowProposedApi: true,
    });

    termRef.current = term;
    // E2E hook: expose the live Terminal instance on its mounted DOM node so a
    // Playwright test can drive `container.xtermInstance.selectAll()` /
    // inspect `.buffer` directly (verifying WebGL-rendered link/selection
    // behavior needs a real handle — there's no other way in from outside).
    // Never read by app code; purely additive, torn down on unmount below.
    (container as HTMLDivElement & { xtermInstance?: Terminal }).xtermInstance = term;

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

    // Clickable URLs. registerLinkProvider (what WebLinksAddon uses under the
    // hood) is a core Terminal API that does its own buffer-coordinate hit
    // testing independent of the active renderer — xterm's `.xterm-viewport`
    // element (not the canvas) captures the pointer events for hover/click, so
    // this works unmodified whether the WebGL or DOM renderer is active. Opens
    // in a new tab; `noopener,noreferrer` matches the security posture of every
    // other external-link open in this app.
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        window.open(uri, '_blank', 'noopener,noreferrer');
      }),
    );

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
      // Keyboard copy. Cmd/Ctrl+C is xterm's default forward-to-pty key (^C /
      // SIGINT) — that's still correct with NO selection (interrupting a
      // running command must keep working). But WITH an active selection,
      // Cmd/Ctrl+C means "copy", same as every other app: swallow it here and
      // copy instead of sending ^C.
      if (isCopyShortcut(e, term.hasSelection())) {
        copyText(term.getSelection());
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
    // pane-scale only: the last pane-size frame received. null until the
    // first one arrives (or forever, if the server's paneSize query failed —
    // graceful degrade to whatever size the Terminal was constructed with).
    let lastPaneSize: { cols: number; rows: number } | null = null;

    // pane-scale only: pin the grid to the pane's exact size, then converge
    // fontSize so the rendered `.xterm-screen` fills the container's HEIGHT
    // (rows letterbox top-aligned via the flex-start CSS on
    // .agent-term-canvas .term-canvas — there's no vertical slack to fill).
    // Width is deliberately NOT part of convergence: a wide pane (many
    // columns) is left to overflow horizontally at this same legible font
    // rather than being shrunk to fit — `.term-canvas-wrap.agent-term-canvas`
    // is a horizontal scroll container (styles.css) so every column stays
    // reachable by panning. A pane that already fits within the viewport's
    // width naturally gets no scrollbar; nothing here special-cases that —
    // it falls out of the browser's own overflow calculation. Font-size
    // scaling — not a CSS transform — is deliberate: xterm redraws each
    // glyph natively at the new size, so text stays crisp instead of being
    // raster-scaled.
    const applyPaneScale = (cols: number, rows: number) => {
      const el = containerRef.current;
      if (!el) return;
      if (term.cols !== cols || term.rows !== rows) {
        term.resize(cols, rows);
      }
      const screen = el.querySelector('.xterm-screen');
      if (!screen) return;
      // Glyph raster size scales ~linearly with fontSize, so one pass usually
      // lands within a pixel or two — a few more tighten it up. Capped so a
      // box that's still mid-layout (0-sized, or xterm's own resize hasn't
      // repainted yet) can't spin forever.
      let safeFontSize: number | null = null;
      for (let i = 0; i < 6; i += 1) {
        const rect = screen.getBoundingClientRect();
        const ch = el.clientHeight;
        if (rect.width < 1 || rect.height < 1 || el.clientWidth < 2 || ch < 2) return;
        // Cell height is quantized to whole device pixels, so for some row
        // counts no fontSize hits the target exactly and the ratio below
        // can oscillate between the nearest-under and nearest-over pixel
        // height instead of settling. `overflow-y: hidden` on this element
        // (styles.css) means an OVERshoot clips bottom rows with no way to
        // reach them, while an UNDERshoot just letterboxes (an already-
        // accepted outcome) — remember the last fontSize that fit and fall
        // back to it below if the loop can't settle cleanly.
        if (rect.height <= ch) safeFontSize = term.options.fontSize ?? safeFontSize;
        const ratio = ch / rect.height;
        if (Math.abs(ratio - 1) < 0.01) return;
        const current = term.options.fontSize ?? 12;
        const next = Math.min(MAX_PANE_FONT_PX, Math.max(MIN_PANE_FONT_PX, current * ratio));
        if (Math.abs(next - current) < 0.05) break;
        term.options.fontSize = next;
      }
      if (safeFontSize != null && screen.getBoundingClientRect().height > el.clientHeight) {
        term.options.fontSize = safeFontSize;
      }
    };

    const applyFit = () => {
      rafId = 0;
      const el = containerRef.current;
      if (!el || el.clientHeight < 2 || el.clientWidth < 2) return;
      if (paneScale) {
        if (lastPaneSize) applyPaneScale(lastPaneSize.cols, lastPaneSize.rows);
        return;
      }
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
        // (see pty-client.ts's `resize`/`write` queuing comment). Pane-scale
        // mode never reports a client-driven size back — the server never
        // resizes the real pane for agent-kind sessions (see resizeClient's
        // early-return in pty-bridge.js), so there is nothing useful to send.
        scheduleFit();
        if (!paneScale) client.resize(term.cols, term.rows);
      }
    });

    // pane-scale only: the server sends this BEFORE the capture-pane seed
    // frame (lib/pty-bridge.js's attach handler) specifically so the grid
    // can be resized synchronously here before that seed's text is written
    // into it — the resize() call above happens synchronously within this
    // handler, and WebSocket message events are delivered/handled strictly
    // in arrival order, so it always completes before the next message
    // (the seed) is processed. The fontSize convergence loop that follows is
    // best-effort within this same tick; `scheduleFit()`'s rAF pass corrects
    // it if the renderer hadn't repainted `.xterm-screen` yet.
    const offPaneSize = paneScale
      ? client.onPaneSize((cols, rows) => {
          lastPaneSize = { cols, rows };
          applyPaneScale(cols, rows);
          scheduleFit();
        })
      : () => {};

    const disposeOnData = term.onData((data) => {
      if (copyModeRef.current) return; // copy/select mode: never forward to the agent pty
      client.write(data);
    });

    // Mobile copy affordance: show/hide the floating Copy button as the
    // in-canvas drag-selection changes. Any new selection resets a stale
    // "Copied ✓" label back to "Copy".
    const disposeSelectionChange = term.onSelectionChange(() => {
      setCopyButtonLabel(term.hasSelection() ? 'Copy' : null);
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
      offPaneSize();
      disposeOnData.dispose();
      disposeSelectionChange.dispose();
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
      resizeObserver.disconnect();
      term.textarea?.removeEventListener('focus', onFocus);
      term.textarea?.removeEventListener('blur', onBlur);
      client.close();
      term.dispose();
      delete (container as HTMLDivElement & { xtermInstance?: Terminal }).xtermInstance;
      termRef.current = null;
      setCopyButtonLabel(null);
      setTerminalPanelFocused(false);
    };
    // sessionId is the sole trigger for a fresh mount — attach is per-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Copy button click: copy the current selection, flash "Copied ✓" for
  // ~1.2s, then revert — but only if the selection is still the one just
  // copied (an in-between onSelectionChange already hid/reset the button
  // otherwise, so this timer no-ops rather than fighting fresher state).
  const handleCopyButtonClick = () => {
    const term = termRef.current;
    if (!term || !term.hasSelection()) return;
    copyText(term.getSelection());
    setCopyButtonLabel('Copied ✓');
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = setTimeout(() => {
      setCopyButtonLabel((label) => (label === 'Copied ✓' ? 'Copy' : label));
    }, 1200);
  };

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

  // Select/copy mode transitions. Entering: blur xterm's hidden textarea so
  // the mobile soft keyboard drops and the cursor stops blinking mid-drag.
  // Exiting: clear whatever was selected and refocus for typing, so the very
  // next keystroke reaches the pty immediately.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (copyMode === undefined) return; // only the agent overlay opts into copy mode; never touch composer/inline focus
    if (copyMode) {
      term.textarea?.blur();
    } else {
      term.clearSelection();
      try { term.focus(); } catch { /* not ready */ }
    }
  }, [copyMode]);

  return (
    <div
      className={`term-canvas-wrap${className ? ` ${className}` : ''}`}
      data-copy-mode={copyMode ? 'true' : undefined}
    >
      {(connState === 'connecting' || connState === 'reconnecting') && (
        <span className={`term-conn-pill conn-dot conn-${connState}`} role="status">
          {connState === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
        </span>
      )}
      <div ref={containerRef} className="term-canvas" tabIndex={0} />
      {(copyMode || copyButtonLabel) && (
        <div className="term-copy-tools">
          {copyMode && (
            <button
              type="button"
              className="term-copy-btn"
              onClick={() => {
                const term = termRef.current;
                if (!term) return;
                term.selectAll();
                setCopyButtonLabel('Copy');
              }}
            >
              Select all
            </button>
          )}
          {copyButtonLabel && (
            <button
              type="button"
              className="term-copy-btn"
              data-copied={copyButtonLabel === 'Copied ✓' ? 'true' : undefined}
              onClick={handleCopyButtonClick}
            >
              {copyButtonLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
