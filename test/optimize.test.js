import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rulesOptimize, optimizePrompt } from '../lib/optimize.js';

// ---------------------------------------------------------------------------
// rulesOptimize — shape
// ---------------------------------------------------------------------------

test('rulesOptimize returns correct shape for a vague draft', () => {
  const result = rulesOptimize('tell me stuff about dogs');
  assert.equal(typeof result.optimized, 'string');
  assert.ok(result.optimized.length > 0);
  assert(Array.isArray(result.rationale));
  assert(Array.isArray(result.changes));
  assert.equal(result.mode, 'rules');
});

test('rulesOptimize returns correct shape for a well-structured draft', () => {
  const draft = [
    'List the top 5 JavaScript frameworks for 2024.',
    'Output format: JSON array.',
    'Constraints: include only frameworks with >10k GitHub stars.',
    'Context: I am building a comparison tool for developers.',
  ].join(' ');
  const result = rulesOptimize(draft);
  assert.equal(typeof result.optimized, 'string');
  assert(Array.isArray(result.rationale));
  assert(Array.isArray(result.changes));
  assert.equal(result.mode, 'rules');
  // A well-structured draft should have fewer or no missing-structure changes
  const missingOutputFormat = result.changes.some((c) => /output format/i.test(c));
  const missingConstraints = result.changes.some((c) => /constraint/i.test(c));
  assert.equal(missingOutputFormat, false, 'should not flag missing output format');
  assert.equal(missingConstraints, false, 'should not flag missing constraints');
});

// ---------------------------------------------------------------------------
// rulesOptimize — whitespace normalization and filler stripping
// ---------------------------------------------------------------------------

test('rulesOptimize strips filler lead-in and collapses whitespace', () => {
  const result = rulesOptimize('please can you   foo the bar');
  // After filler strip "please can you" is removed → starts with "foo"
  assert.ok(
    result.optimized.toLowerCase().includes('foo'),
    `Expected "foo" in optimized, got: ${result.optimized}`,
  );
  // Should NOT start with "please" or "can you"
  assert.ok(
    !/^please/i.test(result.optimized),
    `Should not start with "please": ${result.optimized}`,
  );
  assert.ok(
    !/^can you/i.test(result.optimized),
    `Should not start with "can you": ${result.optimized}`,
  );
  // Multiple spaces in "can you   foo" should be collapsed
  assert.ok(!/  /.test(result.optimized), 'Should have no double-spaces in output');
});

test('rulesOptimize strips "i want you to" filler', () => {
  const result = rulesOptimize('i want you to write a poem');
  assert.ok(!/^i want you to/i.test(result.optimized));
});

test('rulesOptimize strips "i need you to" filler', () => {
  const result = rulesOptimize('i need you to summarize this text');
  assert.ok(!/^i need you to/i.test(result.optimized));
});

test('rulesOptimize does not mutate the input string', () => {
  const input = 'please fix my code';
  const original = input;
  rulesOptimize(input);
  assert.equal(input, original);
});

// ---------------------------------------------------------------------------
// optimizePrompt — LLM pass with mock complete
// ---------------------------------------------------------------------------

test('optimizePrompt with valid JSON mock → mode:llm, parsed fields', async () => {
  const envelope = JSON.stringify({
    optimized: 'Rewritten prompt text.',
    rationale: ['clarity improved'],
    changes: ['added specificity'],
  });
  const mockComplete = async (_prompt) => envelope;

  const result = await optimizePrompt('fix my stuff', { complete: mockComplete });
  assert.equal(result.mode, 'llm');
  assert.equal(result.optimized, 'Rewritten prompt text.');
  assert.deepEqual(result.rationale, ['clarity improved']);
  assert.deepEqual(result.changes, ['added specificity']);
});

test('optimizePrompt with JSON wrapped in prose/fences → still parses', async () => {
  const mockComplete = async (_prompt) =>
    'Here is the result:\n```json\n{"optimized":"Better prompt.","rationale":["r1"],"changes":["c1"]}\n```';

  const result = await optimizePrompt('some draft', { complete: mockComplete });
  assert.equal(result.mode, 'llm');
  assert.equal(result.optimized, 'Better prompt.');
  assert.deepEqual(result.rationale, ['r1']);
  assert.deepEqual(result.changes, ['c1']);
});

test('optimizePrompt with garbage non-JSON → falls back to mode:rules', async () => {
  const mockComplete = async (_prompt) => 'this is not json at all!!!';

  const result = await optimizePrompt('some draft', { complete: mockComplete });
  assert.equal(result.mode, 'rules');
});

test('optimizePrompt with missing optimized field → falls back to mode:rules', async () => {
  const mockComplete = async (_prompt) => JSON.stringify({ rationale: [], changes: [] });

  const result = await optimizePrompt('some draft', { complete: mockComplete });
  assert.equal(result.mode, 'rules');
});

test('optimizePrompt with throwing mock → falls back to mode:rules', async () => {
  const mockComplete = async (_prompt) => {
    throw new Error('network failure');
  };

  const result = await optimizePrompt('some draft', { complete: mockComplete });
  assert.equal(result.mode, 'rules');
});

// ---------------------------------------------------------------------------
// optimizePrompt — no complete function
// ---------------------------------------------------------------------------

test('optimizePrompt with no complete → mode:rules', async () => {
  const result = await optimizePrompt('some draft');
  assert.equal(result.mode, 'rules');
});

test('optimizePrompt with non-function complete → mode:rules', async () => {
  const result = await optimizePrompt('some draft', { complete: 'not a function' });
  assert.equal(result.mode, 'rules');
});

// ── isRunawayRewrite — guard against weak-model over-expansion ───────────────

test('isRunawayRewrite: flags a short prompt inflated into a spec of questions', async () => {
  const { isRunawayRewrite } = await import('../lib/optimize.js');
  const draft = 'update the placeholder with the new hotkeys';
  const runaway =
    'Specify: 1) Which file contains the placeholder? 2) What are the new values? ' +
    '3) Is this a doc or code change? 4) What format should they display in?';
  assert.equal(isRunawayRewrite(draft, runaway), true);
});

test('isRunawayRewrite: allows a clear, lightly-edited rewrite', async () => {
  const { isRunawayRewrite } = await import('../lib/optimize.js');
  assert.equal(
    isRunawayRewrite('fix the typo in the readme', 'Fix the typo in the README.'),
    false,
  );
});

test('optimizePrompt: falls back to rules when the LLM over-expands', async () => {
  const draft = 'update the placeholder with the new hotkeys';
  const complete = async () =>
    JSON.stringify({
      optimized:
        'Specify: 1) Which file? 2) What values? 3) Doc or code? 4) What display format? ' +
        'Please provide each of these so the task can proceed correctly and completely.',
      rationale: ['x'],
      changes: ['y'],
    });
  const result = await optimizePrompt(draft, { complete });
  assert.equal(result.mode, 'rules'); // runaway rejected → conservative fallback
});
