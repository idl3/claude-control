// lib/uploads.js — retention sweep for the attachment uploads directory.
// Deletes files older than ttlMs. Safe to call on a missing directory.

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Remove files in `dir` whose mtime is older than `ttlMs`.
 *
 * @param {string} dir
 * @param {number} ttlMs    max age in milliseconds
 * @param {number} [now]    current epoch ms (injectable for tests)
 * @returns {Promise<{removed:number, kept:number}>}
 */
export async function sweepUploads(dir, ttlMs, now = Date.now()) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { removed: 0, kept: 0 };
    throw err;
  }

  let removed = 0;
  let kept = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = path.join(dir, e.name);
    try {
      const st = await fs.stat(full);
      if (now - st.mtimeMs > ttlMs) {
        await fs.unlink(full);
        removed += 1;
      } else {
        kept += 1;
      }
    } catch {
      // Ignore per-file races (e.g. concurrently deleted); count nothing.
    }
  }
  return { removed, kept };
}

/**
 * Resolve a client-supplied file path, confining it to `uploadsDir`. Returns the
 * absolute path when it lives strictly inside uploadsDir, else null. Guards the
 * /api/file route against serving arbitrary filesystem paths (path traversal).
 *
 * @param {string} raw         client-supplied ?path= value
 * @param {string} uploadsDir  absolute uploads directory
 * @returns {string|null}
 */
export function resolveUploadPath(raw, uploadsDir) {
  if (!raw || typeof raw !== 'string') return null;
  let full;
  try {
    full = path.resolve(raw);
  } catch {
    return null;
  }
  return full.startsWith(uploadsDir + path.sep) ? full : null;
}
