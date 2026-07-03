// Best-effort frontend crash reporter → POSTs to the server's client-error sink
// (/api/client-error) so every crash is logged + traceable server-side. Uses a
// plain fetch with the bearer header (NOT authFetch) so a logging call can never
// trigger the unauthorized/logout flow, and never throws — logging must not crash
// the crash handler.
import { authHeaders } from './api';

export interface ClientErrorReport {
  /** Where it came from: 'react-boundary' | 'window.onerror' | 'unhandledrejection'. */
  source: string;
  message: string;
  stack?: string;
  componentStack?: string;
  /** The session being viewed, when known (helps trace which transcript crashed). */
  sessionId?: string;
  /** ErrorBoundary label, when applicable. */
  label?: string;
}

export function reportClientError(report: ClientErrorReport): void {
  try {
    void fetch('/api/client-error', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        ...report,
        url: typeof location !== 'undefined' ? location.href : '',
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      }),
      keepalive: true, // still sends if the crash is followed by a navigation/reload
    }).catch(() => {});
  } catch {
    /* never let reporting throw */
  }
}
