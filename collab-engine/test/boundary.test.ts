import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db.js';
import * as agentsCore from '../src/core/agents.js';
import { declareBoundary, checkBoundary, releaseBoundary, matchesPattern } from '../src/core/boundaries.js';
import type { Clock } from '../src/store/clock.js';

function freshDb(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(dir, 'collab.db');
  const db = openDb(dbPath);
  return { dir, db };
}

function fakeClock(start: number): Clock & { advance: (ms: number) => void; set: (ts: number) => void } {
  let current = start;
  const clock = (() => current) as Clock & { advance: (ms: number) => void; set: (ts: number) => void };
  clock.advance = (ms: number) => {
    current += ms;
  };
  clock.set = (ts: number) => {
    current = ts;
  };
  return clock;
}

test('boundary lease: conflict while active, none after TTL expiry (lazy), none after release', () => {
  const { dir, db } = freshDb('collab-boundary-');
  try {
    const clock = fakeClock(1_000_000);
    agentsCore.register(db, { harness: 'test', agentId: 'a' }, clock);
    agentsCore.register(db, { harness: 'test', agentId: 'b' }, clock);

    // A declares a short-lived lease over src/api/**.
    const declared = declareBoundary(db, { agentId: 'a', paths: ['src/api/**'], ttlSec: 10 }, clock);
    assert.equal(declared.ok, true);
    assert.equal(declared.expiresAt, 1_000_000 + 10_000);

    // B is about to touch a covered concrete path -> conflict.
    const conflictCheck = checkBoundary(db, { paths: ['src/api/users.ts'], agentId: 'b' }, clock);
    assert.equal(conflictCheck.conflicts.length, 1);
    assert.equal(conflictCheck.conflicts[0]!.owner, 'a');
    assert.equal(conflictCheck.conflicts[0]!.boundaryId, declared.boundaryId);

    // A's own check on the same path excludes A's own lease.
    const selfCheck = checkBoundary(db, { paths: ['src/api/users.ts'], agentId: 'a' }, clock);
    assert.equal(selfCheck.conflicts.length, 0);

    // Advance the clock past expiry (lazy expiry: no reaper, enforced at query time).
    clock.advance(11_000);
    const afterExpiry = checkBoundary(db, { paths: ['src/api/users.ts'], agentId: 'b' }, clock);
    assert.equal(afterExpiry.conflicts.length, 0, 'expired lease must not conflict');

    // Re-declare with a longer TTL, then explicitly release -> no conflict either.
    const declared2 = declareBoundary(db, { agentId: 'a', paths: ['src/api/**'], ttlSec: 1000 }, clock);
    const stillConflicts = checkBoundary(db, { paths: ['src/api/users.ts'], agentId: 'b' }, clock);
    assert.equal(stillConflicts.conflicts.length, 1);

    const released = releaseBoundary(db, { agentId: 'a', boundaryId: declared2.boundaryId }, clock);
    assert.equal(released.ok, true);
    const afterRelease = checkBoundary(db, { paths: ['src/api/users.ts'], agentId: 'b' }, clock);
    assert.equal(afterRelease.conflicts.length, 0, 'released lease must not conflict');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('boundary lease: directory-prefix match ("foo/" and "foo/**")', () => {
  const { dir, db } = freshDb('collab-boundary-dir-');
  try {
    const clock = fakeClock(2_000_000);
    agentsCore.register(db, { harness: 'test', agentId: 'a' }, clock);
    declareBoundary(db, { agentId: 'a', paths: ['web/checkout/'] }, clock);

    const covered = checkBoundary(db, { paths: ['web/checkout/cart.tsx', 'web/checkout/nested/deep.tsx'] }, clock);
    assert.equal(covered.conflicts.length, 2);

    const uncovered = checkBoundary(db, { paths: ['web/other/page.tsx'] }, clock);
    assert.equal(uncovered.conflicts.length, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('boundary lease: glob match ("src/**")', () => {
  const { dir, db } = freshDb('collab-boundary-glob-');
  try {
    const clock = fakeClock(3_000_000);
    agentsCore.register(db, { harness: 'test', agentId: 'a' }, clock);
    declareBoundary(db, { agentId: 'a', paths: ['src/**'] }, clock);

    const covered = checkBoundary(db, { paths: ['src/core/tasks.ts'] }, clock);
    assert.equal(covered.conflicts.length, 1);

    const uncovered = checkBoundary(db, { paths: ['docs/readme.md'] }, clock);
    assert.equal(uncovered.conflicts.length, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('matchesPattern: unit coverage of equal / dir-prefix / glob forms', () => {
  assert.equal(matchesPattern('docs/api.md', 'docs/api.md'), true);
  assert.equal(matchesPattern('src/api/users.ts', 'src/api/'), true);
  assert.equal(matchesPattern('src/api/users.ts', 'src/api/**'), true);
  assert.equal(matchesPattern('src/api/users.ts', 'src/**'), true);
  assert.equal(matchesPattern('src/other.ts', 'src/api/**'), false);
  assert.equal(matchesPattern('web/form.tsx', 'web/**'), true);
  assert.equal(matchesPattern('web2/form.tsx', 'web/**'), false);
});
