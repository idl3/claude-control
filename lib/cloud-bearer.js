// lib/cloud-bearer.js — Claudex auth source (claudex-integration Phase B, task B4).
//
// Claudex spawns the CLAUDE binary with ANTHROPIC_BASE_URL pointed at the olam
// auth-worker's path-bearer transport. The bearer artifact is
// ~/.olam/cloud-bearer.json, written by `olam auth login` with the shape
// { authHost, sub, secret } (validated by olam's own reader at
// packages/auth-client/src/backends/selector.ts). Absent/invalid → callers
// fail CLOSED with actionable guidance — the cockpit never stores secrets in
// its own config, and the composed URL is never typed into a pane or logged
// (it rides tmux -e; see design rows T3/T8).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function cloudBearerPath() {
  return path.join(os.homedir(), '.olam', 'cloud-bearer.json');
}

/**
 * Read + validate the cloud-bearer artifact.
 *
 * @param {{ _path?: string }} [opts] test seam
 * @returns {{ authHost: string, sub: string, secret: string, baseUrl: string } | null}
 *   baseUrl is `https://<authHost>/auth/<enc(sub)>/<enc(secret)>` — percent-
 *   encoding is REQUIRED (the worker decodes path segments); an authHost that
 *   already carries a scheme is preserved.
 */
export function readCloudBearer({ _path } = {}) {
  const p = _path || cloudBearerPath();
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const { authHost, sub, secret } = obj;
  if (typeof authHost !== 'string' || authHost.length === 0) return null;
  if (typeof sub !== 'string' || sub.length === 0) return null;
  if (typeof secret !== 'string' || secret.length === 0) return null;
  const origin = /^https?:\/\//.test(authHost)
    ? authHost.replace(/\/+$/, '')
    : `https://${authHost}`;
  return {
    authHost,
    sub,
    secret,
    baseUrl: `${origin}/auth/${encodeURIComponent(sub)}/${encodeURIComponent(secret)}`,
  };
}

/**
 * Fail-closed spawn preflight: ask the auth-worker which codex models it
 * serves (GET <base>/v1/models, Anthropic-shaped { data: [{ id, aliases }] })
 * and require the requested id to be among ids ∪ aliases. Any failure —
 * network, non-200, bad JSON, model missing — refuses the spawn; we NEVER
 * silently fall back to an Anthropic model (design T2).
 *
 * Reasons are user-facing 400 text: they must never contain the bearer URL.
 *
 * @param {string} baseUrl
 * @param {string} modelId
 * @param {{ _fetch?: typeof fetch }} [opts] test seam
 * @returns {Promise<{ ok: true, served: string[] } | { ok: false, reason: string, served?: string[] }>}
 */
export async function preflightClaudexModel(baseUrl, modelId, { _fetch } = {}) {
  const f = _fetch || fetch;
  let res;
  try {
    res = await f(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    return { ok: false, reason: `auth-worker unreachable (${err?.name === 'TimeoutError' ? 'timeout' : 'network error'})` };
  }
  if (!res.ok) {
    return { ok: false, reason: `auth-worker /v1/models returned ${res.status}` };
  }
  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, reason: 'auth-worker /v1/models returned non-JSON' };
  }
  const models = Array.isArray(data?.data) ? data.data : [];
  const served = new Set();
  for (const m of models) {
    if (m && typeof m.id === 'string') served.add(m.id);
    if (m && Array.isArray(m.aliases)) for (const a of m.aliases) if (typeof a === 'string') served.add(a);
  }
  if (served.has(modelId)) return { ok: true, served: [...served] };
  return { ok: false, reason: `model '${modelId}' is not served by the auth-worker`, served: [...served] };
}
