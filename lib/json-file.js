/**
 * lib/json-file.js — atomic JSON file writes.
 *
 * writeJsonAtomic(filePath, obj, options?) serialises obj to JSON, writes it
 * to a same-directory temp file, then renames the temp file over the
 * destination.  The rename is the commit point — a crash before the rename
 * leaves the previous file intact; a crash after leaves the new file intact.
 * A truncated in-progress write can never be observed by readers.
 *
 * The temp file is placed in the same directory as the destination so that
 * the rename is guaranteed to be atomic (same filesystem, no cross-device
 * move).  On any error the temp file is unlinked before re-throwing.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Write obj as pretty-printed JSON to filePath atomically.
 *
 * @param {string} filePath  - absolute or relative destination path
 * @param {unknown} obj      - value passed to JSON.stringify
 * @param {{ mode?: number }} [options]
 * @param {number} [options.mode=0o600] - file permission mode for the temp file
 */
export function writeJsonAtomic(filePath, obj, { mode = 0o600 } = {}) {
  const dir = path.dirname(filePath);
  const tmp = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best-effort cleanup; ignore unlink errors
    }
    throw err;
  }
}
