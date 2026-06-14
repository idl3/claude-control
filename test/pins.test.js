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
