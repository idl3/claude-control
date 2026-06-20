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
import { execSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── Pure parsers (no exec — exported for unit testing) ───────────────────────

/**
 * Parse `vm_stat` stdout into reclaimable bytes, or null on parse failure.
 *
 * Treats free + inactive + speculative + purgeable + file-backed pages as
 * available (matches Activity Monitor / memory_pressure). Returns null if the
 * output is structurally unparseable.
 *
 * @param {string} out — raw stdout from `vm_stat`
 * @returns {number|null}
 */
export function parseVmStat(out) {
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
  // If every field is zero and there's no page-size line, treat as bad output.
  if (available === 0 && !out.includes('Pages free')) return null;
  return available * pageSize;
}

/**
 * Parse `pmset -g batt` stdout into a power-status object, or null on failure.
 *
 * `low` is a UI hint: ≤20% and not charging.
 * ponytail: macOS-only via pmset; add upower/sysfs parsing if Linux is ever needed.
 *
 * @param {string} out — raw stdout from `pmset -g batt`
 * @returns {{ hasBattery: boolean, percent?: number|null, charging?: boolean, low?: boolean }|null}
 */
export function parsePmset(out) {
  const onAc = /AC Power/.test(out);
  if (!/InternalBattery/.test(out)) return { hasBattery: false, charging: onAc };
  const percent = Number((out.match(/(\d+)%/) || [])[1]);
  const charging = onAc || /\bcharging\b/.test(out) || /\bcharged\b/.test(out);
  const pct = Number.isFinite(percent) ? percent : null;
  return { hasBattery: true, percent: pct, charging, low: pct != null && pct <= 20 && !charging };
}

// ── Async exec wrappers (timer-path only) ────────────────────────────────────

/**
 * Reclaimable ("available") free memory in bytes, fetched asynchronously.
 *
 * Returns null on non-darwin or any exec/parse failure so the caller falls
 * back to `os.freemem()`.
 *
 * @returns {Promise<number|null>}
 */
async function reclaimableFreeBytes() {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync('vm_stat', [], { encoding: 'utf8', timeout: 1000 });
    return parseVmStat(stdout);
  } catch {
    return null;
  }
}

/**
 * Battery / power status via `pmset -g batt` (darwin only), fetched asynchronously.
 *
 * Returns null on other platforms or any failure (UI then hides the battery chip).
 *
 * @returns {Promise<{ hasBattery: boolean, percent?: number|null, charging?: boolean, low?: boolean }|null>}
 */
async function powerStatus() {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync('pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: 1000 });
    return parsePmset(stdout);
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
    // Starts as null; first real value arrives on the first tick.
    this._power = null;
    this._powerTick = 0;

    // Reclaimable free-memory bytes: cached by the async tick. Starts as null
    // so the first snapshot falls back to os.freemem() (same as non-darwin).
    this._reclaimable = null;

    // In-flight guard: prevents a slow tick from overlapping the next interval.
    this._ticking = false;

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

  async _tick() {
    // Re-entrancy guard: if a previous tick is still awaiting subprocess results,
    // skip this interval entirely rather than running two ticks in parallel.
    if (this._ticking) return;
    this._ticking = true;
    try {
      // Refresh power every 5th tick (~15s). Awaiting here is safe — the guard
      // above prevents any overlap with the next scheduled interval.
      if (++this._powerTick % 5 === 0) {
        this._power = await powerStatus();
      }

      // Refresh reclaimable memory bytes every tick (vm_stat is fast, ~5ms).
      this._reclaimable = await reclaimableFreeBytes();

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
    } finally {
      this._ticking = false;
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
    // Use the async-cached reclaimable value; falls back to os.freemem() when null.
    const freeMB = Math.round((this._reclaimable != null ? this._reclaimable : os.freemem()) / 1048576);
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
 *
 * NOTE: This is request-driven (called per HTTP request), not timer-driven, so
 * it intentionally stays synchronous. Do not convert to async.
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
