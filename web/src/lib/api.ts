// API helpers. The token is sent as an `Authorization: Bearer <token>` header
// (never in the URL — URLs leak via history/logs/referrer). The token lives in
// localStorage via lib/auth. Same-origin throughout.
//
// ttyd raw-terminal surface is the ONE exception: it is opened via window.open /
// an iframe to a separately-proxied URL that cannot send an Authorization
// header, so terminalUrl() keeps a `?token=` sourced from the stored token.

import { getToken, clearToken } from './auth';

// --- 401 handling -----------------------------------------------------------
// When any authenticated request comes back 401, the stored token is stale or
// wrong: clear it and notify listeners (App's TokenGate) to drop back to the
// login prompt. Centralized here so every fetch path triggers it uniformly.
type UnauthHandler = () => void;
const unauthHandlers = new Set<UnauthHandler>();

/** Subscribe to 401/unauthorized events. Returns an unsubscribe fn. */
export function onUnauthorized(fn: UnauthHandler): () => void {
  unauthHandlers.add(fn);
  return () => unauthHandlers.delete(fn);
}

/** Fire the unauthorized flow: clear the token and notify listeners. */
export function handleUnauthorized(): void {
  clearToken();
  for (const fn of unauthHandlers) fn();
}

/**
 * Build request headers carrying the bearer token (omitted when no token is
 * stored, i.e. tokenless server). Merge-friendly: pass extra headers to add.
 */
export function authHeaders(extra?: Record<string, string>): HeadersInit {
  const token = getToken();
  const headers: Record<string, string> = { ...(extra ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Authenticated fetch: injects the bearer header and routes 401s through the
 * unauthorized flow (clears token + returns to login). Returns the Response so
 * callers can branch on other statuses.
 */
export async function authFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(input, {
    ...init,
    headers: authHeaders(init?.headers as Record<string, string> | undefined),
  });
  if (res.status === 401) handleUnauthorized();
  return res;
}

/**
 * Build the token-gated URL for a session's raw-terminal (ttyd) surface. The id
 * is a tmux target (e.g. `name:0`) and is percent-encoded into a single path
 * segment to match the server's `/term/<encoded-id>` route + ttyd `-b` base.
 * ttyd cannot send an Authorization header, so this surface keeps a `?token=`
 * sourced from the stored token (the only place a URL token survives).
 */
export function terminalUrl(id: string): string {
  const base = `/term/${encodeURIComponent(id)}/`;
  const t = getToken();
  return t ? `${base}?token=${encodeURIComponent(t)}` : base;
}

export function wsUrl(): string {
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  // Clean URL — the token rides the WS subprotocol, not the query string.
  return `${proto}//${loc.host}/`;
}

export interface UploadResult {
  ok: true;
  path: string;
  name: string;
}

/**
 * Bare URL to fetch a previously-uploaded file back by absolute path. Pass this
 * to authFetch (Bearer header) — NOT to an <img src>, which can't authenticate;
 * callers fetch it and build an object URL (see ImagePart). The server confines
 * the path to its uploads dir; anything else 403s.
 */
export function fileUrl(absPath: string): string {
  return `/api/file?path=${encodeURIComponent(absPath)}`;
}

// ── Manual transcript pins ─────────────────────────────────────────

export interface TranscriptInfo {
  transcriptPath: string;
  title: string | null;
  sessionId: string | null;
  cwd: string | null;
  lastActivity: string | null;
}

/** Current pins map (pin key -> transcript path). */
export async function getPins(): Promise<Record<string, string>> {
  const res = await authFetch('/api/pins');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { pins?: Record<string, string> }).pins ?? {};
}

/** Pin (or, with null, unpin) a session's transcript. Returns the updated map. */
export async function setPin(
  id: string,
  transcriptPath: string | null,
): Promise<Record<string, string>> {
  const res = await authFetch('/api/pins', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, transcriptPath }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    pins?: Record<string, string>;
    error?: string;
  };
  if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json.pins ?? {};
}

/** Recent transcripts across all projects, for the pin picker. */
export async function listTranscripts(): Promise<TranscriptInfo[]> {
  const res = await authFetch('/api/transcripts');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { transcripts?: TranscriptInfo[] }).transcripts ?? [];
}

export interface VersionInfo {
  current: string;
  latest: string | null;
  behind?: number;
  updateAvailable: boolean;
}

/** Fetch running vs latest-on-npm version info (best-effort; null on error). */
export async function getVersion(): Promise<VersionInfo | null> {
  try {
    const res = await authFetch('/api/version');
    if (!res.ok) return null;
    return (await res.json()) as VersionInfo;
  } catch {
    return null;
  }
}

