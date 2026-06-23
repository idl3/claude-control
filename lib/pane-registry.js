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
 * Reset GC state. Exported FOR TESTS ONLY; current GC is transcript-existence
 * based and has no mutable state, so this is intentionally a no-op.
 */
export function _resetGcStateForTest() {
  // no-op
}

/** %5 → "5"; tolerate any tmux pane-id form, keep it filename-safe. */
function paneFile(tmuxPane, dir = PANES_DIR) {
  const safe = String(tmuxPane || '').replace(/[^A-Za-z0-9_-]/g, '');
  return safe ? path.join(dir, `${safe}.json`) : null;
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
 * Persist an exact pane→transcript binding for transports that discover the
 * rollout path programmatically instead of via Claude's hook.
 *
 * @param {{paneId:string, sessionId?:string|null, transcriptPath:string, cwd?:string|null}} rec
 * @param {string} [dir] Override the registry dir (tests).
 * @returns {Promise<void>}
 */
export async function writePaneRegistryRecord(rec, dir = PANES_DIR) {
  if (!rec || typeof rec.paneId !== 'string' || typeof rec.transcriptPath !== 'string') return;
  const file = paneFile(rec.paneId, dir);
  if (!file) return;
  await fsp.mkdir(dir, { recursive: true }).catch(() => {});
  const record = {
    paneId: rec.paneId,
    sessionId: rec.sessionId ?? null,
    transcriptPath: rec.transcriptPath,
    cwd: rec.cwd ?? null,
    ts: Date.now(),
  };
  await fsp.writeFile(file, JSON.stringify(record), { mode: 0o600 });
}

/**
 * Remove registry files whose transcript files no longer exist.
 *
 * It deliberately does NOT use the live tmux pane set. That scan flickers
 * (transient `list-panes` hiccups, a session momentarily not enumerated on a
 * busy socket), and a flaky "pane absent" reading looks identical to a genuine
 * pane close — so keying deletion off it wrongly nukes pins for panes that are
 * very much alive (the long-lived window-1 binding kept vanishing this way).
 *
 * A pin for a closed pane whose transcript still lingers is harmless: there is
 * no live pane to bind it to, and if the pane id is later reused the hook
 * overwrites the file. It self-expires here once its transcript is removed.
 *
 * @param {string} [dir] Override registry dir (tests).
 * @returns {Promise<void>}
 */
export async function gcPaneRegistry(dir = PANES_DIR) {
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }

  await Promise.all(
    entries
      .filter((f) => f.endsWith('.json'))
      .map(async (f) => {
        try {
          const filePath = path.join(dir, f);
          const rec = JSON.parse(await fsp.readFile(filePath, 'utf8'));
          if (!rec || typeof rec.transcriptPath !== 'string') return;
          if (!fs.existsSync(rec.transcriptPath)) {
            await fsp.rm(filePath, { force: true }); // transcript gone → stale
          }
        } catch {
          // ignore unreadable/partial files
        }
      }),
  );
}
