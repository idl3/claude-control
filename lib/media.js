// lib/media.js — confine transcript media serving to the media root directory.
//
// Agent responses may reference screenshots/videos via <embedded-image|video
// url="…"/> blocks (rendered by the web app). Relative urls are served by
// GET /api/media/<path>, and that surface must only ever expose files under
// ONE directory (default ~/.claude-control/media). resolveMediaPath maps the
// client-supplied path to an absolute path strictly inside that root, or null
// for anything else — absolute paths, ".." traversal (raw or URL-encoded),
// symlink escapes, missing files. Callers turn null into a uniform 404.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve a URL-encoded relative path against `mediaRoot`.
 *
 * Returns the file's realpath when it lives strictly inside the root's
 * realpath, else null. Never throws; every failure mode is null so the HTTP
 * layer can answer with one detail-free 404.
 *
 * @param {string} raw        URL path after /api/media/ (still percent-encoded)
 * @param {string} mediaRoot  absolute media root directory
 * @returns {string|null}
 */
export function resolveMediaPath(raw, mediaRoot) {
  if (!raw || typeof raw !== 'string' || !mediaRoot) return null;
  let rel;
  try {
    rel = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (rel.includes('\0') || path.isAbsolute(rel)) return null;
  // Reject any ".." segment outright — belt for the realpath braces below.
  if (rel.split(/[/\\]/).some((seg) => seg === '..')) return null;

  let realRoot;
  try {
    realRoot = fs.realpathSync(mediaRoot);
  } catch {
    return null; // media root missing — nothing to serve
  }
  let real;
  try {
    real = fs.realpathSync(path.resolve(realRoot, rel));
  } catch {
    return null; // missing file — same null as a rejected path (no detail leak)
  }
  return real.startsWith(realRoot + path.sep) ? real : null;
}
