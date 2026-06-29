import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHELL_KEYS, shellKey, pairHash, pairNames, findSisterPane } from '../lib/shell.js';

test('pairHash is deterministic, 6 lowercase base36 chars, and varies by seed', () => {
  assert.match(pairHash('@5'), /^[a-z0-9]{6}$/);
  assert.equal(pairHash('@5'), pairHash('@5'), 'same seed → same hash');
  assert.notEqual(pairHash('@5'), pairHash('@6'), 'different window → different hash');
});

test('pairNames pairs agent + term windows under one hash', () => {
  const { hash, agentName, termName } = pairNames('@5');
  assert.equal(agentName, `${hash}-agent`);
  assert.equal(termName, `${hash}-term`);
});

test('findSisterPane matches the marked shell pane by term window name only', () => {
  const { termName } = pairNames('@5');
  const panes = [
    { target: '0:1.0', windowName: 'abc123-agent', ccShell: false }, // the agent
    { target: '0:2.0', windowName: termName, ccShell: true }, // the sister shell
    { target: '0:3.0', windowName: termName, ccShell: false }, // same name, not a shell
  ];
  assert.equal(findSisterPane(panes, termName)?.target, '0:2.0');
  // No marked pane → null (forces creation rather than a false reuse).
  assert.equal(findSisterPane([{ target: '0:9.0', windowName: termName, ccShell: false }], termName), null);
});

test('SHELL_KEYS allow-list contains the safe control keys', () => {
  // Widened for the on-screen key bar: arrows, Tab, Esc, paging, and the full
  // C-a..C-z / M-a..M-z range (still a closed allow-list of known tmux tokens).
  for (const k of ['Enter', 'C-c', 'C-d', 'C-z', 'Up', 'Down', 'Tab', 'Escape', 'PPage', 'M-b']) {
    assert.ok(SHELL_KEYS.has(k), `expected ${k} allowed`);
  }
  // Arbitrary / injected strings are never allowed.
  assert.ok(!SHELL_KEYS.has('rm'));
  assert.ok(!SHELL_KEYS.has('x')); // bare letters are not keys
  assert.ok(!SHELL_KEYS.has('C-'));
  assert.ok(!SHELL_KEYS.has(''));
});

test('shellKey rejects a non-allow-listed key before touching tmux', async () => {
  // Signature: shellKey(sessionTarget, cwd, key) — the key is validated first.
  await assert.rejects(() => shellKey('0:1.1', '/tmp', 'rm -rf /'), /key not allowed/);
  await assert.rejects(() => shellKey('0:1.1', '/tmp', 'x'), /key not allowed/);
});
