import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadPins, savePins, validateTranscriptPath, pinKey, pinPath, pinTs, makePin, pinPaths } from '../lib/pins.js';
import { isPinSuperseded } from '../lib/sessions.js';

test('pinKey is windowId.paneIndex', () => {
  assert.equal(pinKey('@5', 1), '@5.1');
  assert.equal(pinKey('@0', 0), '@0.0');
  assert.equal(pinKey('@7'), '@7.0');
});

test('save then load round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pins-'));
  const file = path.join(dir, 'pins.json');
  const pins = { '@5.1': '/p/a.jsonl', '@9.0': '/p/b.jsonl' };
  savePins(file, pins);
  assert.deepEqual(loadPins(file), pins);
});

test('loadPins tolerates missing / malformed', () => {
  assert.deepEqual(loadPins('/no/such/file.json'), {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pins-'));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ not json');
  assert.deepEqual(loadPins(bad), {});
  const arr = path.join(dir, 'arr.json');
  fs.writeFileSync(arr, '[1,2]');
  assert.deepEqual(loadPins(arr), {}); // arrays rejected
});

test('validateTranscriptPath confines to projectsRoot + requires .jsonl + existing file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proj-'));
  const good = path.join(root, 'sess.jsonl');
  fs.writeFileSync(good, '{}');
  assert.equal(validateTranscriptPath(good, root), good);
  // wrong extension
  const txt = path.join(root, 'sess.txt');
  fs.writeFileSync(txt, 'x');
  assert.equal(validateTranscriptPath(txt, root), null);
  // outside root
  assert.equal(validateTranscriptPath('/etc/passwd', root), null);
  // traversal
  assert.equal(validateTranscriptPath(`${root}/../x.jsonl`, root), null);
  // nonexistent
  assert.equal(validateTranscriptPath(path.join(root, 'nope.jsonl'), root), null);
  // non-string
  assert.equal(validateTranscriptPath(null, root), null);
});

test('validateTranscriptPath allows any configured root + rejects escapes', () => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rootA-'));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rootB-'));
  const goodA = path.join(rootA, 'a.jsonl');
  fs.writeFileSync(goodA, '{}');
  const goodB = path.join(rootB, 'b.jsonl');
  fs.writeFileSync(goodB, '{}');

  assert.equal(validateTranscriptPath(goodA, [rootA, rootB]), goodA);
  assert.equal(validateTranscriptPath(goodB, [rootA, rootB]), goodB);

  // Reject: exists, but outside ALL configured roots.
  const rootC = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rootC-'));
  const outside = path.join(rootC, 'c.jsonl');
  fs.writeFileSync(outside, '{}');
  assert.equal(validateTranscriptPath(outside, [rootA, rootB]), null);

  // Reject traversal.
  assert.equal(validateTranscriptPath(path.join(rootA, '..', 'x.jsonl'), [rootA]), null);

  // Reject symlink escape: a symlink INSIDE rootA pointing to a file OUTSIDE
  // all roots must not be confined by lexical prefix alone.
  const secret = path.join(rootC, 'secret.jsonl');
  fs.writeFileSync(secret, '{}');
  const evilLink = path.join(rootA, 'evil.jsonl');
  try {
    fs.symlinkSync(secret, evilLink);
    assert.equal(validateTranscriptPath(evilLink, [rootA]), null);
  } catch {
    // symlink unsupported on this FS/runner — skip gracefully, nothing to assert
  }

  // Reject sibling-prefix: allow-list is [<base>/pa]; request a real .jsonl
  // under <base>/pa-evil/ — a naive string-prefix check would wrongly accept.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-prefix-'));
  const pa = path.join(base, 'pa');
  fs.mkdirSync(pa, { recursive: true });
  const paEvil = path.join(base, 'pa-evil');
  fs.mkdirSync(paEvil, { recursive: true });
  const sneaky = path.join(paEvil, 'sneaky.jsonl');
  fs.writeFileSync(sneaky, '{}');
  assert.equal(validateTranscriptPath(sneaky, [pa]), null);

  // Back-compat: single-string root still works, with array-vs-string parity.
  assert.equal(validateTranscriptPath(goodA, rootA), goodA);
  assert.equal(validateTranscriptPath(goodA, rootA), validateTranscriptPath(goodA, [rootA]));
});

// ── pin timestamps + supersession ────────────────────────────────────────────
// A pin overrides the heuristic matcher, not the SessionStart hook. When a
// pinned pane starts a NEW session the hook records a different transcript for
// the same %N; without expiry the pin keeps the cockpit showing the dead one.

test('pinPath/pinTs accept both the legacy string and the timestamped form', () => {
  assert.equal(pinPath('/p/a.jsonl'), '/p/a.jsonl');
  assert.equal(pinTs('/p/a.jsonl'), 0, 'legacy pins predate timestamps');
  assert.equal(pinPath({ path: '/p/b.jsonl', ts: 42 }), '/p/b.jsonl');
  assert.equal(pinTs({ path: '/p/b.jsonl', ts: 42 }), 42);
  assert.equal(pinPath(undefined), null);
  assert.equal(pinPath({}), null);
});

test('makePin stamps now; pinPaths flattens mixed shapes for the SPA', () => {
  assert.deepEqual(makePin('/p/a.jsonl', 7), { path: '/p/a.jsonl', ts: 7 });
  assert.deepEqual(
    pinPaths({ '@1.1': '/p/a.jsonl', '@2.1': { path: '/p/b.jsonl', ts: 9 }, '@3.1': {} }),
    { '@1.1': '/p/a.jsonl', '@2.1': '/p/b.jsonl' },
  );
});

test('a hook record newer than the pin supersedes it', () => {
  const cwd = '/w';
  const reg = { transcriptPath: '/p/new.jsonl', cwd, ts: 1000 };

  // The live bug: legacy pin (ts 0) on a pane that has since started a new
  // session — the hook record wins.
  assert.equal(isPinSuperseded('/p/old.jsonl', reg, cwd), true);
  assert.equal(isPinSuperseded({ path: '/p/old.jsonl', ts: 500 }, reg, cwd), true);

  // Pinned AFTER the hook record: a deliberate operator override — pin wins.
  assert.equal(isPinSuperseded({ path: '/p/old.jsonl', ts: 2000 }, reg, cwd), false);

  // They agree, or there is no hook record at all — nothing to supersede.
  assert.equal(isPinSuperseded('/p/new.jsonl', reg, cwd), false);
  assert.equal(isPinSuperseded('/p/old.jsonl', null, cwd), false);

  // Reused tmux %N: the hook record's launch cwd no longer matches the live
  // pane, so IT is the stale one — it must not evict the pin.
  assert.equal(isPinSuperseded('/p/old.jsonl', { ...reg, cwd: '/other' }, cwd), false);
});
