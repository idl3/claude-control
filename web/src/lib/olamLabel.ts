import type { Session } from './types';

/**
 * Prettify a raw remote-session id `olam:<org>:<uuid>` to `<org> · <first-8>`.
 * Falls back to the raw id unchanged when it doesn't match the expected
 * `olam:org:uuid` shape (defensive — never throws on an unexpected id).
 */
export function prettifyRemoteId(id: string): string {
  const m = id.match(/^olam:([^:]+):(.+)$/);
  if (!m) return id;
  const [, org, rest] = m;
  return `${org} · ${rest.slice(0, 8)}`;
}

/**
 * Best display label for the detail header. Prefers an explicit name/title,
 * then falls back to a prettified id for remote sessions (never the raw
 * `olam:org:uuid`), then the raw id for local sessions.
 */
export function sessionDisplayLabel(session: Session | null | undefined, fallbackId: string | null): string {
  if (session?.name) return session.name;
  if (session?.title) return session.title;
  if (session?.kind === 'remote' && session.id) return prettifyRemoteId(session.id);
  return fallbackId || 'claude control';
}
