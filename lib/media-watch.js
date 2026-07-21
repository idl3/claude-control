// lib/media-watch.js — rename-tolerant watcher over the media apps directory
// (CONFIG.mediaDir/apps), debounced per relative path, feeding D2's client
// hot-reload via server.js's broadcast(). Same shape as TranscriptTailer
// (lib/transcript.js): EventEmitter, dual fs.watch + poll fallback, tolerant
// of files underneath it being renamed or recreated out from under the watch
// (atomic-write-via-rename is exactly how the D5 producer publishes a new
// version — temp file written, then renamed into place — and rename events
// are precisely the case a naive single-file fs.watch can drop).
//
// Layout being watched (docs/plans/cockpit-pinned-artifacts/phase-d-tasks.md, D3):
//   apps/<name>.html                        flat, non-versioned (legacy, still valid)
//   apps/<name>/<ISO-stamp>[-label].html    one immutable build
//   apps/<name>/latest                      text pointer to the current version
//
// Emits 'change' with { path: 'apps/<relPath>', mtime } once per settled
// write anywhere under the watched root (relPath POSIX-slash-normalized,
// prefixed with 'apps/' to match the media-root-relative shape the client
// already uses for embedded-app urls). Emits 'error' for anything the caller
// should log but not crash on.
//
// Reliability: fs.watch's `recursive: true` is used as the fast path (stable
// on macOS/Windows since Node 20; some Linux/Node combos throw
// ERR_FEATURE_UNAVAILABLE_ON_PLATFORM). A periodic full-tree poll sweep
// (mtime scan, default every 2s) runs unconditionally alongside it — not just
// as an on-error fallback — so directory-recreation and any platform where
// recursive fs.watch silently misses events are still covered. See the D1
// HALT clause: do not ship flaky.

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

function envInt(name) {
  const raw = process.env[`CLAUDE_CONTROL_${name}`];
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const DEFAULT_DEBOUNCE_MS = envInt('MEDIA_WATCH_DEBOUNCE_MS') ?? 300;
const DEFAULT_POLL_MS = envInt('MEDIA_WATCH_POLL_MS') ?? 2000;

export class MediaAppWatcher extends EventEmitter {
  /**
   * @param {string} rootDir  the apps/ directory to watch (e.g. path.join(CONFIG.mediaDir, 'apps'))
   * @param {{debounceMs?: number, pollMs?: number}} [opts]
   */
  constructor(rootDir, opts = {}) {
    super();
    this.rootDir = rootDir;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this._stopped = false;
    this._watcher = null;
    this._pollTimer = null;
    this._debounceTimers = new Map(); // relPath -> Timeout
    this._mtimes = new Map(); // relPath -> last-known mtimeMs (dedup + startup seed)
  }

  start() {
    if (this._stopped) return;
    fs.mkdirSync(this.rootDir, { recursive: true });
    // Seed known mtimes from the current tree BEFORE attaching any
    // watch/poll, so pre-existing files never fire a spurious 'change' the
    // instant the watcher starts — only genuinely new writes do.
    this._walk(this.rootDir, '', (relPath, abs) => {
      try {
        this._mtimes.set(relPath, fs.statSync(abs).mtimeMs);
      } catch {
        /* raced away between readdir and stat — next poll sweep settles it */
      }
    });
    this._attach();
  }

  _attach() {
    if (this._stopped) return;
    try {
      this._watcher = fs.watch(this.rootDir, { recursive: true }, (_eventType, filename) => {
        this._onFsEvent(filename);
      });
      this._watcher.on('error', (err) => this.emit('error', err));
      // Closes the race between the seed walk above and this watch actually
      // being registered — a write landing in that gap would otherwise be
      // missed until the next poll sweep.
      setImmediate(() => this._pollSweep());
    } catch (err) {
      // Recursive watch unsupported on this platform — the poll loop below
      // is not a degraded fallback here, it runs either way, so this alone
      // never leaves the watcher blind.
      this.emit('error', err);
    }
    this._armPoll();
  }

  _armPoll() {
    if (this._stopped || this._pollTimer) return;
    this._pollTimer = setInterval(() => this._pollSweep(), this.pollMs);
    this._pollTimer.unref?.();
  }

  _onFsEvent(filename) {
    if (this._stopped || !filename) return;
    const relPath = String(filename).split(path.sep).join('/');
    this._scheduleCheck(relPath);
  }

  _scheduleCheck(relPath) {
    if (this._stopped) return;
    const existing = this._debounceTimers.get(relPath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this._debounceTimers.delete(relPath);
      this._checkAndEmit(relPath);
    }, this.debounceMs);
    timer.unref?.();
    this._debounceTimers.set(relPath, timer);
  }

  _checkAndEmit(relPath) {
    if (this._stopped) return;
    const abs = path.join(this.rootDir, relPath);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      // Gone (or not yet visible post-rename) — nothing to broadcast. A
      // directory recreation is picked up by the next event/poll sweep on
      // whatever gets written inside it.
      return;
    }
    if (!stat.isFile()) return;
    const mtime = stat.mtimeMs;
    if (this._mtimes.get(relPath) === mtime) return; // already reported this exact write
    this._mtimes.set(relPath, mtime);
    this.emit('change', { path: `apps/${relPath}`, mtime });
  }

  _pollSweep() {
    if (this._stopped) return;
    // Only schedule paths whose mtime actually moved — otherwise a long-lived
    // server pays one timer per accumulated version file every sweep (version
    // history is append-only; nothing prunes apps/<name>/ today).
    //
    // L2 (Codex review): prune `_mtimes` for any relPath no longer present on
    // disk. Before this fix, a deleted file's entry lingered in `_mtimes`
    // forever — an unbounded per-server-lifetime leak on top of the
    // already-unpruned version history. Track every relPath actually seen
    // this walk; anything already in `_mtimes` but NOT seen this sweep is
    // gone (deleted, or its whole directory was removed) and its entry is
    // dropped so a later file recreated at the same relPath is treated as
    // genuinely new rather than deduped against a stale mtime.
    const seen = new Set();
    this._walk(this.rootDir, '', (relPath, absPath) => {
      let stat;
      try {
        stat = fs.statSync(absPath);
      } catch {
        return;
      }
      if (!stat.isFile()) return;
      seen.add(relPath);
      if (this._mtimes.get(relPath) === stat.mtimeMs) return;
      this._scheduleCheck(relPath);
    });
    for (const relPath of this._mtimes.keys()) {
      if (!seen.has(relPath)) this._mtimes.delete(relPath);
    }
  }

  /** Recursively visit every file under absDir, calling visit(relPath, absPath). */
  _walk(absDir, relDir, visit) {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // dir vanished mid-walk; next sweep picks it back up once recreated
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        this._walk(abs, rel, visit);
      } else if (entry.isFile()) {
        visit(rel, abs);
      }
    }
  }

  stop() {
    this._stopped = true;
    if (this._watcher) {
      try {
        this._watcher.close();
      } catch {
        /* already closed */
      }
      this._watcher = null;
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    for (const t of this._debounceTimers.values()) clearTimeout(t);
    this._debounceTimers.clear();
  }
}
