// test/data-dir-migration.test.js — legacy ~/.cockpit → ~/.claude-control
// state-dir migration (lib/config.js migrateLegacyDataDir).
//
// Covers:
//   1. Legacy present, new absent → safe-copy (never move); legacy left intact.
//   2. New dir already present → no clobber, no copy.
//   3. Neither present → returns the fresh path, creates nothing, never throws.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { migrateLegacyDataDir } from '../lib/config.js';

let tmpHome;

afterEach(() => {
  if (tmpHome) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = undefined;
  }
});

test('legacy present, new absent → copies content, leaves legacy intact', () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mig-'));
  const legacy = path.join(tmpHome, '.cockpit');
  fs.mkdirSync(legacy, { recursive: true });
  const legacyConfig = { launchCommand: 'yolo', defaultCwd: '/tmp' };
  fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify(legacyConfig));

  const result = migrateLegacyDataDir(tmpHome);

  const target = path.join(tmpHome, '.claude-control');
  assert.equal(result, target, 'returns the resolved new data-dir path');
  assert.ok(fs.existsSync(path.join(target, 'config.json')), 'config.json copied to new dir');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(target, 'config.json'), 'utf8')),
    legacyConfig,
    'copied content matches the legacy file exactly',
  );
  assert.ok(fs.existsSync(legacy), 'legacy ~/.cockpit still exists (copy, not move)');
  assert.ok(
    fs.existsSync(path.join(legacy, 'config.json')),
    'legacy config.json is untouched by the copy',
  );
});

test('new dir already present → no clobber, no copy occurs', () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mig-'));
  const legacy = path.join(tmpHome, '.cockpit');
  const target = path.join(tmpHome, '.claude-control');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({ launchCommand: 'legacy-cmd' }));
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'marker'), 'X');

  const result = migrateLegacyDataDir(tmpHome);

  assert.equal(result, target);
  assert.equal(
    fs.readFileSync(path.join(target, 'marker'), 'utf8'),
    'X',
    'pre-existing marker in the new dir must be unchanged (no clobber)',
  );
  assert.ok(
    !fs.existsSync(path.join(target, 'config.json')),
    'no copy occurred — legacy config.json must not have been introduced into the new dir',
  );
});

test('neither present → returns the fresh path, creates nothing, does not throw', () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mig-'));
  const target = path.join(tmpHome, '.claude-control');
  const legacy = path.join(tmpHome, '.cockpit');

  let result;
  assert.doesNotThrow(() => {
    result = migrateLegacyDataDir(tmpHome);
  });

  assert.equal(result, target, 'returns the fresh ~/.claude-control path');
  assert.ok(!fs.existsSync(target), 'no new dir is created when nothing to migrate');
  assert.ok(!fs.existsSync(legacy), 'legacy dir was never present and stays absent');
});
