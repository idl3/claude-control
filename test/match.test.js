import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignTranscripts, parseEtime, fingerprintScore } from '../lib/match.js';

// ── parseEtime ───────────────────────────────────────────────────────────────

test('parseEtime: mm:ss', () => {
  assert.equal(parseEtime('00:42'), 42);
  assert.equal(parseEtime('05:00'), 300);
});

test('parseEtime: hh:mm:ss', () => {
  assert.equal(parseEtime('01:02:03'), 3723);
});

test('parseEtime: dd-hh:mm:ss', () => {
  assert.equal(parseEtime('2-03:04:05'), (2 * 24 + 3) * 3600 + 4 * 60 + 5);
});

test('parseEtime: invalid → null', () => {
  assert.equal(parseEtime(''), null);
  assert.equal(parseEtime('garbage'), null);
  assert.equal(parseEtime(null), null);
});

// ── assignTranscripts ────────────────────────────────────────────────────────

const cwd = '/Users/ernie/Projects';

function cand(over) {
  return {
    transcriptPath: '/p/x.jsonl',
    cwd,
    birthtimeMs: null,
    mtimeMs: null,
    lastActivityMs: null,
    customTitle: null,
    aiTitle: null,
    ...over,
  };
}

test('start-time match: same-cwd panes each bind their own transcript by birthtime', () => {
  // Title matching is gone; distinct claude process start times disambiguate
  // same-cwd siblings deterministically.
  const panes = [
    { target: '0:1.1', windowName: 'testing-session', cwd, procStartMs: 1000 },
    { target: '0:2.1', windowName: 'skill-prefix-rules', cwd, procStartMs: 5000 },
  ];
  const candidates = [
    cand({ transcriptPath: '/p/a.jsonl', birthtimeMs: 5100, lastActivityMs: 9000 }),
    cand({ transcriptPath: '/p/b.jsonl', birthtimeMs: 1100, lastActivityMs: 9000 }),
  ];
  const out = assignTranscripts(panes, candidates);
  assert.equal(out.get('0:1.1').transcriptPath, '/p/b.jsonl');
  assert.equal(out.get('0:2.1').transcriptPath, '/p/a.jsonl');
});

test('title is IGNORED: a stale transcript whose title matches the window does not win', () => {
  // A window keeping an OLD session's name must not pull in that old transcript.
  // Even with a matching customTitle present, binding is purely by start-time, so
  // the live transcript (born at the pane start) wins.
  const panes = [{ target: '0:2.1', windowName: 'Deploy Plan SPA', cwd, procStartMs: 1_000_000 }];
  const candidates = [
    cand({ transcriptPath: '/p/stale.jsonl', customTitle: 'Deploy Plan SPA', birthtimeMs: 1, lastActivityMs: 500 }),
    cand({ transcriptPath: '/p/live.jsonl', birthtimeMs: 1_000_100, lastActivityMs: 1_005_000 }),
  ];
  const out = assignTranscripts(panes, candidates);
  assert.equal(out.get('0:2.1').transcriptPath, '/p/live.jsonl');
});

test('resumed session binds by recency (born before resume, active after)', () => {
  // A resumed transcript is born long before the new proc start, so the start-time
  // pass rejects it; recency (activity bumped by the resume) recovers it.
  const panes = [{ target: '0:1.1', windowName: 'my-session', cwd, procStartMs: 1_000_000 }];
  const candidates = [
    cand({ transcriptPath: '/p/resumed.jsonl', birthtimeMs: 1, lastActivityMs: 1_002_000 }),
  ];
  const out = assignTranscripts(panes, candidates);
  assert.equal(out.get('0:1.1').transcriptPath, '/p/resumed.jsonl');
});

test('cross-send case: same cwd, no titles → start-time binds 1:1 (NOT swapped)', () => {
  // Two sessions in the same dir. Pane A started earlier than pane B; the
  // transcripts were created at matching times. The reply to B must NOT surface
  // under A. This is the exact regression.
  const panes = [
    { target: '0:1.1', windowName: 'a', cwd, procStartMs: 1000 },
    { target: '0:2.1', windowName: 'b', cwd, procStartMs: 5000 },
  ];
  const candidates = [
    cand({ transcriptPath: '/p/early.jsonl', birthtimeMs: 1100, lastActivityMs: 9000 }),
    cand({ transcriptPath: '/p/late.jsonl', birthtimeMs: 5100, lastActivityMs: 9000 }),
  ];
  const out = assignTranscripts(panes, candidates);
  assert.equal(out.get('0:1.1').transcriptPath, '/p/early.jsonl');
  assert.equal(out.get('0:2.1').transcriptPath, '/p/late.jsonl');
});

