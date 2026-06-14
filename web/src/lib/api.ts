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
