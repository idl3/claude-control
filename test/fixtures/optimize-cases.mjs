/**
 * Deterministic eval set for the prompt-optimiser acceptance gate
 * (lib/optimize.js → evaluateRewrite). Each case is a (draft, optimized) pair
 * with the expected verdict. Good rewrites must pass; the weak-model failure
 * modes (over-expansion, injected questions, intent drift, …) must be rejected.
 *
 * Run: `npm run eval:optimise` (scorecard) — also asserted in test/optimize-eval.test.js.
 */
export const OPTIMIZE_CASES = [
  {
    name: 'clear short prompt — light cleanup only',
    draft: 'fix the typo in the readme',
    optimized: 'Fix the typo in the README.',
    expectOk: true,
  },
  {
    name: 'reasonable clarification — one extra clause, within length budget',
    draft: 'add a dark mode toggle',
    optimized: 'Add a dark mode toggle to the settings page, persisting the choice.',
    expectOk: true,
  },
  {
    name: 'runaway: clear prompt inflated into a spec of questions',
    draft: 'update the placeholder with the new hotkeys',
    optimized:
      'Specify: 1) Which file contains the placeholder? 2) What are the new ' +
      'hotkey values? 3) Is this a doc or code change? 4) What format should ' +
      'they display in? Please provide each so the task can proceed.',
    expectOk: false,
    expectViolations: ['added-questions', 'added-boilerplate'],
  },
  {
    name: 'over-expansion: a one-liner blown up into a paragraph',
    draft: 'bump the version',
    optimized:
      'Increment the semantic version number in the project manifest, update the ' +
      'changelog with a new dated entry summarising the included changes, tag the ' +
      'release in version control, push the tag to the remote, and verify that the ' +
      'continuous integration publish pipeline succeeds end to end before announcing.',
    expectOk: false,
    expectViolations: ['over-expansion'],
  },
  {
    name: 'instruction turned into a question',
    draft: 'rename the user table to accounts',
    optimized: 'Could you clarify which user table you mean and whether to migrate data?',
    expectOk: false,
    expectViolations: ['added-questions', 'added-boilerplate', 'instruction-to-question'],
  },
  {
    name: 'intent drift — rewrite is about something else',
    draft: 'optimise the database connection pooling',
    optimized: 'Write comprehensive unit tests for the authentication module.',
    expectOk: false,
    expectViolations: ['intent-drift'],
  },
  {
    name: 'added list structure to a non-list draft',
    draft: 'improve the error handling in the upload flow',
    optimized: 'Improve upload error handling:\n1. validate size\n2. retry on 5xx\n3. show a toast',
    expectOk: false,
    expectViolations: ['added-list'],
  },
  {
    name: 'draft already a list — keeping the list is fine',
    draft: 'do these:\n1. lint\n2. test\n3. build',
    optimized: 'Run, in order:\n1. lint\n2. test\n3. build',
    expectOk: true,
  },
  {
    name: 'empty rewrite',
    draft: 'refactor the parser',
    optimized: '   ',
    expectOk: false,
    expectViolations: ['empty'],
  },
];
