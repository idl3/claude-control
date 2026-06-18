import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRewrite } from '../lib/optimize.js';
import { OPTIMIZE_CASES } from './fixtures/optimize-cases.mjs';

// The deterministic eval set is part of the test suite so guard regressions
// fail CI (the scorecard `npm run eval:optimise` prints the same cases).
for (const c of OPTIMIZE_CASES) {
  test(`evaluateRewrite: ${c.name}`, () => {
    const ev = evaluateRewrite(c.draft, c.optimized);
    assert.equal(ev.ok, c.expectOk, `verdict for "${c.name}" (violations: ${ev.violations.join(',')})`);
    if (c.expectViolations) {
      for (const v of c.expectViolations) {
        assert.ok(ev.violations.includes(v), `expected violation "${v}" — got ${ev.violations.join(',')}`);
      }
    }
  });
}
