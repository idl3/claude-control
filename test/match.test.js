import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignTranscripts, parseEtime } from '../lib/match.js';

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
