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
    // Born ages before the proc started → not this session's; recency picks it
    // up only in the fallback pass (there is nothing else here).
    cand({ transcriptPath: '/p/stale.jsonl', birthtimeMs: 1, lastActivityMs: 50 }),
  ];
  const out = assignTranscripts(panes, candidates);
  // Falls through start-time pass, then recency claims it (only candidate).
  assert.equal(out.get('0:1.1').transcriptPath, '/p/stale.jsonl');
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
