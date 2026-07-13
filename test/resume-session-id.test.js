import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeSessionIdFromArgs } from '../lib/sessions.js';

// UUIDs pulled from real `ps -o args=` output during live diagnosis.
const UUID = 'd026972b-1e35-49ea-8063-0aed3abfa873';

test('resumeSessionIdFromArgs: --resume <uuid>', () => {
  assert.equal(resumeSessionIdFromArgs(`/x/.local/bin/claude --resume ${UUID}`), UUID);
});

test('resumeSessionIdFromArgs: -r <uuid>', () => {
  assert.equal(resumeSessionIdFromArgs(`claude -r ${UUID}`), UUID);
});

test('resumeSessionIdFromArgs: --resume=<uuid>', () => {
  assert.equal(resumeSessionIdFromArgs(`claude --resume=${UUID}`), UUID);
});

test('resumeSessionIdFromArgs: --resume <path/to/uuid.jsonl> (daemon / bg-pty form)', () => {
  const args =
    `/x/ClaudeCode.app/Contents/MacOS/claude --bg-pty-host /tmp/sock -- ` +
    `/x/versions/2.1.202 --resume /Users/e/.claude/projects/-Users-e-Projects-x/${UUID}.jsonl ` +
    `--permission-mode bypassPermissions --model claude-opus-4-8`;
  assert.equal(resumeSessionIdFromArgs(args), UUID);
});

test('resumeSessionIdFromArgs: uppercase uuid is normalised to lowercase', () => {
  assert.equal(resumeSessionIdFromArgs(`claude --resume ${UUID.toUpperCase()}`), UUID);
});

test('resumeSessionIdFromArgs: --resume <non-uuid label> → null (branch/custom name)', () => {
  // Real observed forms: `--resume perf-upgrades`, `--resume ree-cadence-for-olam`.
  assert.equal(resumeSessionIdFromArgs('claude --dangerously-skip-permissions --resume perf-upgrades'), null);
  assert.equal(resumeSessionIdFromArgs('claude --resume ree-cadence-for-olam'), null);
});

test('resumeSessionIdFromArgs: --continue / -c → null (no id in args)', () => {
  assert.equal(resumeSessionIdFromArgs('claude --dangerously-skip-permissions --continue'), null);
  assert.equal(resumeSessionIdFromArgs('claude -c'), null);
});

test('resumeSessionIdFromArgs: fresh session (no resume flag) → null', () => {
  assert.equal(resumeSessionIdFromArgs('claude --model claude-opus-4-8'), null);
  assert.equal(resumeSessionIdFromArgs('/x/.local/bin/claude'), null);
});

test('resumeSessionIdFromArgs: --resume with no value (interactive picker) → null', () => {
  assert.equal(resumeSessionIdFromArgs('claude --resume --verbose'), null);
  assert.equal(resumeSessionIdFromArgs('claude --resume'), null);
});

test('resumeSessionIdFromArgs: --fork-session suppresses the id (fork writes a NEW session)', () => {
  // A forked resume names the PARENT; the pane writes a new file — do not bind to the old id.
  assert.equal(resumeSessionIdFromArgs(`claude --resume ${UUID} --fork-session`), null);
  assert.equal(resumeSessionIdFromArgs(`claude --fork-session --resume=${UUID}`), null);
});

test('resumeSessionIdFromArgs: empty / null / undefined → null', () => {
  assert.equal(resumeSessionIdFromArgs(''), null);
  assert.equal(resumeSessionIdFromArgs(null), null);
  assert.equal(resumeSessionIdFromArgs(undefined), null);
});
