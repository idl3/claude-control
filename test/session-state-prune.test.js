import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionRegistry } from '../lib/sessions.js';

function registry() {
  return new SessionRegistry({
    projectsRoot: '/nonexistent',
    tmux: { listPanes: async () => [], listWindows: async () => [] },
  });
}

test('target state is removed when a pane disappears', () => {
  const reg = registry();
  reg._paneIdentityByTarget.set('0:1.0', '%10');
  reg._thinkingMap.set('0:1.0', true);
  reg._transcriptHintMap.set('0:1.0', { transcriptPath: '/old.jsonl' });

  reg._pruneTargetState([]);

  assert.equal(reg._thinkingMap.has('0:1.0'), false);
  assert.equal(reg._transcriptHintMap.has('0:1.0'), false);
  assert.equal(reg._paneIdentityByTarget.has('0:1.0'), false);
});

test('tmux target reuse clears old transcript hints and status', () => {
  const reg = registry();
  reg._paneIdentityByTarget.set('0:1.0', '%10');
  reg._pendingMap.set('0:1.0', true);
  reg._transcriptHintMap.set('0:1.0', { transcriptPath: '/old.jsonl' });

  reg._pruneTargetState([{ target: '0:1.0', paneId: '%99' }]);

  assert.equal(reg._pendingMap.has('0:1.0'), false);
  assert.equal(reg._transcriptHintMap.has('0:1.0'), false);
  assert.equal(reg._paneIdentityByTarget.get('0:1.0'), '%99');
});

test('transient tmux enumeration failure preserves sessions and target state', async () => {
  const reg = new SessionRegistry({
    projectsRoot: '/nonexistent',
    tmux: {
      listWindows: async () => { throw new Error('tmux socket temporarily unavailable'); },
    },
  });
  const existing = { id: '0:1.0', target: '0:1.0', kind: 'claude' };
  reg._sessions = [existing];
  reg._paneIdentityByTarget.set('0:1.0', '%10');
  reg._thinkingMap.set('0:1.0', true);
  reg._transcriptHintMap.set('0:1.0', { transcriptPath: '/live.jsonl' });

  const result = await reg.refresh();

  assert.strictEqual(result, reg._sessions);
  assert.deepEqual(reg.getSessions(), [existing]);
  assert.equal(reg._thinkingMap.get('0:1.0'), true);
  assert.deepEqual(reg._transcriptHintMap.get('0:1.0'), { transcriptPath: '/live.jsonl' });
  assert.equal(reg._paneIdentityByTarget.get('0:1.0'), '%10');
});
