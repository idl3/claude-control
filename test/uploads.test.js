import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sweepUploads } from '../lib/uploads.js';

test('sweepUploads removes files older than ttl, keeps fresh ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-sweep-'));
  const oldFile = path.join(dir, 'old.png');
  const newFile = path.join(dir, 'new.png');
  fs.writeFileSync(oldFile, 'x');
  fs.writeFileSync(newFile, 'y');

  // Age the old file 48h into the past.
  const past = (Date.now() - 48 * 3600 * 1000) / 1000;
  fs.utimesSync(oldFile, past, past);

  const ttlMs = 24 * 3600 * 1000; // 24h
  const { removed, kept } = await sweepUploads(dir, ttlMs);

  assert.equal(removed, 1);
  assert.equal(kept, 1);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(newFile), true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('sweepUploads is a no-op on a missing directory', async () => {
  const res = await sweepUploads('/no/such/cockpit/dir', 1000);
  assert.deepEqual(res, { removed: 0, kept: 0 });
});
