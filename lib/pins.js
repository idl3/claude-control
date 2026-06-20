/**
 * lib/pins.js — manual transcript pins.
 *
 * Escape hatch for sessions whose transcript can't be auto-matched (path drift,
 * window-name ≠ session-title, no live fd). A pin explicitly binds a pane to a
 * transcript file and takes top priority over the heuristic matcher.
 *
 * Pins are keyed by `windowId.paneIndex` (e.g. "@5.1") — STABLE across tmux
 * window renumbering, unlike the session:window.pane target which shifts.
 * Persisted as JSON: { "@5.1": "/abs/path/to/transcript.jsonl", ... }.
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './json-file.js';

/** Stable pin key for a pane/session: windowId.paneIndex. */
export function pinKey(windowId, paneIndex) {
  return `${windowId}.${paneIndex ?? 0}`;
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
 * Validate a candidate transcript path for pinning: must be a string ending in
 * .jsonl, resolve to inside projectsRoot, and exist. Returns the resolved path
 * or null. Guards the pin API against arbitrary filesystem reads.
 */
export function validateTranscriptPath(raw, projectsRoot) {
  if (typeof raw !== 'string' || !raw.endsWith('.jsonl')) return null;
  let full;
  try {
    full = path.resolve(raw);
  } catch {
    return null;
  }
  if (!full.startsWith(projectsRoot + path.sep)) return null;
  try {
    if (!fs.statSync(full).isFile()) return null;
  } catch {
    return null;
  }
  return full;
}
