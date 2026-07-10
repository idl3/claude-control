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
  fs.writeFileSync(tmp, buffer, { mode: 0o600 });
  fs.renameSync(tmp, full);
  return `captures/${name}/${filename}`;
}
