/**
 * lib/pins.js — manual transcript pins.
 *
 * Escape hatch for sessions whose transcript can't be auto-matched (path drift,
 * window-name ≠ session-title, no live fd). A pin explicitly binds a pane to a
 * transcript file and takes top priority over the heuristic matcher.
 *
 * Pins are keyed by `windowId.paneIndex` (e.g. "@5.1") — STABLE across tmux
 * window renumbering, unlike the session:window.pane target which shifts.
 * Persisted as JSON: { "@5.1": { path: "/abs/…jsonl", ts: 1785… }, ... }.
 *
 * The `ts` is what lets a pin EXPIRE. A pin overrides the heuristic matcher,
 * but not ground truth: when the SessionStart hook later records a different
 * transcript for the same pane (that pane started a new session), the newer
 * hook record wins — see the pin block in lib/sessions.js. Legacy pins were
 * bare path strings; they read back as ts 0, so any hook record supersedes them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './json-file.js';

/** Stable pin key for a pane/session: windowId.paneIndex. */
export function pinKey(windowId, paneIndex) {
  return `${windowId}.${paneIndex ?? 0}`;
}

/** Transcript path of a pin entry (accepts the legacy bare-string form). */
export function pinPath(entry) {
  if (typeof entry === 'string') return entry || null;
  const p = entry?.path;
  return typeof p === 'string' && p ? p : null;
}

/** When the pin was set. Legacy string pins predate timestamps → 0. */
export function pinTs(entry) {
  return typeof entry?.ts === 'number' ? entry.ts : 0;
}

/** A fresh pin entry for `path`, stamped now. */
export function makePin(path, now = Date.now()) {
  return { path, ts: now };
}

/** Flatten a pins map to the `key -> path` shape the SPA consumes. */
export function pinPaths(pins) {
  const out = {};
  for (const [k, v] of Object.entries(pins || {})) {
    const p = pinPath(v);
    if (p) out[k] = p;
  }
  return out;
}

/** Load the pins map from disk. Never throws — returns {} on any problem. */
export function loadPins(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch {
    /* missing / malformed → empty */
  }
  return {};
}

/** Persist the pins map atomically (best-effort). */
export function savePins(file, pins) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(file, pins, { mode: 0o600 });
}

/**
 * Validate a candidate transcript path: must be a string ending in .jsonl,
 * exist as a regular file, and — after realpath canonicalization — resolve to
 * inside one of the allowed projects roots. Returns the (lexically-resolved)
 * path or null. Guards the pin + transcript-serving APIs against arbitrary
 * filesystem reads.
 *
 * SECURITY: the containment decision is made on the REALPATH (symlinks
 * resolved) of both the requested file and each root, using a path-SEGMENT
 * boundary check (path.relative, not string-prefix). This blocks: sibling
 * prefixes (/foo/barbaz vs /foo/bar), `..` traversal, and a symlink planted
 * inside a root that points at a file outside the allow-list.
 *
 * @param {string} raw
 * @param {string|string[]} roots  one root (back-compat) or an array of roots
 * @returns {string|null}
 */
export function validateTranscriptPath(raw, roots) {
  if (typeof raw !== 'string' || !raw.endsWith('.jsonl')) return null;
  const rootList = (Array.isArray(roots) ? roots : [roots]).filter(
    (r) => typeof r === 'string' && r.length > 0,
  );
  if (rootList.length === 0) return null;

  let full;
  try {
    full = path.resolve(raw);
  } catch {
    return null;
  }

  // Canonicalize the requested path: it must exist, be a regular file, and its
  // realpath must sit inside an allowed root. Deciding on the realpath (not the
  // lexical path) is what blocks a symlink inside a root pointing outside it.
  let realFull;
  try {
    if (!fs.statSync(full).isFile()) return null;
    realFull = fs.realpathSync(full);
  } catch {
    return null;
  }

  for (const root of rootList) {
    let realRoot;
    try {
      realRoot = fs.realpathSync(path.resolve(root));
    } catch {
      continue; // unresolvable root can't confine anything
    }
    if (isWithinRoot(realRoot, realFull)) return full;
  }
  return null;
}

/**
 * True when `target` is strictly inside `root` at a path-segment boundary.
 * Uses path.relative so `/foo/barbaz` is NOT considered inside `/foo/bar`.
 */
function isWithinRoot(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