test('start-time pass rejects transcripts born long before the process', () => {
  const panes = [{ target: '0:1.1', windowName: 'a', cwd, procStartMs: 1_000_000 }];
  const candidates = [
    // Born and last-active well before the proc started → belongs to an earlier
    // session; the temporal gate in Pass 3 now also excludes it from recency.
    cand({ transcriptPath: '/p/stale.jsonl', birthtimeMs: 1, lastActivityMs: 50 }),
  ];
  const out = assignTranscripts(panes, candidates);
  // Pass 2 rejects it (born too early); Pass 3 also rejects it (active before pane started).
  assert.equal(out.has('0:1.1'), false);
});

test('1:1: a transcript is never assigned to two panes', () => {
  const panes = [
    { target: '0:1.1', windowName: 'a', cwd, procStartMs: null },
    { target: '0:2.1', windowName: 'b', cwd, procStartMs: null },
  ];
  // Only one candidate — second pane gets nothing.
  const candidates = [cand({ transcriptPath: '/p/only.jsonl', lastActivityMs: 100 })];
  const out = assignTranscripts(panes, candidates);
  assert.equal(out.get('0:1.1').transcriptPath, '/p/only.jsonl');
  assert.equal(out.has('0:2.1'), false);
});

test('cwd isolation: a transcript from another dir is never assigned', () => {
  const panes = [{ target: '0:1.1', windowName: 'a', cwd, procStartMs: null }];
  const candidates = [
    cand({ transcriptPath: '/p/other.jsonl', cwd: '/somewhere/else', lastActivityMs: 100 }),
  ];
  const out = assignTranscripts(panes, candidates);
  assert.equal(out.has('0:1.1'), false);
});

test('descendant cwd is consistent (session cd-ed into a subdir)', () => {
  const panes = [{ target: '0:1.1', windowName: 'a', cwd, procStartMs: null }];
  const candidates = [
    cand({
      transcriptPath: '/p/deep.jsonl',
      cwd: '/Users/ernie/Projects/sub/dir',
      lastActivityMs: 100,
    }),
  ];
  const out = assignTranscripts(panes, candidates);
  assert.equal(out.get('0:1.1').transcriptPath, '/p/deep.jsonl');
});

// ── Pass 3 temporal gate (fresh-pane / resume regression) ────────────────────

test('fresh pane with only stale transcripts stays unmatched (the inheritance bug)', () => {
  // Reproduces the reported symptom: brand-new session in /Users/ernie/Projects;
  // every existing transcript in that cwd was last active well before the pane
  // launched (outside the 5-min slack). Recency fallback must NOT bind any of
  // them to the new pane.
  const paneStart = 1_000_000_000; // fixed epoch value
  const slack = 5 * 60_000;        // matches DEFAULT_START_SLACK_MS
  const panes = [{ target: '0:5.1', windowName: 'upgrade-present-skill', cwd, procStartMs: paneStart }];
  const candidates = [
    cand({ transcriptPath: '/p/old1.jsonl', lastActivityMs: paneStart - slack - 60_000 }),
    cand({ transcriptPath: '/p/old2.jsonl', lastActivityMs: paneStart - slack - 30 * 60_000 }),
    cand({ transcriptPath: '/p/old3.jsonl', lastActivityMs: paneStart - slack - 90_000 }),
  ];
  const out = assignTranscripts(panes, candidates);
  assert.equal(out.has('0:5.1'), false, 'fresh pane must not inherit a stale transcript');
});

test('resume case: old transcript touched after pane started still binds (Pass 3)', () => {
  // claude --resume appends to the old file, so its mtime/lastActivityMs becomes
  // recent (after procStartMs). The gate must pass it through.
  const paneStart = 1_000_000;
  const resumeActivity = paneStart + 3_000; // Claude appended ~3 s after launch
  const panes = [{ target: '0:3.1', windowName: 'resumed', cwd, procStartMs: paneStart }];
  const candidates = [
    // No birthtime match (born long ago), but recently written by --resume.
    cand({ transcriptPath: '/p/resumed.jsonl', birthtimeMs: 1, lastActivityMs: resumeActivity }),
  ];
  const out = assignTranscripts(panes, candidates);
  assert.equal(out.get('0:3.1').transcriptPath, '/p/resumed.jsonl', 'resumed transcript must bind');
});

test('unknown procStartMs: recency fallback runs ungated (no regression)', () => {
  // When we cannot determine the pane start time, we must not block the fallback.
  const panes = [{ target: '0:4.1', windowName: 'legacy', cwd, procStartMs: null }];
  const candidates = [
    cand({ transcriptPath: '/p/any.jsonl', lastActivityMs: 100 }),
  ];
  const out = assignTranscripts(panes, candidates);
  assert.equal(out.get('0:4.1').transcriptPath, '/p/any.jsonl', 'must still bind when procStartMs unknown');
});

