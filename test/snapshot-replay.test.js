import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSnapshotPromptFrames } from '../lib/snapshot-replay.js';

test('replays the cached scrape prompt so a reload/late-join sees the open question', () => {
  const prompt = { question: 'Pick one', options: [{ key: '1', label: 'A' }, { key: '2', label: 'B' }] };
  const sub = { _lastPrompt: JSON.stringify(prompt), _lastPickerOpen: true };
  const frames = buildSnapshotPromptFrames(sub, '0:3.1');
  assert.deepEqual(frames[0], { type: 'prompt', id: '0:3.1', prompt });
  assert.deepEqual(frames[1], { type: 'picker', id: '0:3.1', open: true });
});

test('no prompt cached → no prompt frame (just picker if open)', () => {
  assert.deepEqual(buildSnapshotPromptFrames({ _lastPrompt: null, _lastPickerOpen: false }, 'x'), []);
  assert.deepEqual(
    buildSnapshotPromptFrames({ _lastPickerOpen: true }, 'x'),
    [{ type: 'picker', id: 'x', open: true }],
  );
});

test('corrupt cached prompt is skipped, not thrown', () => {
  const frames = buildSnapshotPromptFrames({ _lastPrompt: '{not json', _lastPickerOpen: false }, 'x');
  assert.deepEqual(frames, []);
});

test('missing/empty sub is safe', () => {
  assert.deepEqual(buildSnapshotPromptFrames(null, 'x'), []);
  assert.deepEqual(buildSnapshotPromptFrames({}, 'x'), []);
});
