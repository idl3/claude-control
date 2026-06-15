// Token + URL helpers. The page is loaded as `?token=<t>`; every API call and
// the WS URL must carry it. Same-origin throughout.

const TOKEN_KEY = 'cc_token';

/**
 * Active token. A token entered via the login screen (localStorage) wins over a
 * URL `?token=` — so a stale/wrong link can be overridden without editing the URL.
 */
export function getToken(): string | null {
  try {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored) return stored;
  } catch {
    /* localStorage blocked — fall back to URL */
  }
  return new URLSearchParams(window.location.search).get('token');
}

/** Persist a token entered at the login screen. */
export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* ignore */
  }
}

/**
 * Log out: drop the stored token AND strip `?token=` from the URL so a bad link
 * doesn't immediately re-authenticate on the next check.
 */
export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  try {
    const u = new URL(window.location.href);
    if (u.searchParams.has('token')) {
      u.searchParams.delete('token');
      window.history.replaceState(null, '', u.pathname + u.search);
    }
  } catch {
    /* ignore */
  }
}

/** Seed localStorage from a URL `?token=` on first load (share-link convenience). */
export function persistTokenFromUrl(): void {
  try {
    if (localStorage.getItem(TOKEN_KEY)) return;
    const fromUrl = new URLSearchParams(window.location.search).get('token');
    if (fromUrl) localStorage.setItem(TOKEN_KEY, fromUrl);
  } catch {
    /* ignore */
  }
}

/** Verify the current token against a token-gated endpoint. true = authorized. */
export async function checkAuth(): Promise<boolean> {
  try {
    const res = await fetch(`/api/health?${authQuery().slice(1)}`);
    return res.ok;
  } catch {
    return false;
  }
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

/**
 * URL to fetch a previously-uploaded file back (token-gated). The server only
 * serves paths inside its uploads dir; any other path 403s (and the <img> hides).
 */
export function fileUrl(absPath: string): string {
  return `/api/file?path=${encodeURIComponent(absPath)}${authQuery()}`;
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
  const res = await fetch(`/api/pins?${authQuery().slice(1)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { pins?: Record<string, string> }).pins ?? {};
}

/** Pin (or, with null, unpin) a session's transcript. Returns the updated map. */
export async function setPin(
  id: string,
  transcriptPath: string | null,
): Promise<Record<string, string>> {
  const res = await fetch(`/api/pins?${authQuery().slice(1)}`, {
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
  const res = await fetch(`/api/transcripts?${authQuery().slice(1)}`);
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

/** Fetch the server's VAPID public key (token-gated). Null on error. */
export async function getVapidPublicKey(): Promise<string | null> {
  try {
    const res = await fetch(`/api/push/vapid?${authQuery().slice(1)}`);
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
    const res = await fetch(`/api/push/subscribe?${authQuery().slice(1)}`, {
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
    const res = await fetch(`/api/push/unsubscribe?${authQuery().slice(1)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
    return res.ok;
  } catch {
    return false;
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
