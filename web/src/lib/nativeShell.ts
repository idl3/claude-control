// Desktop-shell (Tauri WKWebView) integration. The shell identifies itself
// with a "ClaudeControlShell/<v>" userAgent token (set in the desktop app's
// tauri.conf.json) and exposes the Tauri API globally (withGlobalTauri).
// WKWebView has NO Web Push (no service-worker push, no Notification API), so
// inside the shell the Rust side owns notification delivery via
// UNUserNotificationCenter; its click handler deep-links back into the SPA by
// setting `location.hash = <sessionId>` — the exact route the PWA service
// worker uses (web/public/sw.js).
export const isNativeShell =
  typeof navigator !== 'undefined' &&
  navigator.userAgent.includes('ClaudeControlShell/');

type TauriGlobal = {
  core?: {
    invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
};

/** Fire-and-forget native notification (no-op outside the shell). */
export function notifySessionNative(
  sessionId: string,
  title: string,
  body: string,
): void {
  if (!isNativeShell) return;
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  void tauri?.core?.invoke?.('notify_session', { sessionId, title, body })?.catch(
    () => {
      /* older shell build without the command — in-app affordances still cover it */
    },
  );
}
