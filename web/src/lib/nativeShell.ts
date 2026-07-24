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

// Link-open failures in-shell were SILENT (invoke rejects → window.open
// fallback → WKWebView no-op → nothing happens, nothing logged). Ship every
// shell link-open failure to the server's client-error sink so "links are
// dead" is diagnosable from ~/.claude-control/logs/client-errors.jsonl
// instead of a screen-share.
function reportShellOpenFailure(stage: string, url: string, err: unknown): void {
  void import('./reportError').then(({ reportClientError }) => {
    reportClientError({
      source: 'nativeShell.openExternal',
      message: `${stage} failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
    });
  });
}

/**
 * Open an external http(s) URL. Outside the shell this is a plain
 * `window.open` new tab. In-shell it opens the operator's REAL system
 * browser via the shell's `open_system_browser` command (macOS `open`) —
 * `window.open`/`target="_blank"` are silent no-ops there (WKWebView has no
 * UI-delegate). Fallback chain for older shell builds: `open_url_window`
 * (the native in-app browser window), then `window.open`, reporting each
 * in-shell failure to the client-error sink.
 */
export function openExternal(url: string): void {
  const fallback = () => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };
  if (!isNativeShell) {
    fallback();
    return;
  }
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  const invoke = tauri?.core?.invoke;
  if (!invoke) {
    reportShellOpenFailure('no __TAURI__ global', url, 'init script missing');
    fallback();
    return;
  }
  void invoke('open_system_browser', { url }).catch((err) => {
    reportShellOpenFailure('open_system_browser', url, err);
    return invoke('open_url_window', { url }).catch((err2: unknown) => {
      reportShellOpenFailure('open_url_window', url, err2);
      fallback();
    });
  });
}

/**
 * Open a URL in the shell's native in-app "browser" child window — a
 * top-level browsing context immune to X-Frame-Options / CSP
 * frame-ancestors, unlike any iframe (the reason the transcript's inline
 * URL preview uses this in-shell instead of its iframe overlay). Outside
 * the shell (or on invoke failure) falls back to openExternal's chain.
 */
export function openInAppWindow(url: string): void {
  if (!isNativeShell) {
    openExternal(url);
    return;
  }
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  const invoked = tauri?.core?.invoke?.('open_url_window', { url });
  if (!invoked) {
    reportShellOpenFailure('no __TAURI__ global (in-app window)', url, 'init script missing');
    return;
  }
  void invoked.catch((err) => {
    reportShellOpenFailure('open_url_window (inline)', url, err);
    openExternal(url);
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

// ── Native file-drop bridge ─────────────────────────────────────────────────
// In-shell, OS file drags never reach the DOM: wry's native layer owns the
// drag session (dragDropEnabled: true — its reliable mode; the false path is
// broken on macOS regardless, verified on stamped builds). The Rust side
// forwards wry's enter/over/drop/leave as 'cc:native-drag' CustomEvents with
// CSS-pixel coordinates + dropped file paths; consumers hit-test their own
// rects and reuse their existing attach pipelines via readDroppedFile.

export interface NativeDragDetail {
  kind: 'enter' | 'over' | 'drop' | 'leave';
  x: number;
  y: number;
  paths: string[];
}

/** Subscribe to shell-forwarded native drag events. No-op unsubscriber
 *  outside the shell. */
export function onNativeDrag(
  handler: (d: NativeDragDetail) => void,
): () => void {
  if (!isNativeShell) return () => {};
  const listener = (e: Event) => {
    const d = (e as CustomEvent).detail as NativeDragDetail | undefined;
    if (d && typeof d.kind === 'string') handler(d);
  };
  window.addEventListener('cc:native-drag', listener);
  return () => window.removeEventListener('cc:native-drag', listener);
}

// acceptsFile matches extensions too, but a real MIME keeps image previews +
// server-side typing working for the common cases.
const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
};

/**
 * Materialize a shell-dropped file path into a web File via the shell's
 * read_dropped_file command (which only serves paths from an actual recent
 * native drop — it is not a general file-read hole). Null on any failure.
 */
export async function readDroppedFile(path: string): Promise<File | null> {
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  const invoke = tauri?.core?.invoke;
  if (!invoke) return null;
  try {
    const res = (await invoke('read_dropped_file', { path })) as {
      name: string;
      b64: string;
    };
    const bin = atob(res.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const ext = res.name.split('.').pop()?.toLowerCase() ?? '';
    return new File([bytes], res.name, {
      type: EXT_MIME[ext] ?? 'application/octet-stream',
    });
  } catch {
    return null;
  }
}