test('deterministic regardless of pane input order', () => {
  const a = { target: '0:1.1', windowName: 'a', cwd, procStartMs: 1000 };
  const b = { target: '0:2.1', windowName: 'b', cwd, procStartMs: 5000 };
  const candidates = [
    cand({ transcriptPath: '/p/early.jsonl', birthtimeMs: 1100, lastActivityMs: 1 }),
    cand({ transcriptPath: '/p/late.jsonl', birthtimeMs: 5100, lastActivityMs: 1 }),
  ];
  const out1 = assignTranscripts([a, b], candidates);
  const out2 = assignTranscripts([b, a], candidates);
  assert.equal(out1.get('0:1.1').transcriptPath, out2.get('0:1.1').transcriptPath);
  assert.equal(out1.get('0:2.1').transcriptPath, out2.get('0:2.1').transcriptPath);
});

// ── projectDir scoping: parent pane must NOT steal a child worktree's transcript

test('worktree: a parent-dir pane does not steal a child worktree transcript', () => {
  // window 3 (olam-doctor-fix) launched in /p/repo; window 4 (greptile) in a
  // worktree /p/repo/wt/greptile. Recorded cwds make greptile look like a
  // descendant of repo — but projectDir scoping keeps each to its own slug.
  const panes = [
    { target: '0:3.1', windowName: 'olam-doctor-fix', cwd: '/p/repo', projectDir: '-p-repo', procStartMs: 1000 },
    { target: '0:4.1', windowName: 'greptile', cwd: '/p/repo/wt/greptile', projectDir: '-p-repo-wt-greptile', procStartMs: 1000 },
  ];
  const candidates = [
    cand({ transcriptPath: '/x/repo.jsonl', cwd: '/p/repo', projectDir: '-p-repo', birthtimeMs: 1100, lastActivityMs: 5000 }),
    cand({ transcriptPath: '/x/greptile.jsonl', cwd: '/p/repo/wt/greptile', projectDir: '-p-repo-wt-greptile', birthtimeMs: 1100, lastActivityMs: 9000 }),
  ];
  const out = assignTranscripts(panes, candidates);
  assert.equal(out.get('0:3.1').transcriptPath, '/x/repo.jsonl');      // its OWN, not the more-active greptile
  assert.equal(out.get('0:4.1').transcriptPath, '/x/greptile.jsonl');  // recovered
});

// ── resume regression: recency beats a coincidental start-time match ─────────

test('resumed session: most-active transcript wins over a freshly-born sibling', () => {
  // The reported bug: this pane RESUMED at ~T (proc start T); its real transcript
  // was born long before T but is active NOW. A different short session was born
  // at ~T (birth coincides with the resume) and died immediately. Recency must
  // bind the active transcript, not the stale birth-coincident one.
  const T = 1_000_000_000;
  const panes = [{ target: '0:1.1', windowName: 'testing-session', cwd, procStartMs: T }];
  const candidates = [
    cand({ transcriptPath: '/p/resumed.jsonl', birthtimeMs: 1, lastActivityMs: T + 60 * 60_000 }), // old birth, LIVE
    cand({ transcriptPath: '/p/coincident.jsonl', birthtimeMs: T, lastActivityMs: T + 1000 }),       // born at resume, dead
  ];
  const out = assignTranscripts(panes, candidates);
  assert.equal(out.get('0:1.1').transcriptPath, '/p/resumed.jsonl');
});

// ── PLE-41: content-fingerprint tiebreak ─────────────────────────────────────

// fingerprintScore unit tests
test('fingerprintScore: returns 0 when either side is empty/null', () => {
  assert.equal(fingerprintScore(null, 'hello world'), 0);
  assert.equal(fingerprintScore('hello world', null), 0);
  assert.equal(fingerprintScore('', 'hello world'), 0);
  assert.equal(fingerprintScore('hello world', ''), 0);
});

test('fingerprintScore: counts distinct ≥4-char word token overlaps', () => {
  const pane = 'fixing authentication middleware request handler';
  const transcript = 'authentication middleware implemented fixing handler and other words';
  // overlapping ≥4-char tokens: fixing(6), authentication(14), middleware(10), request(7), handler(7) = 5
  // but 'request' not in transcript → 4 overlapping: fixing, authentication, middleware, handler
  const score = fingerprintScore(pane, transcript);
  assert.ok(score >= 3, `expected ≥3 overlap, got ${score}`);
});

test('fingerprintScore: case-insensitive matching', () => {
  const score = fingerprintScore('AUTHENTICATION Request', 'authentication request handler');
  assert.ok(score >= 1, 'case-folded match should score > 0');
});

test('fingerprintScore: ignores short words (<4 chars)', () => {
  // "is", "an", "the", "for" are all <4 chars
  assert.equal(fingerprintScore('is an the for', 'is an the for'), 0);
});

