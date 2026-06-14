import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readConfig, writeConfig } from '../lib/config.js';

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-config-'));
  process.env.CLAUDE_CONTROL_DATA = dataDir;
});

afterEach(() => {
  delete process.env.CLAUDE_CONTROL_DATA;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('readConfig returns defaults when no file exists', () => {
  const cfg = readConfig();
  assert.equal(cfg.launchCommand, 'claude');
  assert.equal(cfg.defaultCwd, os.homedir());
});

test('readConfig never throws on corrupt file', () => {
  fs.writeFileSync(path.join(dataDir, 'config.json'), '{ not json');
  const cfg = readConfig();
  assert.equal(cfg.launchCommand, 'claude');
});

test('writeConfig persists a valid launchCommand', () => {
  const saved = writeConfig({ launchCommand: 'yolo' });
  assert.equal(saved.launchCommand, 'yolo');
  assert.equal(readConfig().launchCommand, 'yolo');
});

test('writeConfig writes the file with mode 0600', () => {
  writeConfig({ launchCommand: 'claude --flags' });
  const mode = fs.statSync(path.join(dataDir, 'config.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('writeConfig rejects an empty launchCommand', () => {
  assert.throws(() => writeConfig({ launchCommand: '   ' }), /non-empty/);
});

test('writeConfig rejects a launchCommand over 500 chars', () => {
  assert.throws(() => writeConfig({ launchCommand: 'x'.repeat(501) }), /500/);
});

test('writeConfig rejects a non-string launchCommand', () => {
  assert.throws(() => writeConfig({ launchCommand: 42 }), /non-empty/);
});

test('writeConfig accepts an existing directory for defaultCwd', () => {
  const saved = writeConfig({ defaultCwd: dataDir });
  assert.equal(saved.defaultCwd, dataDir);
});

test('writeConfig rejects a non-existent defaultCwd', () => {
  assert.throws(
    () => writeConfig({ defaultCwd: '/no/such/dir/cc-test' }),
    /does not exist/,
  );
});

test('writeConfig rejects a file (non-directory) as defaultCwd', () => {
  const f = path.join(dataDir, 'afile');
  fs.writeFileSync(f, 'x');
  assert.throws(() => writeConfig({ defaultCwd: f }), /not a directory/);
});

test('writeConfig merges partial updates over existing config', () => {
  writeConfig({ launchCommand: 'yolo' });
  writeConfig({ defaultCwd: dataDir });
  const cfg = readConfig();
  assert.equal(cfg.launchCommand, 'yolo');
  assert.equal(cfg.defaultCwd, dataDir);
});
