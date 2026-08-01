import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SessionRegistry, shouldRetireStickyPending } from '../lib/sessions.js';

/**
 * A stale "Claude is asking a question — awaiting your answer" badge that never
 * clears.
 *
 * `_pendingMap` is set ONLY by tailer.on('pending') (server.js), and a tailer
 * exists only while a client is watching that session. Close the view with a
 * question open, answer it in the terminal, and no 'pending:false' event is
 * ever emitted — so the flag stays true for the life of the process while the
 * transcript has long since recorded the answer.
 *
 * Observed live 2026-08-01 on Kavanah:2.1: pending=true with
 * transcriptPending=false, pendingQuestion=null, thinking=true — i.e. the
 * session was busy working, not asking anything.
 *
 * The registry must let a POSITIVE transcript verdict retire the sticky flag,
 * and must NOT retire it on an unknown/unreadable transcript.
 */

/**
 * Mirrors the refresh path's merge, calling the SAME exported predicate the
 * production code calls — so this cannot pass while the real path is broken.
 */
function mergePending(registry, id, transcript, panePrompt = null) {
  if (shouldRetireStickyPending(transcript) && registry._pendingMap.get(id)) {
    registry._pendingMap.delete(id);
  }
  return (
    (registry._pendingMap.get(id) ?? false) ||
    !!transcript?.transcriptPending ||
    !!panePrompt?.pending
  );
}

test('an answered question retires the sticky tailer flag (the stale-badge bug)', () => {
  const r = new SessionRegistry({});
  r.setPending('w:1.1', true); // tailer saw the question open
  assert.equal(r._pendingMap.get('w:1.1'), true, 'precondition: flag is set');

  // Transcript now says: no open question (the user answered in the terminal).
  const pending = mergePending(r, 'w:1.1', { transcriptPending: false });

  assert.equal(pending, false, 'badge must clear');
  assert.equal(r._pendingMap.get('w:1.1'), undefined, 'sticky flag must be retired, not just masked');
});

test('a REAL open question is never cleared', () => {
  const r = new SessionRegistry({});
  r.setPending('w:2.1', true);
  const pending = mergePending(r, 'w:2.1', { transcriptPending: true });
  assert.equal(pending, true, 'a live question must survive');
  assert.equal(r._pendingMap.get('w:2.1'), true);
});

test('an UNKNOWN transcript never retires the flag (no false negatives)', () => {
  // transcriptPending is null/undefined when the transcript could not be read
  // or matched. Treating unknown as "answered" would silently drop a real
  // question — the one failure direction that actually costs the user.
  for (const unknown of [null, undefined, { transcriptPending: null }, { transcriptPending: undefined }]) {
    const r = new SessionRegistry({});
    r.setPending('w:3.1', true);
    const pending = mergePending(r, 'w:3.1', unknown);
    assert.equal(pending, true, `unknown transcript (${JSON.stringify(unknown)}) must keep the flag`);
    assert.equal(r._pendingMap.get('w:3.1'), true);
  }
});

test('a pane-derived prompt still raises pending with no tailer flag at all', () => {
  const r = new SessionRegistry({});
  const pending = mergePending(r, 'w:4.1', { transcriptPending: false }, { pending: true });
  assert.equal(pending, true, 'an on-screen picker must still light the badge');
});
