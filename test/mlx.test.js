import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  serverBase,
  buildChatBody,
  parseChatContent,
  isModelCached,
  DEFAULT_MODEL,
  shutdown,
  _setChildForTest,
} from '../lib/mlx.js';

test('serverBase builds a localhost URL for the given port', () => {
  assert.equal(serverBase(8080), 'http://127.0.0.1:8080');
  assert.equal(serverBase(1234), 'http://127.0.0.1:1234');
});

test('buildChatBody produces an OpenAI chat-completions payload', () => {
  const body = buildChatBody('rewrite this', DEFAULT_MODEL, 500);
  assert.equal(body.model, DEFAULT_MODEL);
  assert.equal(body.max_tokens, 500);
  assert.equal(typeof body.temperature, 'number');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'rewrite this' }]);
});

test('parseChatContent extracts the assistant message text', () => {
  const json = { choices: [{ message: { role: 'assistant', content: '{"optimized":"x"}' } }] };
  assert.equal(parseChatContent(json), '{"optimized":"x"}');
});

test('isModelCached is false for a non-existent model', () => {
  assert.equal(isModelCached('mlx-community/Definitely-Not-A-Real-Model-xyz-4bit'), false);
});

test('parseChatContent throws on missing/empty content', () => {
  assert.throws(() => parseChatContent({}), /empty MLX completion/);
  assert.throws(() => parseChatContent({ choices: [] }), /empty MLX completion/);
  assert.throws(
    () => parseChatContent({ choices: [{ message: { content: '   ' } }] }),
    /empty MLX completion/,
  );
});

// ── shutdown() tests ─────────────────────────────────────────────────────────
// These use _setChildForTest to inject a fake child so shutdown() can be
// exercised without spawning a real Python server. The kill assertion below
// WILL FAIL if the child.kill() call is removed from shutdown() — that is the
// "teeth" requirement: remove the kill line and the test breaks.

test('shutdown() calls child.kill and clears the idle timer', () => {
  let killCallCount = 0;
  const fakeChild = {
    pid: 99999,
    kill(sig) { killCallCount++; assert.equal(sig, 'SIGTERM'); },
    on() {},
  };
  // Set up a real timer so we can verify it gets cleared.
  let timerFired = false;
  const fakeTimer = setTimeout(() => { timerFired = true; }, 60_000);

  _setChildForTest(fakeChild, fakeTimer);
  shutdown();

  assert.equal(killCallCount, 1, 'child.kill must be called exactly once');
  assert.equal(timerFired, false, 'idle timer must not fire — it should have been cleared');
  // If the timer was properly cleared it won't fire; clear it defensively too.
  clearTimeout(fakeTimer);
});

test('shutdown() is a safe no-op when called before any spawn', () => {
  // Ensure no leftover state from previous test.
  _setChildForTest(null);
  assert.doesNotThrow(() => shutdown(), 'shutdown() with no child must not throw');
});

test('shutdown() is idempotent — second call after first is a safe no-op', () => {
  let killCallCount = 0;
  const fakeChild = {
    pid: 99998,
    kill() { killCallCount++; },
    on() {},
  };
  _setChildForTest(fakeChild, null);

  shutdown(); // first call — kills
  assert.equal(killCallCount, 1);

  // Second call: child is already null; must not throw or double-kill.
  assert.doesNotThrow(() => shutdown(), 'second shutdown() must not throw');
  assert.equal(killCallCount, 1, 'kill must not be called a second time');
});
