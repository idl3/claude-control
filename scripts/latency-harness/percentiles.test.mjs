// scripts/latency-harness/percentiles.test.mjs — synthetic self-check for the
// pure percentile + cross-run variance math (task A2). Proves the measurement
// math is correct BEFORE any live-target run ever happens; no network, no
// timers, no real latency numbers — synthetic arrays only.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { percentileOf, computePercentiles, varianceVerdict, crossRunVerdict } from './percentiles.mjs';

test('percentileOf: nearest-rank on 1..10 matches hand-computed ranks', () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  // rank = ceil(p/100 * 10): p50 -> rank 5 -> value 5; p95/p99 -> rank 10 -> value 10.
  assert.equal(percentileOf(sorted, 50), 5);
  assert.equal(percentileOf(sorted, 95), 10);
  assert.equal(percentileOf(sorted, 99), 10);
});

test('percentileOf: p=0 returns min, p=100 returns max', () => {
  const sorted = [3, 7, 42];
  assert.equal(percentileOf(sorted, 0), 3);
  assert.equal(percentileOf(sorted, 100), 42);
});

test('percentileOf: rejects out-of-range p and empty input', () => {
  assert.throws(() => percentileOf([1, 2, 3], -1), /p must be in \[0, 100\]/);
  assert.throws(() => percentileOf([1, 2, 3], 101), /p must be in \[0, 100\]/);
  assert.throws(() => percentileOf([], 50), /non-empty array/);
});

test('computePercentiles: sorts unsorted input before ranking (does not mutate input)', () => {
  const samples = [10, 1, 5, 3, 8, 2, 9, 4, 7, 6];
  const original = [...samples];
  const result = computePercentiles(samples);
  assert.deepEqual(samples, original, 'input array must not be mutated');
  assert.equal(result.n, 10);
  assert.equal(result.min, 1);
  assert.equal(result.max, 10);
  assert.equal(result.p50, 5);
  assert.equal(result.p95, 10);
  assert.equal(result.p99, 10);
});

test('computePercentiles: a larger synthetic sample (50 values, one outlier) separates p50 from p99', () => {
  // 49 values clustered at 10ms, one outlier at 500ms (simulates a single
  // dropped/delayed echo frame) -- with n=50 the outlier is a 2% tail, so
  // nearest-rank p99 (rank = ceil(0.99*50) = 50 -> last element) lands
  // exactly on it, while p50 stays in the cluster.
  const samples = [...Array(49).fill(10), 500];
  const result = computePercentiles(samples);
  assert.equal(result.p50, 10);
  assert.equal(result.p99, 500, 'the single outlier must surface at p99 with n=50');
});

test('computePercentiles: rejects empty array and negative/non-finite samples', () => {
  assert.throws(() => computePercentiles([]), /non-empty array/);
  assert.throws(() => computePercentiles([1, -5, 3]), /invalid sample/);
  assert.throws(() => computePercentiles([1, NaN, 3]), /invalid sample/);
  assert.throws(() => computePercentiles([1, Infinity, 3]), /invalid sample/);
});

test('varianceVerdict: three runs within +-10% of their mean -> ok (boundary inclusive)', () => {
  // mean=100, deviations exactly -10%/0%/+10%.
  const verdict = varianceVerdict([90, 100, 110], 10);
  assert.equal(verdict.mean, 100);
  assert.equal(verdict.maxDeviationPct, 10);
  assert.equal(verdict.ok, true, 'exactly 10% deviation must still pass an inclusive <=10% rule');
});

test('varianceVerdict: one run just over +-10% -> fails', () => {
  // mean=100, deviations -11%/0%/+11%.
  const verdict = varianceVerdict([89, 100, 111], 10);
  assert.equal(verdict.mean, 100);
  assert.ok(verdict.maxDeviationPct > 10);
  assert.equal(verdict.ok, false, 'a run 11% off the mean must fail the +-10% rule');
});

test('varianceVerdict: honors a custom tolerancePct', () => {
  const tight = varianceVerdict([95, 100, 105], 5);
  assert.equal(tight.ok, true, 'exactly +-5% must pass a 5% tolerance');

  const tooTight = varianceVerdict([94, 100, 106], 5);
  assert.equal(tooTight.ok, false, '+-6% must fail a 5% tolerance');
});

test('varianceVerdict: rejects empty input', () => {
  assert.throws(() => varianceVerdict([]), /non-empty array/);
});

test('crossRunVerdict: stable p50/p95/p99 across 3 runs -> ok', () => {
  const runs = [
    { p50: 10, p95: 20, p99: 30 },
    { p50: 10.5, p95: 20.5, p99: 30.5 },
    { p50: 9.6, p95: 19.6, p99: 29.6 },
  ];
  const verdict = crossRunVerdict(runs, 10);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.p50.ok, true);
  assert.equal(verdict.p95.ok, true);
  assert.equal(verdict.p99.ok, true);
});

test('crossRunVerdict: a single noisy percentile (p99 spikes on one run) fails the WHOLE verdict', () => {
  const runs = [
    { p50: 10, p95: 20, p99: 30 },
    { p50: 10, p95: 20, p99: 30 },
    { p50: 10, p95: 20, p99: 90 }, // p99 triples on the third run -- a real regression signal
  ];
  const verdict = crossRunVerdict(runs, 10);
  assert.equal(verdict.p50.ok, true, 'p50 stayed stable');
  assert.equal(verdict.p95.ok, true, 'p95 stayed stable');
  assert.equal(verdict.p99.ok, false, 'p99 must be flagged unstable');
  assert.equal(verdict.ok, false, 'overall verdict must fail when ANY percentile is unstable');
});

test('crossRunVerdict: rejects empty runResults', () => {
  assert.throws(() => crossRunVerdict([]), /non-empty array/);
});
