/**
 * A5 (xterm.js migration): module-level flag for "does the terminal surface
 * (XtermHost's canvas — TerminalPanel's overlay OR TerminalPane's inline
 * view) currently have focus". Set by XtermHost's focus/blur handlers on its
 * xterm instance. Same module-level-singleton shape as
 * lib/hotkeySuppression.ts's getHotkeySuppressed/setHotkeySuppressed — no
 * React Context, so XtermHost can set/read it without a shared provider tree,
 * and App.tsx's hotkey handlers (function components with no relation to
 * XtermHost in the tree) can read it directly.
 *
 * Consumed two ways per the A1 design (docs/design/cockpit-protocol-split-
 * native-heads.md, "Terminal panel design (A1)" §1/§2):
 *  1. Hotkey routing: while the terminal has focus, App.tsx's global keydown
 *     handlers must treat a bare Ctrl-combo (no metaKey) as PTY-owned, never
 *     the app's — `if (getTerminalPanelFocused() && !e.metaKey) return;` is
 *     the one guard line added to each affected handler.
 *  2. Escape split: canvas focused → Escape passes straight to the PTY
 *     (`requestClose()` must NOT fire); any other focus target inside the
 *     panel (header, close button, on-screen keys) → Escape closes the panel.
 *
 * Replaces the old `initialFocusTarget`/`shouldCloseOnKey` pair, which was a
 * workaround for the ttyd iframe's cross-document focus boundary — xterm.js
 * renders same-document, so that boundary (and the workaround) no longer
 * exists; focus/tab-trap is now `useModalTransition`'s job (web/src/lib/anim.ts).
 */
let focused = false;

export function getTerminalPanelFocused(): boolean {
  return focused;
}

export function setTerminalPanelFocused(value: boolean): void {
  focused = value;
}
