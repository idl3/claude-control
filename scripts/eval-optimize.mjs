#!/usr/bin/env node
/**
 * eval-optimize.mjs — offline scorecard for the prompt-optimiser acceptance gate.
 * Runs lib/optimize.js → evaluateRewrite over the deterministic fixture set and
 * prints a per-case pass/fail table plus an aggregate. Exits non-zero on any
 * mismatch so it can gate CI / catch regressions in the guard logic.
 *
 * Run: npm run eval:optimise
 */
import { evaluateRewrite } from '../lib/optimize.js';
import { OPTIMIZE_CASES } from '../test/fixtures/optimize-cases.mjs';

let pass = 0;
const rows = [];
for (const c of OPTIMIZE_CASES) {
  const ev = evaluateRewrite(c.draft, c.optimized);
  const verdictOk = ev.ok === c.expectOk;
  // If the case pins expected violations, require they all fired.
  const violOk =
    !c.expectViolations || c.expectViolations.every((v) => ev.violations.includes(v));
  const ok = verdictOk && violOk;
  if (ok) pass += 1;
  rows.push({
    name: c.name,
    ok,
    got: ev.ok ? 'accept' : `reject(${ev.violations.join(',')})`,
    want: c.expectOk ? 'accept' : `reject(${(c.expectViolations || []).join(',') || 'any'})`,
    ratio: ev.metrics.lengthRatio,
    overlap: ev.metrics.contentOverlap,
  });
}

const W = Math.max(...rows.map((r) => r.name.length));
console.log('Prompt-optimiser eval — acceptance gate\n');
for (const r of rows) {
  console.log(
    `${r.ok ? '✓' : '✗'} ${r.name.padEnd(W)}  got=${r.got}  want=${r.want}  ` +
      `ratio=${r.ratio} overlap=${r.overlap}`,
  );
}
const total = OPTIMIZE_CASES.length;
console.log(`\n${pass}/${total} cases passed`);
if (pass !== total) {
  console.error('EVAL FAILED — guard logic regressed');
  process.exit(1);
}
