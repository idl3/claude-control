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

test('title match: same-cwd panes each bind their own transcript by window name', () => {
  const panes = [
    { target: '0:1.1', windowName: 'testing-session', cwd, procStartMs: null },
    { target: '0:2.1', windowName: 'skill-prefix-rules', cwd, procStartMs: null },
  ];
  const candidates = [
    cand({ transcriptPath: '/p/a.jsonl', customTitle: 'skill-prefix-rules' }),
    cand({ transcriptPath: '/p/b.jsonl', customTitle: 'testing-session' }),
  ];
  const out = assignTranscripts(panes, candidates);
  assert.equal(out.get('0:1.1').transcriptPath, '/p/b.jsonl');
  assert.equal(out.get('0:2.1').transcriptPath, '/p/a.jsonl');
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
