import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTuiLaunchCommand, matchesProcess } from '../lib/codewhale.js';
import { shellQuoteName } from '../lib/tmux.js';

test('matches a direct CodeWhale executable and common argv paths', () => {
  assert.equal(matchesProcess('/opt/homebrew/bin/codewhale', ''), true);
  assert.equal(matchesProcess('codewhale', 'codewhale --skip-onboarding'), true);
  assert.equal(matchesProcess('node', '/usr/local/bin/codewhale --model deepseek'), true);
  assert.equal(matchesProcess('zsh', '-zsh'), false);
  assert.equal(matchesProcess('rg', 'rg codewhale'), false);
  assert.equal(matchesProcess('node', 'node /tmp/not-codewhale codewhale'), false);
});

test('builds the configured TUI launch command without a prompt', () => {
  assert.equal(buildTuiLaunchCommand({ command: 'codewhale', quote: shellQuoteName }), 'codewhale');
  assert.equal(buildTuiLaunchCommand({ command: 'cw --skip-onboarding', quote: shellQuoteName }), 'cw --skip-onboarding');
});

test('quotes a multiline or dash-prefixed initial prompt after --', () => {
  assert.equal(
    buildTuiLaunchCommand({ command: 'codewhale', prompt: "- fix it\nthen test", quote: shellQuoteName }),
    "codewhale -- '- fix it\nthen test'",
  );
});
