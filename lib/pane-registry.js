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
 * @param {Set<string>} livePaneIds
 * @returns {Promise<void>}
 */
export async function gcPaneRegistry(livePaneIds) {
  let entries;
  try {
    entries = await fsp.readdir(PANES_DIR);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((f) => f.endsWith('.json'))
      .map(async (f) => {
        try {
          const rec = JSON.parse(await fsp.readFile(path.join(PANES_DIR, f), 'utf8'));
          if (rec && typeof rec.paneId === 'string' && !livePaneIds.has(rec.paneId)) {
            await fsp.rm(path.join(PANES_DIR, f), { force: true });
          }
        } catch {
          // ignore
        }
      }),
  );
}
