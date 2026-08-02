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

// CC_PANES_DIR mirrors hooks/record-pane.mjs so the hook and this lib agree on
// the registry dir, and so tests can redirect it to a temp dir (hermetic).
const PANES_DIR = process.env.CC_PANES_DIR || path.join(os.homedir(), '.claude-control', 'panes');

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
 * When >1 pin references the same transcript — the reboot case, where tmux
 * pane-ids reset (%0, %2, …) but a pre-reboot pin (%84, %252, …) lingers because
 * its transcript is still live — the newest-ts pin wins. The resumed session is
 * always the most recently written pin, so newest ts == the live binding; this
 * keeps one transcript bound to exactly one pane without consulting live tmux
 * (which flickers — see gcPaneRegistry).
 *
 * @param {string} [dir] Override the registry dir (tests).
 * @returns {Promise<Map<string, PaneRecord>>} keyed by paneId (tmux %N)
 */
export async function readPaneRegistry(dir = PANES_DIR) {
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return new Map(); // no registry yet (hook not installed / no sessions)
  }
  const recs = await Promise.all(
    entries
      .filter((f) => f.endsWith('.json'))
      .map(async (f) => {
        try {
          const rec = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
          if (!rec || typeof rec.paneId !== 'string' || typeof rec.transcriptPath !== 'string') return null;
          if (!fs.existsSync(rec.transcriptPath)) return null; // stale → ignore
          return rec;
        } catch {
          return null; // skip unreadable/partial file
        }
      }),
  );
  const newestByTranscript = new Map();
  for (const rec of recs) {
    if (!rec) continue;
    const prev = newestByTranscript.get(rec.transcriptPath);
    if (!prev || (rec.ts ?? 0) >= (prev.ts ?? 0)) newestByTranscript.set(rec.transcriptPath, rec);
  }
  const map = new Map();
  for (const rec of newestByTranscript.values()) map.set(rec.paneId, rec);
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
 * Delete one pane's registry record (unregister). Used by the session terminate
 * action so a killed pane's binding doesn't linger and later mis-bind a reused
 * %N. Idempotent: a missing file is a no-op.
 *
 * @param {string} paneId tmux %N
 * @param {string} [dir]  Override the registry dir (tests).
 * @returns {Promise<void>}
 */
export async function deletePaneRegistryRecord(paneId, dir = PANES_DIR) {
  const file = paneFile(paneId, dir);
  if (!file) return;
  await fsp.rm(file, { force: true }).catch(() => {});
}

/**
 * Remove registry files that are either (a) stale — their transcript file no
 * longer exists — or (b) superseded: a newer-ts pin references the SAME live
 * transcript. Case (b) is the reboot leftover — a pre-reboot pane-id pin sitting
 * beside the resumed session's fresh pin — which case (a) never collects because
 * the shared transcript is still live. It accumulates one dead file per reboot
 * until cleaned here.
 *
 * It deliberately does NOT use the live tmux pane set. That scan flickers
 * (transient `list-panes` hiccups, a session momentarily not enumerated on a
 * busy socket), and a flaky "pane absent" reading looks identical to a genuine
 * pane close — so keying deletion off it wrongly nukes pins for panes that are
 * very much alive (the long-lived window-1 binding kept vanishing this way).
 * Supersession compares pins to each other (newest ts per transcript), never to
 * live tmux, so it is flicker-safe.
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

  const loaded = await Promise.all(
    entries
      .filter((f) => f.endsWith('.json'))
      .map(async (f) => {
        try {
          const filePath = path.join(dir, f);
          const rec = JSON.parse(await fsp.readFile(filePath, 'utf8'));
          if (!rec || typeof rec.transcriptPath !== 'string') return null;
          return { filePath, rec };
        } catch {
          return null; // ignore unreadable/partial files
        }
      }),
  );

  // Newest ts per still-live transcript — the winner every other same-transcript
  // pin is superseded by. Ties (equal ts) keep both; real pins carry ms-distinct
  // ts, so a reboot leftover always loses. ponytail: no tie-break, harmless dup.
  const newestTs = new Map();
  for (const item of loaded) {
    if (!item || !fs.existsSync(item.rec.transcriptPath)) continue;
    const t = item.rec.transcriptPath;
    const ts = item.rec.ts ?? 0;
    if (!newestTs.has(t) || ts > newestTs.get(t)) newestTs.set(t, ts);
  }

  await Promise.all(
    loaded.map(async (item) => {
      if (!item) return;
      const { filePath, rec } = item;
      if (!fs.existsSync(rec.transcriptPath)) {
        await fsp.rm(filePath, { force: true }); // transcript gone → stale
        return;
      }
      if ((rec.ts ?? 0) < newestTs.get(rec.transcriptPath)) {
        await fsp.rm(filePath, { force: true }); // superseded by a newer pin
      }
    }),
  );
}
