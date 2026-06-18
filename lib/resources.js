/**
 * lib/resources.js — Process and system resource monitoring.
 *
 * cpuPct is single-core normalized: 100 means one full CPU core is consumed.
 * Formula: (deltaUser + deltaSystem) [microseconds] / wallMs [milliseconds] / 1000 * 100
 *          = cpuMicros / (wallMs * 1000) * 100
 * This can exceed 100 on multi-core systems if the process uses multiple cores.
 * It is intentionally NOT divided by cpuCount so the caller can judge load per-core.
 */

import { EventEmitter } from 'node:events';
import os from 'node:os';
import { execSync } from 'node:child_process';

/**
 * Reclaimable ("available") free memory in bytes.
 *
 * `os.freemem()` on macOS counts only truly-free pages — inactive, cached
 * (file-backed), speculative and purgeable memory are all reclaimable but
 * excluded, so memUsedPct computed from it pins near ~98% even when the
 * machine is nowhere near pressure. On darwin we parse `vm_stat` and treat
 * free + inactive + speculative + purgeable + file-backed as available
 * (matching what `memory_pressure` / Activity Monitor report). Returns null
 * on non-darwin or any parse/exec failure so the caller falls back to
 * `os.freemem()`.
 */
function reclaimableFreeBytes() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execSync('vm_stat', { encoding: 'utf8', timeout: 1000 });
    const pageSize = Number((out.match(/page size of (\d+) bytes/) || [])[1]) || 4096;
    const pages = (label) => {
      const m = out.match(new RegExp(`${label}:\\s+(\\d+)\\.`));
      return m ? Number(m[1]) : 0;
    };
    const available =
      pages('Pages free') +
      pages('Pages inactive') +
      pages('Pages speculative') +
      pages('Pages purgeable') +
      pages('File-backed pages');
    return available * pageSize;
  } catch {
    return null;
  }
}

/**
 * Battery / power status via `pmset -g batt` (darwin only). Returns null on
 * other platforms or any failure (UI then hides the battery chip). `low` is a
 * UI hint: ≤20% and not charging.
 * ponytail: macOS-only via pmset; add upower/sysfs parsing if Linux is ever needed.
 */
function powerStatus() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execSync('pmset -g batt', { encoding: 'utf8', timeout: 1000 });
    const onAc = /AC Power/.test(out);
    if (!/InternalBattery/.test(out)) return { hasBattery: false, charging: onAc };
    const percent = Number((out.match(/(\d+)%/) || [])[1]);
    const charging = onAc || /\bcharging\b/.test(out) || /\bcharged\b/.test(out);
    const pct = Number.isFinite(percent) ? percent : null;
    return { hasBattery: true, percent: pct, charging, low: pct != null && pct <= 20 && !charging };
  } catch {
    return null;
  }
}

export class ResourceMonitor extends EventEmitter {
  /**
   * @param {{ intervalMs?: number, rssLimitMB?: number }} opts
   */
  constructor({ intervalMs = 3000, rssLimitMB = 350 } = {}) {
    super();
    this._intervalMs = intervalMs;
    this._rssLimitMB = rssLimitMB;
    this._timer = null;
    this._overLimit = false;

    // Capture initial CPU usage baseline so the first tick has a valid delta.
    this._prevCpu = process.cpuUsage();
    this._prevWall = Date.now();

    // Power is sampled less often than cpu/mem (pmset is a subprocess): refresh
    // every 5th tick (~15s). Cache between refreshes.
    this._power = powerStatus();
    this._powerTick = 0;

    // Compute an initial snapshot so snapshot() works before start().
    this._latest = this._compute();
  }

  /** Begin periodic sampling. */
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), this._intervalMs);
    this._timer.unref();
  }

  /** Stop periodic sampling. */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** Return the latest computed Snapshot (available immediately after construction). */
  snapshot() {
    return this._latest;
  }

  // ---- internals -------------------------------------------------------------

  _tick() {
    if (++this._powerTick % 5 === 0) this._power = powerStatus();
    const snap = this._compute();
    this._latest = snap;
    this.emit('sample', snap);

    if (snap.overLimit && !this._overLimit) {
      // Rising edge only.
      this._overLimit = true;
      this.emit('overlimit', snap);
    } else if (!snap.overLimit) {
      // Reset so we can emit again if it crosses again later.
      this._overLimit = false;
    }
  }

  _compute() {
    const nowWall = Date.now();
    const nowCpu = process.cpuUsage();

    const wallMs = Math.max(nowWall - this._prevWall, 1); // guard div-by-zero
    const deltaUser = nowCpu.user - this._prevCpu.user;   // microseconds
    const deltaSystem = nowCpu.system - this._prevCpu.system; // microseconds

    // Single-core normalized CPU %: 100 == one full CPU core.
    // wallMs * 1000 converts wall time to microseconds for the same unit.
    const cpuPct = Math.round(((deltaUser + deltaSystem) / (wallMs * 1000)) * 100 * 10) / 10;

    this._prevCpu = nowCpu;
    this._prevWall = nowWall;

    const mem = process.memoryUsage();
    const rssMB = Math.round(mem.rss / 1048576);
    const heapMB = Math.round(mem.heapUsed / 1048576);

    const loadavg = /** @type {[number, number, number]} */ (os.loadavg());
    const cpuCount = os.cpus().length;
    const totalMB = Math.round(os.totalmem() / 1048576);
    const reclaimable = reclaimableFreeBytes();
    const freeMB = Math.round((reclaimable != null ? reclaimable : os.freemem()) / 1048576);
    const memUsedPct = Math.round(((totalMB - freeMB) / totalMB) * 100 * 10) / 10;

    return {
      ts: Date.now(),
      self: { cpuPct, rssMB, heapMB },
      system: { loadavg, cpuCount, totalMB, freeMB, memUsedPct },
      power: this._power,
      overLimit: rssMB > this._rssLimitMB,
    };
  }
}

/**
 * Snapshot of the busiest processes via `ps`, newest BSD/macOS + Linux compatible
 * flags. Returns up to `limit` rows sorted by CPU%. Best-effort: [] on failure.
 */
export function listProcesses(limit = 40) {
  try {
    // -A all procs; -o explicit columns; comm=command name, args truncated by us.
    const out = execSync('ps -Ao pid,ppid,%cpu,%mem,rss,comm', {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const rows = out.trim().split('\n').slice(1).map((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
      if (!m) return null;
      return {
        pid: Number(m[1]),
        ppid: Number(m[2]),
        cpu: Number(m[3]),
        mem: Number(m[4]),
        rssMB: Math.round(Number(m[5]) / 1024),
        command: m[6],
      };
    }).filter(Boolean);
    rows.sort((a, b) => b.cpu - a.cpu);
    return rows.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Send a signal to a pid. Validates the pid is a positive integer and refuses
 * pid 1 and the server's own pid. Returns {ok} / {ok:false,error}.
 */
export function killProcess(pid, signal = 'SIGTERM') {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) return { ok: false, error: 'invalid pid' };
  if (n === process.pid) return { ok: false, error: 'refusing to kill the control server' };
  try {
    process.kill(n, signal);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
