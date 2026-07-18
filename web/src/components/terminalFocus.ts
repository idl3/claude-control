/**
 * Pure focus-tracking helper for the embedded terminal (XtermHost), extracted
 * so it can be unit-tested without a DOM.
 */

/**
 * Tracks whether the embedded xterm canvas (XtermHost) currently has DOM
 * focus. Used by the Escape focus-target split (A1 §1): canvas focused ->
 * Escape reaches the PTY; any other focus target -> Escape closes the
 * composer's terminal mode. Module-level singleton (mirrors the file's
 * existing pure-helper style) since only one terminal is ever open at a time.
 */
let _termFocused = false;

export function getTerminalPanelFocused(): boolean {
  return _termFocused;
}

export function setTerminalPanelFocused(value: boolean): void {
  _termFocused = value;
}
