import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePanePrompt } from '../lib/prompt.js';

// The AskUserQuestion picker renders each option as a header line PLUS a wrapped
// description line, so the numbered options are NOT contiguous. Detection must
// still stitch them into a 1..N menu (regression: it previously collapsed to a
// single option and returned null, so the question never surfaced → "hung").
const MULTILINE = `\
some earlier prose output here
qualify the plan and proceed independently.

How should I sequence this 5-service build?
❯ 1. Build all 3 phases now
     I build the genuinely-new build first — biggest value, no config dep.
  2. Skill-routing (P3) first
     Start with the unmanaged side, add webhooks after.
  3. Activate webhooks (P1+P2)
     Wire the gateway glue + secrets, then reconfigure.
  4. Type something
Enter to select · ↑/↓ to navigate · Esc to cancel
`;

test('parsePanePrompt stitches multi-line AskUserQuestion options into a menu', () => {
  const r = parsePanePrompt(MULTILINE);
  assert.ok(r, 'expected a prompt to be detected');
  assert.equal(r.options.length, 4);
  assert.deepEqual(r.options.map((o) => o.key), ['1', '2', '3', '4']);
  assert.equal(r.options[0].selected, true); // ❯ cursor on option 1
  assert.match(r.question, /sequence this 5-service build/);
});

// Plain numbered prose (no ❯ cursor, no Esc footer) must NOT pop a modal.
const PROSE = `\
Here is my plan:
1. Do the first thing
2. Then the second thing
3. Finally the third
That's the whole approach.
`;

test('parsePanePrompt ignores numbered prose without an interactive signal', () => {
  assert.equal(parsePanePrompt(PROSE), null);
});

// Long option descriptions push options 1–2 off the top of the capture, so only
// 3,4,5,6 are visible. Detection must NOT require a "1." anchor — the bottom-most
// consecutive run + cursor/Esc footer is enough. (Regression: a real question
// silently failed to surface.)
const OFFSCREEN_START = `\
  2. Deploy then re-delegate
     A long description of option two that wraps onto another line here.
  3. Merge the converged set
     Merge the ready PRs to realize the value before opening more work.
❯ 4. Subscribe GH App events
     Flip on pull_request_review / issue_comment so convergence runs realtime.
  5. Type something
     Submit
  6. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
`;

test('parsePanePrompt detects a picker whose option 1 scrolled off-screen', () => {
  const r = parsePanePrompt(OFFSCREEN_START);
  assert.ok(r, 'expected the picker to be detected without a visible "1."');
  assert.deepEqual(r.options.map((o) => o.key), ['2', '3', '4', '5', '6']);
  assert.equal(r.options.find((o) => o.key === '4')?.selected, true);
});

// A TALL AskUserQuestion — question + 5 options each with a multi-line
// description + footer, preceded by prose — exceeds the OLD 26-line window, so
// the question + options 1–2 used to scroll out (modal showed only 3,4,5 and a
// description fragment as the "question"). With the larger window the whole
// picker is in view: all 5 options survive and the real question is recovered.
const TALL_PICKER = `\
recovery did an unscoped git add that swept vendor/bundle (gem caches + vendored
.rb) into the commit. Greptile refuses to review it (500-file cap), so the loop
can never touch it. A guard (git reset -- vendor/bundle) already exists for new
runs; #5711 is a pre-guard artifact. It needs a human call:
filler line a
filler line b
filler line c
filler line d
filler line e
filler line f
filler line g
filler line h
filler line i
filler line j
filler line k

#5711 (linear-agent: finalize stranded edits) is a runaway — 3.16M additions / 3000+ files from an unscoped git add that swept vendor/bundle. Greptile won't review it (500-file cap), so the loop can't converge it. What do you want?

❯ 1. Close it
     Abandon #5711 — it's a pre-guard artifact polluted with 3M lines of vendored gems.
  2. Rescope + salvage
     Have the agent reset vendor/bundle out of the branch, keep only the real edits.
  3. Leave for manual review
     Don't touch it from the loop. Flag it for a human to inspect the 3M-line diff.
  4. Type something.
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
`;

