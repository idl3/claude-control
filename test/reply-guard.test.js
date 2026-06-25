/**
 * test/reply-guard.test.js
 *
 * Unit tests for the reply-guard predicate.
 * These cover the four cases that matter for the server-side safety guard:
 *  1. tailerPending truthy, flagPending false  → must block
 *  2. tailerPending null, flagPending true     → must block (flag-only regression class)
 *  3. both falsy                               → must NOT block
 *  4. tailerPending null, flagPending undefined → must NOT block
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { replyShouldBlock } from '../lib/reply-guard.js';

describe('replyShouldBlock', () => {
  it('blocks when tailerPending is truthy and flagPending is false', () => {
    const tailerPending = { toolUseId: 'tu_abc', question: 'Proceed?' };
    assert.equal(replyShouldBlock(tailerPending, false), true);
  });

  it('blocks when tailerPending is null and flagPending is true', () => {
    // This is the key regression class: the registry flag alone must block.
    assert.equal(replyShouldBlock(null, true), true);
  });

  it('does not block when both tailerPending and flagPending are falsy', () => {
    assert.equal(replyShouldBlock(null, false), false);
  });

  it('does not block when tailerPending is null and flagPending is undefined', () => {
    assert.equal(replyShouldBlock(null, undefined), false);
  });
});
