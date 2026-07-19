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
  window?: {
    getCurrentWindow?: () => {
      startDragging?: () => Promise<void>;
    };
  };
};

/**
 * Mousedown handler for shell drag surfaces (the HUD row): starts a native
 * window drag via the Tauri window API. Explicit and deterministic — we don't
 * rely on the init script's `data-tauri-drag-region` listener behaving on a
 * remote origin. Fires only on the surface itself (children keep their
 * clicks) and only for a primary-button press.
 */
export function shellDragStart(e: {
  target: unknown;
  currentTarget: unknown;
  buttons: number;
}): void {
  if (!isNativeShell) return;
  if (e.buttons !== 1 || e.target !== e.currentTarget) return;
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  void tauri?.window?.getCurrentWindow?.()?.startDragging?.()?.catch(() => {
    /* drag is best-effort — an old shell build simply doesn't drag */
  });
}

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