test('parsePanePrompt: tall picker keeps ALL 5 options and the real question', () => {
  assert.ok(TALL_PICKER.split('\n').length > 26, 'fixture must exceed the old window');
  const r = parsePanePrompt(TALL_PICKER);
  assert.ok(r, 'expected the tall picker to be detected');
  assert.deepEqual(r.options.map((o) => o.key), ['1', '2', '3', '4', '5'], 'all 5 options survive');
  assert.equal(r.options[0].label, 'Close it');
  assert.equal(r.options[0].selected, true, '❯ cursor on option 1');
  assert.match(r.question, /#5711.*runaway/, 'question is the real question, not a description fragment');
  assert.doesNotMatch(r.question, /vendor\/bundle out of the branch/, 'question must NOT be an option description');
});

// ── Multi-select checkbox detection ──────────────────────────────────────────

// Realistic capture of a multi-select AskUserQuestion picker ([ ]/[x] markers).
// The ❯ cursor marks which row is highlighted, and the Esc footer is the
// interactive-prompt signal.
const MULTI_SELECT = `\
What skills should I activate?
❯ 1. [ ] /100x:plan-hard
  2. [ ] Verify change impact
  3. [x] Run tests
  4. [ ] Update docs
Enter to select · ↑/↓ to navigate · Esc to cancel
`;

test('parsePanePrompt detects multi-select checkboxes: multiSelect=true, labels stripped, checked correct', () => {
  const r = parsePanePrompt(MULTI_SELECT);
  assert.ok(r, 'expected a prompt to be detected');
  assert.equal(r.multiSelect, true, 'multiSelect must be true for checkbox options');
  assert.equal(r.options.length, 4);
  // Labels must have the bracket marker stripped.
  assert.equal(r.options[0].label, '/100x:plan-hard');
  assert.equal(r.options[1].label, 'Verify change impact');
  assert.equal(r.options[2].label, 'Run tests');
  assert.equal(r.options[3].label, 'Update docs');
  // checked state: only option 3 has [x].
  assert.equal(r.options[0].checked, false, 'option 1 [ ] → checked=false');
  assert.equal(r.options[1].checked, false, 'option 2 [ ] → checked=false');
  assert.equal(r.options[2].checked, true,  'option 3 [x] → checked=true');
  assert.equal(r.options[3].checked, false, 'option 4 [ ] → checked=false');
  // selected (cursor) state: ❯ on option 1.
  assert.equal(r.options[0].selected, true);
});

// Variant with ✓ checkmark (Claude Code also uses this).
const MULTI_SELECT_CHECKMARK = `\
Choose actions:
  1. [✓] Deploy to staging
❯ 2. [ ] Run smoke tests
  3. [✗] Skip linting
Enter to select · ↑/↓ to navigate · Esc to cancel
`;

test('parsePanePrompt handles [✓] and [✗] checkbox variants', () => {
  const r = parsePanePrompt(MULTI_SELECT_CHECKMARK);
  assert.ok(r);
  assert.equal(r.multiSelect, true);
  assert.equal(r.options[0].checked, true,  '[✓] → checked=true');
  assert.equal(r.options[1].checked, false, '[ ] → checked=false');
  assert.equal(r.options[2].checked, true,  '[✗] → checked=true');
});

// ── Regression: single-select still parses identically (no multiSelect, labels unchanged) ──

test('parsePanePrompt single-select unchanged: no multiSelect field, labels as-is', () => {
  // Reuse the existing MULTILINE single-select capture (no [ ] markers).
  const r = parsePanePrompt(MULTILINE);
  assert.ok(r);
  assert.equal(r.multiSelect, undefined, 'single-select must NOT have multiSelect');
  // Labels must be unchanged — no bracket stripping on plain options.
  assert.equal(r.options[0].label, 'Build all 3 phases now');
  assert.equal(r.options[1].label, 'Skill-routing (P3) first');
  // No checked field on single-select options.
  assert.equal(r.options[0].checked, undefined);
});
