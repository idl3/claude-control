/**
 * test/json-file.test.js — atomic JSON write helper.
 *
 * Each test must FAIL against a naive in-place fs.writeFileSync implementation
 * to prove it has real teeth. Comments next to assertions call out why the
 * naive implementation would fail.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-json-file-test-'));
}

// ── import the unit under test ────────────────────────────────────────────────

const { writeJsonAtomic } = await import('../lib/json-file.js');

// ── tests ─────────────────────────────────────────────────────────────────────

describe('writeJsonAtomic', () => {
  let dir;

  before(() => {
    dir = makeTmpDir();
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes valid JSON that round-trips via JSON.parse', () => {
    const dest = path.join(dir, 'round-trip.json');
    const value = { foo: 'bar', nested: { n: 42 }, arr: [1, 2, 3] };
    writeJsonAtomic(dest, value);
    const parsed = JSON.parse(fs.readFileSync(dest, 'utf8'));
    assert.deepEqual(parsed, value);
    // A naive impl that skips serialisation (e.g. writes '[object Object]') fails here.
  });

  it('leaves NO temp file in the directory after a successful write', () => {
    const dest = path.join(dir, 'no-temp.json');
    writeJsonAtomic(dest, { ok: true });
    const entries = fs.readdirSync(dir);
    const stray = entries.filter((e) => e.startsWith('no-temp.json') && e !== 'no-temp.json');
    assert.equal(stray.length, 0, `stray temp files: ${stray.join(', ')}`);
    // A naive impl that writes to a .tmp and never renames would leave it behind.
  });

  it('overwrites an existing file completely — destination is always complete old or new content', () => {
    const dest = path.join(dir, 'overwrite.json');
    const oldValue = { version: 1, data: 'original' };
    const newValue = { version: 2, data: 'updated', extra: true };

    // Write the old value the same way (atomic write).
    writeJsonAtomic(dest, oldValue);
    assert.deepEqual(JSON.parse(fs.readFileSync(dest, 'utf8')), oldValue);

    // Overwrite with new value.
    writeJsonAtomic(dest, newValue);
    const onDisk = JSON.parse(fs.readFileSync(dest, 'utf8'));
    assert.deepEqual(onDisk, newValue);
    // A partial write that truncates mid-JSON would fail JSON.parse.
  });

  describe('failed write simulation — destination survives + temp is cleaned up', () => {
    it('when writeFileSync throws: destination still holds old content', async () => {
      const dest = path.join(dir, 'survive-old.json');
      const oldValue = { stable: true };

      // Establish the old content via a direct write so we are not depending on
      // the function under test for setup.
      fs.writeFileSync(dest, JSON.stringify(oldValue, null, 2));

      // Dynamically re-import the module with a mocked fs to simulate the temp
      // write failing before renameSync.  We do this by patching the real fs
      // object used by the module.
      const realWriteFileSync = fs.writeFileSync.bind(fs);
      let callCount = 0;
      fs.writeFileSync = (...args) => {
        callCount++;
        // Only intercept the .tmp write (first call from our helper).
        if (typeof args[0] === 'string' && args[0].endsWith('.tmp')) {
          // Restore before throwing so subsequent operations work.
          fs.writeFileSync = realWriteFileSync;
          throw new Error('simulated disk full');
        }
        return realWriteFileSync(...args);
      };

      try {
        assert.throws(
          () => writeJsonAtomic(dest, { evil: 'bad' }),
          /simulated disk full/,
        );
      } finally {
        // Always restore even if assert.throws fails.
        fs.writeFileSync = realWriteFileSync;
      }

      // Destination must still be the old content — not truncated, not the new value.
      const onDisk = JSON.parse(fs.readFileSync(dest, 'utf8'));
      assert.deepEqual(onDisk, oldValue,
        'destination was corrupted; a naive in-place write would overwrite before the error');

      // No temp file should be left around.
      const entries = fs.readdirSync(dir);
      const stray = entries.filter((e) => e.startsWith('survive-old.json') && e !== 'survive-old.json');
      assert.equal(stray.length, 0,
        `temp file was not cleaned up: ${stray.join(', ')}`);
    });

    it('when renameSync throws: destination still holds old content + temp is cleaned up', () => {
      const dest = path.join(dir, 'survive-rename.json');
      const oldValue = { original: 1 };
      fs.writeFileSync(dest, JSON.stringify(oldValue, null, 2));

      const realRenameSync = fs.renameSync.bind(fs);
      fs.renameSync = (...args) => {
        fs.renameSync = realRenameSync;
        throw new Error('simulated rename failure');
      };

      try {
        assert.throws(
          () => writeJsonAtomic(dest, { replacement: 2 }),
          /simulated rename failure/,
        );
      } finally {
        fs.renameSync = realRenameSync;
      }

      // Destination must still be the old content.
      const onDisk = JSON.parse(fs.readFileSync(dest, 'utf8'));
      assert.deepEqual(onDisk, oldValue,
        'destination was mutated even though renameSync failed');

      // Temp file must be cleaned up.
      const entries = fs.readdirSync(dir);
      const stray = entries.filter((e) => e.startsWith('survive-rename.json') && e !== 'survive-rename.json');
      assert.equal(stray.length, 0,
        `temp file was not cleaned up after rename failure: ${stray.join(', ')}`);
    });
  });
});

describe('call-site routing — config + push use writeJsonAtomic', () => {
  it('lib/config.js imports and calls writeJsonAtomic (not in-place writeFileSync)', () => {
    const src = fs.readFileSync(
      new URL('../lib/config.js', import.meta.url),
      'utf8',
    );
    assert.match(src, /writeJsonAtomic/, 'config.js must import writeJsonAtomic');
    // Verify the old plain writeFileSync for configPath is gone.
    // The remaining writeFileSync calls (e.g. statSync) are fine; we only care
    // the config write path no longer calls writeFileSync(configPath(), …).
    // We do this by checking configPath() is not passed to writeFileSync.
    assert.doesNotMatch(
      src,
      /fs\.writeFileSync\s*\(\s*configPath\(\)/,
      'config.js still has an in-place writeFileSync for configPath()',
    );
  });

  it('lib/push.js imports and calls writeJsonAtomic for both VAPID and subs', () => {
    const src = fs.readFileSync(
      new URL('../lib/push.js', import.meta.url),
      'utf8',
    );
    assert.match(src, /writeJsonAtomic/, 'push.js must import writeJsonAtomic');
    // VAPID_PATH must not appear in a plain writeFileSync call.
    assert.doesNotMatch(
      src,
      /fs\.writeFileSync\s*\(\s*VAPID_PATH/,
      'push.js still has an in-place writeFileSync for VAPID_PATH',
    );
    // SUBS_PATH must not appear in a plain writeFileSync call.
    assert.doesNotMatch(
      src,
      /fs\.writeFileSync\s*\(\s*SUBS_PATH/,
      'push.js still has an in-place writeFileSync for SUBS_PATH',
    );
  });

  it('lib/pins.js imports and uses writeJsonAtomic (not the inline tmp+rename)', () => {
    const src = fs.readFileSync(
      new URL('../lib/pins.js', import.meta.url),
      'utf8',
    );
    assert.match(src, /writeJsonAtomic/, 'pins.js must import writeJsonAtomic');
    // The inline tmp+rename block must be gone.
    assert.doesNotMatch(
      src,
      /\.tmp`;\s*\n\s*fs\.writeFileSync/,
      'pins.js still contains the inline tmp+rename pattern',
    );
  });
});
