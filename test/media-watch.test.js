// Tests for lib/media-watch.js — the apps/ directory watcher that feeds D2's
// client hot-reload via server.js's WS broadcast(). Exercises the watcher
// class directly against a real tmpdir (no server.js boot needed — the
// broadcast wiring itself is a two-line pass-through covered by inspection +
// the D5 end-to-end proof).
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MediaAppWatcher } from '../lib/media-watch.js';

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-watch-'));
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

let appsDir;
let watcher;

beforeEach(() => {
  appsDir = fs.mkdtempSync(path.join(root, 'apps-'));
});
afterEach(() => {
  watcher?.stop();
  watcher = null;
});

/** Atomic write: temp file + rename into place — the D5 producer's pattern. */
function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function waitForChanges(w, count, timeoutMs) {
  return new Promise((resolve, reject) => {
    const changes = [];
    const timer = setTimeout(() => {
      w.off('change', onChange);
      resolve(changes); // resolve with whatever arrived — caller asserts the count
    }, timeoutMs);
    function onChange(evt) {
      changes.push(evt);
      if (changes.length >= count) {
        clearTimeout(timer);
        w.off('change', onChange);
        resolve(changes);
      }
    }
    w.on('change', onChange);
    w.on('error', reject);
  });
}

describe('MediaAppWatcher', () => {
  test('an atomic write (temp + rename) yields exactly one change frame within 300-900ms', async () => {
    watcher = new MediaAppWatcher(appsDir, { debounceMs: 300, pollMs: 300 });
    watcher.start();
    // Let the seed walk + first attach settle before writing, so the write is
    // unambiguously a post-start change, not a startup-seed race.
    await new Promise((r) => setTimeout(r, 50));

    const target = path.join(appsDir, 'counter.html');
    const changes = waitForChanges(watcher, 1, 900);
    atomicWrite(target, '<html>v1</html>');
    const result = await changes;

    assert.equal(result.length, 1, `expected exactly 1 frame, got ${result.length}`);
    assert.equal(result[0].path, 'apps/counter.html');
    assert.equal(typeof result[0].mtime, 'number');
  });

  test('rapid double-write to the same path coalesces into exactly one frame', async () => {
    watcher = new MediaAppWatcher(appsDir, { debounceMs: 300, pollMs: 300 });
    watcher.start();
    await new Promise((r) => setTimeout(r, 50));

    const target = path.join(appsDir, 'counter.html');
    const changes = waitForChanges(watcher, 2, 900); // cap at 2 so a real double-emit would be caught

    atomicWrite(target, '<html>v1</html>');
    await new Promise((r) => setTimeout(r, 40)); // well within the 300ms debounce window
    atomicWrite(target, '<html>v2</html>');

    const result = await changes;
    assert.equal(result.length, 1, `expected coalesced single frame, got ${result.length}`);
    assert.equal(result[0].path, 'apps/counter.html');
  });

  test('directory recreation (rm -rf + rebuild) is survived — a write inside the new dir still emits', async () => {
    const versionedDir = path.join(appsDir, 'widget');
    fs.mkdirSync(versionedDir);
    fs.writeFileSync(path.join(versionedDir, 'latest'), '2026-01-01T00-00-00.html');

    watcher = new MediaAppWatcher(appsDir, { debounceMs: 200, pollMs: 200 });
    watcher.start();
    await new Promise((r) => setTimeout(r, 50));

    // Simulate a full rebuild: the app's whole subdirectory is torn down and
    // recreated (not just one file replaced), the harder case for a watch
    // rooted at appsDir to survive.
    fs.rmSync(versionedDir, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 50));
    fs.mkdirSync(versionedDir);

    const changes = waitForChanges(watcher, 1, 1500);
    atomicWrite(path.join(versionedDir, '2026-01-02T00-00-00.html'), '<html>rebuilt</html>');
    const result = await changes;

    assert.equal(result.length, 1, `expected exactly 1 frame after dir recreation, got ${result.length}`);
    assert.equal(result[0].path, 'apps/widget/2026-01-02T00-00-00.html');
  });

  test('pre-existing files at start() do not themselves trigger a change frame', async () => {
    fs.writeFileSync(path.join(appsDir, 'preexisting.html'), '<html>already here</html>');
    watcher = new MediaAppWatcher(appsDir, { debounceMs: 200, pollMs: 200 });

    const changes = waitForChanges(watcher, 1, 700);
    watcher.start();
    const result = await changes;

    assert.equal(result.length, 0, `expected no startup-seed frame, got ${JSON.stringify(result)}`);
  });

  test('L2 (Codex review): a deleted file is pruned from _mtimes on the next poll sweep', async () => {
    const target = path.join(appsDir, 'counter.html');
    atomicWrite(target, '<html>v1</html>');

    watcher = new MediaAppWatcher(appsDir, { debounceMs: 100, pollMs: 100 });
    watcher.start();
    await new Promise((r) => setTimeout(r, 50)); // seed walk settles before deletion

    assert.equal(watcher._mtimes.has('counter.html'), true, 'seed walk should have recorded the pre-existing file');

    fs.rmSync(target);
    // Let at least one poll sweep (pollMs=100) run past the deletion.
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(
      watcher._mtimes.has('counter.html'),
      false,
      'deleted file must be pruned from _mtimes on the next sweep, not linger for the process lifetime',
    );
  });

  test('stop() prevents any further emission', async () => {
    watcher = new MediaAppWatcher(appsDir, { debounceMs: 100, pollMs: 100 });
    watcher.start();
    await new Promise((r) => setTimeout(r, 50));
    watcher.stop();

    let firedAfterStop = false;
    watcher.on('change', () => {
      firedAfterStop = true;
    });
    atomicWrite(path.join(appsDir, 'after-stop.html'), '<html>x</html>');
    await new Promise((r) => setTimeout(r, 700));

    assert.equal(firedAfterStop, false);
  });
});
