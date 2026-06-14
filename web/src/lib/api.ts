// Token + URL helpers. The page is loaded as `?token=<t>`; every API call and
// the WS URL must carry it. Same-origin throughout.

export function getToken(): string | null {
  return new URLSearchParams(window.location.search).get('token');
}

/** Returns `&token=<t>` (already URL-encoded) or '' when no token present. */
export function authQuery(): string {
  const t = getToken();
  return t ? `&token=${encodeURIComponent(t)}` : '';
}

export function wsUrl(): string {
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${proto}//${loc.host}/`;
  const t = getToken();
  return t ? `${base}?token=${encodeURIComponent(t)}` : base;
}

export interface UploadResult {
  ok: true;
  path: string;
  name: string;
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
    const res = await fetch(`/api/version?${authQuery().slice(1)}`);
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
    const res = await fetch(`/api/update?${authQuery().slice(1)}`, {
      method: 'POST',
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean };
    return res.ok && !!j.ok;
  } catch {
    return true; // connection dropped == server is restarting
  }
}

export interface ControlConfig {
  launchCommand: string;
  defaultCwd: string;
}

/** Fetch the persisted launch config. */
export async function getConfig(): Promise<ControlConfig> {
  const res = await fetch(`/api/config?${authQuery().slice(1)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ControlConfig;
}

/** Persist a partial config update; returns the saved config (throws on 400). */
export async function saveConfig(
  partial: Partial<ControlConfig>,
): Promise<ControlConfig> {
  const res = await fetch(`/api/config?${authQuery().slice(1)}`, {
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
  const res = await fetch(`/api/session/new?${authQuery().slice(1)}`, {
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
  const res = await fetch(`/api/session/rename?${authQuery().slice(1)}`, {
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
 * Upload a single file as raw bytes (NOT multipart) to /api/upload.
 * Returns the absolute server path so it can be injected into the composer.
 */
export async function uploadFile(file: File): Promise<UploadResult> {
  const url = `/api/upload?name=${encodeURIComponent(file.name)}${authQuery()}`;
  const res = await fetch(url, { method: 'POST', body: file });
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
