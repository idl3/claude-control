// Path-based deep links: /<session>/<window>/<pane>  ↔  id "<session>:<window>.<pane>".
//
// The tmux target is the session id (e.g. "0:1.2"). We expose it as a clean URL
// path so a session is shareable/bookmarkable and back/forward works — replacing
// the old hash, which the app ignored (every link loaded the same page). The
// `?token=` query is orthogonal and always preserved.

/** Parse a location pathname into a session id, or null if it isn't a session route. */
export function parsePath(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length !== 3) return null;
  const [session, window, pane] = parts.map(decodeURIComponent);
  if (!session) return null;
  if (!/^\d+$/.test(window) || !/^\d+$/.test(pane)) return null;
  return `${session}:${window}.${pane}`;
}

/**
 * Build the path (incl. current `?token=` query) for a session id.
 * Returns "/" for ids that don't match the session:window.pane shape.
 */
export function buildPath(id: string, search = ''): string {
  const m = /^(.+):(\d+)\.(\d+)$/.exec(id);
  const base = m
    ? `/${encodeURIComponent(m[1])}/${m[2]}/${m[3]}`
    : '/';
  return base + (search || '');
}
