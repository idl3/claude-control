import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveArchived, ARCHIVED_STATUSES } from '../lib/olam-archive.js';

// --- deriveArchived -------------------------------------------------------------

test('deriveArchived: halted session is archived', () => {
  assert.equal(deriveArchived({ halted: true }), true);
});

test('deriveArchived: phase done is archived', () => {
  assert.equal(deriveArchived({ phase: 'done' }), true);
});

test('deriveArchived: prMerged flag is archived', () => {
  assert.equal(deriveArchived({ prMerged: true }), true);
});

test('deriveArchived: active session (no terminal signal) is not archived', () => {
  assert.equal(deriveArchived({ halted: false, phase: 'running', planStatus: 'approved' }), false);
});

test('deriveArchived: unknown/absent status fails open (not archived)', () => {
  assert.equal(deriveArchived({}), false);
  assert.equal(deriveArchived({ planStatus: 'in_progress' }), false);
});

test('deriveArchived: non-object input never throws', () => {
  assert.equal(deriveArchived(null), false);
  assert.equal(deriveArchived(undefined), false);
  assert.equal(deriveArchived('nope'), false);
});

for (const status of ARCHIVED_STATUSES) {
  test(`deriveArchived: planStatus "${status}" (any case) is archived`, () => {
    assert.equal(deriveArchived({ planStatus: status }), true);
    assert.equal(deriveArchived({ planStatus: status.toUpperCase() }), true);
  });

  test(`deriveArchived: status "${status}" is archived`, () => {
    assert.equal(deriveArchived({ status }), true);
  });

  test(`deriveArchived: linearState "${status}" is archived`, () => {
    assert.equal(deriveArchived({ linearState: status }), true);
  });
}

test('deriveArchived: prState "merged" is archived', () => {
  assert.equal(deriveArchived({ prState: 'merged' }), true);
});

test('deriveArchived: truthy closed/cancelled/archived/merged booleans are archived', () => {
  assert.equal(deriveArchived({ closed: true }), true);
  assert.equal(deriveArchived({ cancelled: true }), true);
  assert.equal(deriveArchived({ canceled: true }), true);
  assert.equal(deriveArchived({ archived: true }), true);
  assert.equal(deriveArchived({ merged: true }), true);
});

test('deriveArchived: truthy timestamp fields (closedAt etc) are archived', () => {
  assert.equal(deriveArchived({ closedAt: '2026-07-01T00:00:00Z' }), true);
  assert.equal(deriveArchived({ mergedAt: '2026-07-01T00:00:00Z' }), true);
  assert.equal(deriveArchived({ archivedAt: '2026-07-01T00:00:00Z' }), true);
});

test('deriveArchived: false/null timestamp fields do not trip truthy check', () => {
  assert.equal(deriveArchived({ closedAt: null, mergedAt: false }), false);
});
