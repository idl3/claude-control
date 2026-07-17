/**
 * Copy-to-clipboard for the embedded terminal (XtermHost). Two callers funnel
 * through `copyText`: the keyboard Cmd/Ctrl+C-with-selection branch in
 * `attachCustomKeyEventHandler`, and the mobile floating "Copy" button (no
 * physical Cmd key, so it's the only copy path touch users have).
 *
 * The cockpit is frequently reached over Tailscale at
 * `http://<tailnet-ip>:4317` — a NON-secure context (only `https://` and
 * `http://localhost` are secure). `navigator.clipboard` is undefined or
 * silently rejects there, so every write attempt falls back to the
 * `document.execCommand('copy')` hidden-textarea trick, which works in both
 * secure and non-secure contexts.
 */
export function copyText(text: string): void {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => copyViaExecCommand(text));
    return;
  }
  copyViaExecCommand(text);
}

function copyViaExecCommand(text: string): void {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  // Offscreen but real (execCommand('copy') needs an actual document
  // selection, so display:none/visibility:hidden alone won't do).
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  textarea.setAttribute('readonly', '');
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  try {
    document.execCommand('copy');
  } catch {
    /* best-effort — nothing else to fall back to on this browser */
  } finally {
    document.body.removeChild(textarea);
  }
}

/** The subset of `KeyboardEvent` the copy-shortcut predicate needs — kept
 * structural (rather than importing the DOM lib type) so it's trivially
 * constructible in tests without a jsdom KeyboardEvent. */
export interface CopyKeyEvent {
  type: string;
  metaKey: boolean;
  ctrlKey: boolean;
  key: string;
}

/**
 * True exactly when a keydown is a copy shortcut (Cmd+C / Ctrl+C) AND there's
 * an active terminal selection — the ONLY condition under which XtermHost's
 * `attachCustomKeyEventHandler` should swallow Cmd/Ctrl+C and copy instead of
 * forwarding it to the pty as `^C` (SIGINT). With no selection this returns
 * false, so Ctrl+C keeps interrupting the shell exactly as before.
 */
export function isCopyShortcut(e: CopyKeyEvent, hasSelection: boolean): boolean {
  return (
    e.type === 'keydown' &&
    (e.metaKey || e.ctrlKey) &&
    e.key.toLowerCase() === 'c' &&
    hasSelection
  );
}
