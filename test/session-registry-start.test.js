import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionRegistry } from '../lib/sessions.js';

test('SessionRegistry.start() is idempotent and does not duplicate polling intervals', () => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const timers = [];

  globalThis.setInterval = (fn, ms, ...args) => {
    const timer = {
      fn,
      ms,
      args,
      cleared: false,
      unrefCalled: false,
      unref() {
        this.unrefCalled = true;
      },
    };
    timers.push(timer);
    return timer;
  };
  globalThis.clearInterval = (timer) => {
    if (timer) timer.cleared = true;
  };

  try {
    const reg = new SessionRegistry({
      projectsRoot: '/definitely/not/a/real/projects/root',
      tmux: {
        listWindows: async () => [],
        isValidTarget: () => false,
      },
    });
    reg.refresh = async () => [];
    reg._pollCtx = async () => {};
    reg._pollThinking = async () => {};

    reg.start();
    reg.start();

    assert.equal(timers.length, 3, 'refresh, ctx, and thinking intervals should be armed once each');
    assert.equal(timers.filter((t) => t.unrefCalled).length, 3, 'all timers should be unref()ed');

    reg.stop();
    assert.equal(timers.filter((t) => t.cleared).length, 3, 'stop() should clear every armed interval');
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});
