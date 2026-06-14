// Client-side token storage. The token is NEVER kept in the URL (URLs leak via
// history/logs/referrer). It lives in localStorage and is sent as an
// `Authorization: Bearer <token>` header on API calls and as a WebSocket
// subprotocol on the WS connection (see lib/api.ts, lib/ws.ts).
//
// Legacy migration: old bookmarks / phone URLs carry `?token=<t>`. On module
// load we lift any such token into localStorage and strip it from the URL via
// history.replaceState, so old links keep working but the visible URL goes
// clean immediately.

const STORAGE_KEY = 'claude-control.token';

let cached: string | null = null;
let loaded = false;

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // localStorage can throw in private-mode / sandboxed iframes.
    return null;
  }
}

/** The dedicated WS subprotocol label offered alongside the token. */
export const WS_PROTOCOL = 'claude-control';

/** Current token, or null when none is stored. */
export function getToken(): string | null {
  if (!loaded) {
    cached = readStored();
    loaded = true;
  }
  return cached;
}

/** Persist a token (e.g. from the login prompt). */
export function setToken(token: string): void {
  cached = token;
  loaded = true;
  try {
    window.localStorage.setItem(STORAGE_KEY, token);
  } catch {
    /* ignore storage failures — in-memory cache still works for this session */
  }
}

/** Clear the stored token (e.g. on a 401 / auth-close). */
export function clearToken(): void {
  cached = null;
  loaded = true;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Migrate a legacy `?token=<t>` from the URL into localStorage and strip it from
 * the visible URL. Runs once on module load. Safe to call in non-browser test
 * envs (guards on window/history presence).
 */
function migrateLegacyUrlToken(): void {
  if (typeof window === 'undefined' || !window.location) return;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return;
  }
  const legacy = params.get('token');
  if (!legacy) return;
  setToken(legacy);
  // Strip ?token= from the URL while preserving the rest of the query + hash.
  params.delete('token');
  const query = params.toString();
  const cleaned =
    window.location.pathname + (query ? `?${query}` : '') + window.location.hash;
  try {
    window.history.replaceState(null, '', cleaned);
  } catch {
    /* replaceState can fail in some sandboxes; the token is already stored */
  }
}

migrateLegacyUrlToken();