// Regression test for PLE-41: same-cwd sessions mis-bind when procStartMs is
// unknown and lastActivityMs values are identical (timing signals produce a tie).
// The content-fingerprint tiebreak must pick the candidate whose recentText
// overlaps the pane's capturedText.
//
// This test FAILS against the original match.js (before the fingerprint tiebreak)
// because prefer() falls through to (ca > ba) which is (0 > 0) = false — meaning
// the first candidate in iteration order always wins, regardless of which is correct.
test('PLE-41 regression: content-fingerprint tiebreak resolves same-cwd ambiguity when timing is tied', () => {
  // Two sessions in the same cwd. procStartMs unknown, identical lastActivityMs.
  // The timing-based prefer() cannot tell them apart.
  const paneText = 'implementing authentication middleware for the REST API endpoint validation logic';
  const wrongText = 'refactoring database migration scripts and schema updates for postgres tables';
  const rightText = 'building authentication middleware handler implementing request validation endpoint';

  const panes = [
    {
      target: '0:1.1',
      windowName: 'session-a',
      cwd,
      procStartMs: null,          // unknown — no ps data available
      capturedText: paneText,     // pane shows auth/middleware work
    },
  ];

  // wrongText first so the pre-fix code would pick it (it's the first-encountered
  // when prefer() always returns false, leaving best = first candidate).
  const candidates = [
    cand({
      transcriptPath: '/p/wrong.jsonl',
      lastActivityMs: 5000,
      birthtimeMs: 4000,
      recentText: wrongText,      // database work — no overlap with pane
    }),
    cand({
      transcriptPath: '/p/right.jsonl',
      lastActivityMs: 5000,       // identical — timing cannot distinguish
      birthtimeMs: 4000,
      recentText: rightText,      // auth/middleware work — matches pane
    }),
  ];

  const out = assignTranscripts(panes, candidates);

  // With the fingerprint tiebreak: right.jsonl wins (higher overlap score).
  // Without it (old code): wrong.jsonl wins (first-encountered, prefer() = false).
  assert.equal(
    out.get('0:1.1').transcriptPath,
    '/p/right.jsonl',
    'fingerprint tiebreak must bind the candidate whose text overlaps the pane capture',
  );
});

test('PLE-41: fingerprint tiebreak is a NO-OP when capturedText is absent (preserves existing behavior)', () => {
  // No capturedText on pane → tiebreak must not fire; falls back to ca > ba.
  // Here both activities are equal so first-wins (order-stable) applies — same as before.
  const panes = [
    { target: '0:1.1', windowName: 'a', cwd, procStartMs: null },
  ];
  const candidates = [
    cand({ transcriptPath: '/p/first.jsonl', lastActivityMs: 5000, recentText: 'authentication middleware' }),
    cand({ transcriptPath: '/p/second.jsonl', lastActivityMs: 5000, recentText: 'database tables migration' }),
  ];
  const out = assignTranscripts(panes, candidates);
  // Should still produce A result (not throw / not return undefined).
  assert.ok(out.has('0:1.1'), 'must still bind a candidate when capturedText is absent');
});

test('PLE-41: fingerprint tiebreak is a NO-OP when recentText is absent on candidates', () => {
  // Candidates without recentText → tiebreak does not fire.
  const panes = [
    { target: '0:1.1', windowName: 'a', cwd, procStartMs: null, capturedText: 'authentication middleware' },
  ];
  const candidates = [
    cand({ transcriptPath: '/p/a.jsonl', lastActivityMs: 5000 }), // no recentText
    cand({ transcriptPath: '/p/b.jsonl', lastActivityMs: 5000 }), // no recentText
  ];
  const out = assignTranscripts(panes, candidates);
  assert.ok(out.has('0:1.1'), 'must still bind a candidate when recentText is absent');
});

test('PLE-41: fingerprint tiebreak only fires when score difference meets minimum threshold', () => {
  // Both candidates have slight overlap with the pane; neither clears FINGERPRINT_MIN_OVERLAP
  // advantage over the other. Should fall back to order-stable selection.
  const panes = [
    {
      target: '0:1.1',
      windowName: 'a',
      cwd,
      procStartMs: null,
      capturedText: 'some common words here',
    },
  ];
  const candidates = [
    cand({ transcriptPath: '/p/a.jsonl', lastActivityMs: 5000, recentText: 'some common words here mentioned' }),
    cand({ transcriptPath: '/p/b.jsonl', lastActivityMs: 5000, recentText: 'some common words here also' }),
  ];
  const out = assignTranscripts(panes, candidates);
  // Both score identically (same overlap) — should not crash, should return one result.
  assert.ok(out.has('0:1.1'), 'must not crash when fingerprint scores are equal');
});