/**
 * Trigger the in-place self-update (POST /api/update). The server pulls,
 * rebuilds, and restarts itself, so the request often resolves right as the
 * server goes down — a network error here is NOT a failure. Returns true if
 * the update was accepted (or the connection dropped, which means it started).
 */
export async function triggerUpdate(): Promise<boolean> {
  try {
    const res = await authFetch('/api/update', { method: 'POST' });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean };
    return res.ok && !!j.ok;
  } catch {
    return true; // connection dropped == server is restarting
  }
}

/** Fetch the server's VAPID public key (token-gated). Null on error. */
export async function getVapidPublicKey(): Promise<string | null> {
  try {
    const res = await authFetch('/api/push/vapid');
    if (!res.ok) return null;
    const j = (await res.json()) as { publicKey?: string };
    return j.publicKey ?? null;
  } catch {
    return null;
  }
}

/** POST a PushSubscription JSON to the server (token-gated). */
export async function postPushSubscribe(sub: PushSubscriptionJSON): Promise<boolean> {
  try {
    const res = await authFetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sub),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Tell the server to drop a subscription by endpoint (token-gated). */
export async function postPushUnsubscribe(endpoint: string): Promise<boolean> {
  try {
    const res = await authFetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface ControlConfig {
  launchCommand: string;
  defaultCwd: string;
}

/** Fetch the persisted launch config. */
export async function getConfig(): Promise<ControlConfig> {
  const res = await authFetch('/api/config');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ControlConfig;
}

/** Persist a partial config update; returns the saved config (throws on 400). */
export async function saveConfig(
  partial: Partial<ControlConfig>,
): Promise<ControlConfig> {
  const res = await authFetch('/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(partial),
  });
  const json = (await res.json().catch(() => ({}))) as
    | ControlConfig
    | { error?: string };
  if (!res.ok) {
    throw new Error(('error' in json && json.error) || `HTTP ${res.status}`);
  }
  return json as ControlConfig;
}

export interface CreateSessionResult {
  ok: true;
  target: string;
  /** Resolved name (server-generated default when the request name was blank). */
  name: string;
}

/**
 * Create a new session: POST /api/session/new creates a NAMED tmux window and
 * types the configured launch command (with `--name <name>`) into it. The new
 * window shows up in the rail on the next ~4s registry refresh — no optimistic
 * insert needed. A blank `name` is fine: the server fills a `session-<ts>`
 * default and returns it.
 */
export async function createSession(opts?: {
  cwd?: string;
  name?: string;
}): Promise<CreateSessionResult> {
  const res = await authFetch('/api/session/new', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts ?? {}),
  });
  const json = (await res.json().catch(() => ({}))) as
    | CreateSessionResult
    | { error?: string };
  if (!res.ok || !('ok' in json) || !json.ok) {
    const err = ('error' in json && json.error) || `HTTP ${res.status}`;
    throw new Error(err);
  }
  return json;
}

/**
 * Rename an existing session: POST /api/session/rename renames its tmux window
 * (instant in the rail on the next ~4s refresh) AND types `/rename <name>` into
 * the pane so Claude updates its own session title. Throws on a non-OK response.
 */
export async function renameSession(id: string, name: string): Promise<void> {
  const res = await authFetch('/api/session/rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, name }),
  });
  const json = (await res.json().catch(() => ({}))) as
    | { ok: true }
    | { error?: string };
  if (!res.ok || !('ok' in json) || !json.ok) {
    const err = ('error' in json && json.error) || `HTTP ${res.status}`;
    throw new Error(err);
  }
}

/**
 * Build the token-gated URL for serving an uploaded file by basename.
 * Used by the transcript preview renderer to fetch thumbnails. Image GETs go
 * through a plain <img src>, which can't send an Authorization header — but the
 * /api/uploads route is same-origin and image previews are non-sensitive, so
 * when a token is set these are fetched via authFetch + object URLs instead
 * (see AttachmentPreview). The bare path is returned here for that fetch.
 */
export function uploadServeUrl(basename: string): string {
  return `/api/uploads/${encodeURIComponent(basename)}`;
}

/**
 * Upload a single file as raw bytes (NOT multipart) to /api/upload.
 * Returns the absolute server path so it can be injected into the composer.
 */
export async function uploadFile(file: File): Promise<UploadResult> {
  const url = `/api/upload?name=${encodeURIComponent(file.name)}`;
  const res = await authFetch(url, { method: 'POST', body: file });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* fall through to error below */
  }
  const obj = (json ?? {}) as Partial<UploadResult> & { error?: string };
  if (!res.ok || !obj.ok || !obj.path) {
    throw new Error(obj.error || `HTTP ${res.status}`);
  }
  return { ok: true, path: obj.path, name: obj.name ?? file.name };
}
