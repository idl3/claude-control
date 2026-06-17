import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverBase, buildChatBody, parseChatContent, DEFAULT_MODEL } from '../lib/mlx.js';

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

test('parseChatContent throws on missing/empty content', () => {
  assert.throws(() => parseChatContent({}), /empty MLX completion/);
  assert.throws(() => parseChatContent({ choices: [] }), /empty MLX completion/);
  assert.throws(
    () => parseChatContent({ choices: [{ message: { content: '   ' } }] }),
    /empty MLX completion/,
  );
});
