/**
 * lib/pane-registry.js — read the tmux-pane ↔ transcript map authored by the
 * SessionStart hook (hooks/record-pane.mjs), which writes one JSON file per pane
 * under ~/.claude-control/panes/. This is the DETERMINISTIC binding: Claude
 * itself recorded which transcript belongs to which pane, so the cockpit never
 * has to infer from titles or timing.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const PANES_DIR = path.join(os.homedir(), '.claude-control', 'panes');

/**
 * Number of CONSECUTIVE gc passes a pane must be absent before its registry
 * file is removed. Guards against transient/partial tmux scans (e.g. on
 * server restart where the first refresh sees 0 or fewer panes than reality).
 */
const GC_MISS_THRESHOLD = 3;

/**
 * Per-paneId consecutive-miss counter. Module-level so it persists across gc
 * calls within a server session. Keys are paneIds; values are miss counts.
 *
 * @type {Map<string, number>}
 */
const _gcMissCount = new Map();

/**
 * Reset GC miss-counter state. Exported FOR TESTS ONLY — do not call in
 * production code.
 */
export function _resetGcStateForTest() {
  _gcMissCount.clear();
}

/**
 * @typedef {Object} PaneRecord
 * @property {string}      paneId          tmux %N (matches a pane's paneId)
 * @property {string|null} sessionId
 * @property {string}      transcriptPath
 * @property {string|null} cwd
 * @property {number}      ts
 */

/**
 * Load the pane→transcript map. Entries whose transcript file no longer exists
 * are dropped (a closed/replaced session). Best-effort: a missing dir or an
 * unreadable file yields an empty/partial map rather than throwing.
 *
 * @param {string} [dir] Override the registry dir (tests).
 * @returns {Promise<Map<string, PaneRecord>>} keyed by paneId (tmux %N)
 */
export async function readPaneRegistry(dir = PANES_DIR) {
  const map = new Map();
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return map; // no registry yet (hook not installed / no sessions)
  }
  await Promise.all(
    entries
      .filter((f) => f.endsWith('.json'))
      .map(async (f) => {
        try {
          const rec = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
          if (!rec || typeof rec.paneId !== 'string' || typeof rec.transcriptPath !== 'string') return;
          if (!fs.existsSync(rec.transcriptPath)) return; // stale → ignore
          map.set(rec.paneId, rec);
        } catch {
          // skip unreadable/partial file
        }
      }),
  );
  return map;
}

/**
 * Remove registry files for panes that no longer exist (best-effort GC, e.g.
 * when SessionEnd didn't fire on a crash). `livePaneIds` is the set of tmux %N
 * currently present.
 *
 * Safety rules:
 *  1. Empty-scan guard: if livePaneIds is empty, return immediately — a scan
 *     that found zero panes is almost certainly incomplete/transient (server
 *     restart, partial tmux read). Never wipe pins in that case.
 *  2. Debounced removal: a pane file is only deleted after it has been absent
 *     from livePaneIds for GC_MISS_THRESHOLD consecutive passes. This lets
 *     genuine pane deaths propagate while surviving transient partial scans.
 *
 * @param {Set<string>} livePaneIds
 * @param {string}      [dir]         Override registry dir (tests).
 * @returns {Promise<void>}
 */
export async function gcPaneRegistry(livePaneIds, dir = PANES_DIR) {
  // Guard 1: empty scan → skip entirely.
  if (livePaneIds.size === 0) return;

  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }

  const jsonFiles = entries.filter((f) => f.endsWith('.json'));

  // Collect the set of paneIds we currently have files for so we can prune
  // counters for paneIds whose files have already been deleted (avoids
  // unbounded map growth over a long-running session).
  const seenPaneIds = new Set();

  await Promise.all(
    jsonFiles.map(async (f) => {
      try {
        const filePath = path.join(dir, f);
        const rec = JSON.parse(await fsp.readFile(filePath, 'utf8'));
        if (!rec || typeof rec.paneId !== 'string') return;

        const { paneId } = rec;
        seenPaneIds.add(paneId);

        if (livePaneIds.has(paneId)) {
          // Pane is alive — reset its miss counter.
          _gcMissCount.delete(paneId);
        } else {
          // Pane absent this pass — increment miss counter.
          const misses = (_gcMissCount.get(paneId) ?? 0) + 1;
          if (misses >= GC_MISS_THRESHOLD) {
            await fsp.rm(filePath, { force: true });
            _gcMissCount.delete(paneId);
          } else {
            _gcMissCount.set(paneId, misses);
          }
        }
      } catch {
        // ignore unreadable/partial files
      }
    }),
  );

  // Prune counters for paneIds that no longer have a registry file (already
  // deleted or never written) to prevent unbounded map growth.
  for (const paneId of _gcMissCount.keys()) {
    if (!seenPaneIds.has(paneId)) {
      _gcMissCount.delete(paneId);
    }
  }
}
