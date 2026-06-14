/**
 * lib/version.js — release-update detection.
 *
 * Compares the running version (this package's package.json) against the latest
 * published on npm (`claude-control`), so the UI can surface an update banner.
 * The npm lookup is cached + best-effort (offline / npm-down keeps the last
 * known value and never throws).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_PATH = path.join(__dirname, '..', 'package.json');
const NPM_LATEST_URL = 'https://registry.npmjs.org/claude-control/latest';
const REFRESH_MS = 6 * 60 * 60 * 1000; // re-check npm at most every 6h

/** Running version from package.json (read fresh; cheap). */
export function currentVersion() {
  try {
    return JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Numeric semver compare (major.minor.patch; prerelease ignored).
 * @returns {number} >0 if a>b, <0 if a<b, 0 if equal.
 */
export function compareSemver(a, b) {
  const pa = String(a).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

let cache = { latest: null, checkedAt: 0 };

/** Latest published version on npm (cached, best-effort, never throws). */
export async function getLatestVersion({ force = false, now = Date.now() } = {}) {
  if (!force && cache.latest && now - cache.checkedAt < REFRESH_MS) {
    return cache.latest;
  }
  try {
    const res = await fetch(NPM_LATEST_URL, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const json = await res.json();
      if (json && typeof json.version === 'string') {
        cache = { latest: json.version, checkedAt: now };
      }
    }
  } catch {
    // offline / npm unreachable — keep last known (or null).
  }
  return cache.latest;
}

/** { current, latest, updateAvailable } for /api/version. Never throws. */
export async function getVersionInfo() {
  const current = currentVersion();
  const latest = await getLatestVersion();
  const updateAvailable = !!latest && compareSemver(latest, current) > 0;
  return { current, latest, updateAvailable };
}
