/**
 * scripts/latency-harness/percentiles.mjs — pure percentile + cross-run
 * variance math for the keystroke-echo latency harness (task A2).
 *
 * ESM, Node built-ins only (no imports at all — this module is dependency-free
 * by construction so it can be unit-tested with zero setup, per CONTRACT.md's
 * "only runtime dep is ws" rule: this file doesn't even need that).
 *
 * Deliberately separated from run.mjs (the live-target CLI) so the math can be
 * exercised against synthetic arrays without ever touching a network socket.
 */

/**
 * Percentile of a value already-sorted-ascending array, using the
 * "nearest-rank" method (simple, deterministic, no interpolation):
 *   rank = ceil(p/100 * N), value = sorted[rank - 1]   (1-based rank, clamped)
 *
 * @param {number[]} sortedAscending non-empty array, already sorted ascending
 * @param {number} p percentile in [0, 100]
 * @returns {number}
 */
export function percentileOf(sortedAscending, p) {
  if (!Array.isArray(sortedAscending) || sortedAscending.length === 0) {
    throw new Error('percentileOf: sortedAscending must be a non-empty array');
  }
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    throw new Error(`percentileOf: p must be in [0, 100], got ${p}`);
  }
  if (p <= 0) return sortedAscending[0];
  if (p >= 100) return sortedAscending[sortedAscending.length - 1];
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  const index = Math.min(Math.max(rank - 1, 0), sortedAscending.length - 1);
  return sortedAscending[index];
}

/**
 * p50/p95/p99 (+ n/min/max) over one run's raw round-trip samples (ms).
 * Sorts a COPY — never mutates the caller's array (coding-style: no mutation).
 *
 * @param {number[]} samplesMs round-trip latency samples in milliseconds
 * @returns {{ p50: number, p95: number, p99: number, n: number, min: number, max: number }}
 */
export function computePercentiles(samplesMs) {
  if (!Array.isArray(samplesMs) || samplesMs.length === 0) {
    throw new Error('computePercentiles: samplesMs must be a non-empty array');
  }
  for (const s of samplesMs) {
    if (!Number.isFinite(s) || s < 0) {
      throw new Error(`computePercentiles: invalid sample ${JSON.stringify(s)} (must be a non-negative finite number)`);
    }
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    p50: percentileOf(sorted, 50),
    p95: percentileOf(sorted, 95),
    p99: percentileOf(sorted, 99),
    n: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

/**
 * Cross-run variance verdict (the "±10% rule"): given the SAME percentile
 * (e.g. p50) measured across N independent runs, every run's value must sit
 * within `tolerancePct`% of the across-run mean, or the baseline is declared
 * unstable (too noisy to trust as a calibration figure).
 *
 * @param {number[]} valuesAcrossRuns e.g. [run1.p50, run2.p50, run3.p50]
 * @param {number} [tolerancePct=10]
 * @returns {{ ok: boolean, mean: number, deviationsPct: number[], maxDeviationPct: number, tolerancePct: number }}
 */
export function varianceVerdict(valuesAcrossRuns, tolerancePct = 10) {
  if (!Array.isArray(valuesAcrossRuns) || valuesAcrossRuns.length === 0) {
    throw new Error('varianceVerdict: valuesAcrossRuns must be a non-empty array');
  }
  if (!Number.isFinite(tolerancePct) || tolerancePct < 0) {
    throw new Error(`varianceVerdict: tolerancePct must be >= 0, got ${tolerancePct}`);
  }
  const mean = valuesAcrossRuns.reduce((sum, v) => sum + v, 0) / valuesAcrossRuns.length;
  const deviationsPct = valuesAcrossRuns.map((v) => (mean === 0 ? 0 : ((v - mean) / mean) * 100));
  const maxDeviationPct = Math.max(...deviationsPct.map((d) => Math.abs(d)));
  return {
    ok: maxDeviationPct <= tolerancePct,
    mean,
    deviationsPct,
    maxDeviationPct,
    tolerancePct,
  };
}

/**
 * Convenience: apply varianceVerdict independently to p50, p95, and p99
 * across a set of per-run `computePercentiles` results. A baseline is only
 * "stable" if ALL THREE percentiles pass the tolerance independently — a
 * stable p50 with a wildly swinging p99 is still a noisy baseline.
 *
 * @param {{p50:number, p95:number, p99:number}[]} runResults one entry per run
 * @param {number} [tolerancePct=10]
 * @returns {{ ok: boolean, p50: object, p95: object, p99: object }}
 */
export function crossRunVerdict(runResults, tolerancePct = 10) {
  if (!Array.isArray(runResults) || runResults.length === 0) {
    throw new Error('crossRunVerdict: runResults must be a non-empty array');
  }
  const p50 = varianceVerdict(runResults.map((r) => r.p50), tolerancePct);
  const p95 = varianceVerdict(runResults.map((r) => r.p95), tolerancePct);
  const p99 = varianceVerdict(runResults.map((r) => r.p99), tolerancePct);
  return { ok: p50.ok && p95.ok && p99.ok, p50, p95, p99 };
}
