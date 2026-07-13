import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadPins, savePins, validateTranscriptPath, pinKey } from '../lib/pins.js';

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
