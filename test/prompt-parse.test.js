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
