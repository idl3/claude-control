// lib/media-captures.js — D3: save Studio screenshot+annotation captures into
// the media root, servable back via the existing GET /api/media/<path> route
// (resolveMediaPath already supports arbitrary sub-paths under mediaRoot, the
// same way it already serves apps/<name>/<version>.html — nothing new needed
// there).
//
// Layout: captures/<name>/<ISO-stamp>.png — one flat directory per app name,
// files are timestamp-stamped (isoStamp from media-apps.js) so there is no
// overwrite risk short of two captures in the same second.
//
// Write is atomic (temp file + rename) so a concurrent GET /api/media read of
// a half-written file — or a crash mid-write — can never observe a truncated
// PNG: rename() is atomic on POSIX for same-filesystem destinations, which a
// temp file created in the SAME directory guarantees. None of the existing
// upload handlers (handleUpload, handleIconUpload) do this — they write
// directly — so this is a new pattern introduced for D3, not a copy of an
// existing precedent.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isValidAppName, isoStamp } from './media-apps.js';

export { isValidAppName };

export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

export function isOversizeCapture(byteLength) {
  return byteLength > MAX_CAPTURE_BYTES;
}

const DATA_URL_RE = /^data:image\/png;base64,([a-zA-Z0-9+/]+=*)$/;

/** Decodes a `data:image/png;base64,...` string into a Buffer, or null if it isn't one. */
export function decodeCaptureDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length === 0) return null;
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) return null;
  try {
    return Buffer.from(m[1], 'base64');
  } catch {
    return null;
  }
}

/** Atomically writes `buffer` under mediaRoot/captures/<name>/<isoStamp>.png; returns the relative path. */
export function writeCaptureAtomic(mediaRoot, name, buffer) {
  const dir = path.join(mediaRoot, 'captures', name);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${isoStamp()}.png`;
  const full = path.join(dir, filename);
  const tmp = path.join(dir, `.tmp-${crypto.randomBytes(8).toString('hex')}-${filename}`);
  try {
    fs.writeFileSync(tmp, buffer, { mode: 0o600 });
    fs.renameSync(tmp, full);
  } catch (err) {
    // Studio Phase D CP3 audit, FIX 2: writeFileSync or renameSync failed
    // mid-way (disk full, permission error, cross-device rename, etc.) —
    // never leave an orphaned .tmp-* file behind in captures/<name>/.
    // Best-effort: unlinkSync itself can fail too (e.g. writeFileSync never
    // got far enough to create the file at all) — swallow THAT failure, but
    // always rethrow the ORIGINAL error so the caller (handleSaveCapture's
    // try/catch → 500) still reports why the save actually failed.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* tmp file may not exist yet — nothing to clean up */
    }
    throw err;
  }
  return `captures/${name}/${filename}`;
}

/**
 * Retention sweep for `mediaRoot/captures/<name>/*.png` — mirrors
 * lib/uploads.js's sweepUploads (same TTL semantics, same per-file
 * stat+unlink, same defensive per-file try/catch swallowing concurrent-
 * delete races), but one directory level deeper: unlike uploads/ (a flat
 * directory), captures/ is one subdirectory per app name (see
 * writeCaptureAtomic's layout doc comment above), so sweepUploads' own
 * `fs.readdir(dir)` — it never recurses into subdirectories — would
 * silently sweep nothing if pointed at captures/ directly. This walks the
 * one extra level captures/ actually has instead of generalizing
 * sweepUploads into something recursive it was never designed to be.
 *
 * @param {string} mediaRoot  CONFIG.mediaDir — captures/ lives directly under it
 * @param {number} ttlMs      max age in milliseconds
 * @param {number} [now]      current epoch ms (injectable for tests)
 * @returns {Promise<{removed:number, kept:number}>}
 */
export async function sweepCaptures(mediaRoot, ttlMs, now = Date.now()) {
  const capturesDir = path.join(mediaRoot, 'captures');
  let appDirs;
  try {
    appDirs = await fs.promises.readdir(capturesDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { removed: 0, kept: 0 };
    throw err;
  }

  let removed = 0;
  let kept = 0;
  for (const appDir of appDirs) {
    if (!appDir.isDirectory()) continue;
    const dir = path.join(capturesDir, appDir.name);
    let files;
    try {
      files = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // ignore per-app races (e.g. concurrently removed)
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.png')) continue;
      const full = path.join(dir, f.name);
      try {
        const st = await fs.promises.stat(full);
        if (now - st.mtimeMs > ttlMs) {
          await fs.promises.unlink(full);
          removed += 1;
        } else {
          kept += 1;
        }
      } catch {
        // Ignore per-file races (e.g. concurrently deleted); count nothing.
      }
    }
  }
  return { removed, kept };
}
