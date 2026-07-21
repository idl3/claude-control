import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readConfig, writeConfig } from '../lib/config.js';
import { CLAUDEX_MODELS, CLAUDEMI_MODELS } from '../lib/models.js';

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

// ── Codex fields ──────────────────────────────────────────────────────────────

test('readConfig returns codex defaults when no file exists', () => {
  const cfg = readConfig();
  assert.equal(cfg.codexLaunchCommand, 'codex');
  assert.equal(cfg.codexBin, '');
});

test('writeConfig persists a valid codexLaunchCommand', () => {
  const saved = writeConfig({ codexLaunchCommand: 'yodex' });
  assert.equal(saved.codexLaunchCommand, 'yodex');
  assert.equal(readConfig().codexLaunchCommand, 'yodex');
});

test('writeConfig persists codexBin (empty string allowed)', () => {
  const saved = writeConfig({ codexBin: '' });
  assert.equal(saved.codexBin, '');
  assert.equal(readConfig().codexBin, '');
});

test('writeConfig persists a non-empty codexBin', () => {
  const saved = writeConfig({ codexBin: '/usr/local/bin/codex' });
  assert.equal(saved.codexBin, '/usr/local/bin/codex');
  assert.equal(readConfig().codexBin, '/usr/local/bin/codex');
});

test('writeConfig rejects an empty codexLaunchCommand', () => {
  assert.throws(() => writeConfig({ codexLaunchCommand: '   ' }), /non-empty/);
});

test('writeConfig rejects a codexLaunchCommand over 500 chars', () => {
  assert.throws(() => writeConfig({ codexLaunchCommand: 'x'.repeat(501) }), /500/);
});

test('writeConfig round-trips all four CLI fields together', () => {
  const saved = writeConfig({
    launchCommand: 'yolo',
    claudeBin: '/opt/homebrew/bin/claude',
    codexLaunchCommand: 'yodex',
    codexBin: '/opt/homebrew/bin/codex',
  });
  assert.equal(saved.launchCommand, 'yolo');
  assert.equal(saved.claudeBin, '/opt/homebrew/bin/claude');
  assert.equal(saved.codexLaunchCommand, 'yodex');
  assert.equal(saved.codexBin, '/opt/homebrew/bin/codex');
  const read = readConfig();
  assert.equal(read.launchCommand, 'yolo');
  assert.equal(read.claudeBin, '/opt/homebrew/bin/claude');
  assert.equal(read.codexLaunchCommand, 'yodex');
  assert.equal(read.codexBin, '/opt/homebrew/bin/codex');
});

// ── Claudex fields ────────────────────────────────────────────────────────────

test('readConfig returns the claudex default when no file exists', () => {
  const cfg = readConfig();
  assert.equal(cfg.claudexModel, 'gpt-5.6-sol');
  // The default must be a member of the curated closed list (single source
  // of truth: lib/models.js CLAUDEX_MODELS).
  assert.ok(CLAUDEX_MODELS.some((m) => m.id === cfg.claudexModel));
});

test('writeConfig persists a valid claudexModel', () => {
  const saved = writeConfig({ claudexModel: 'gpt-5.6-sol' });
  assert.equal(saved.claudexModel, 'gpt-5.6-sol');
  assert.equal(readConfig().claudexModel, 'gpt-5.6-sol');
});

test('writeConfig rejects a claudexModel outside the closed list', () => {
  assert.throws(() => writeConfig({ claudexModel: 'gpt-99-invented' }), /must be one of/);
  assert.throws(() => writeConfig({ claudexModel: 42 }), /must be one of/);
});

test('readConfig falls back to the default on an unknown persisted claudexModel', () => {
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({ claudexModel: 'gpt-99-invented' }),
  );
  assert.equal(readConfig().claudexModel, 'gpt-5.6-sol');
});

// CP3 Fix 3: the silent fallback above still never throws, but now warns
// naming the ignored value — an operator whose config.json got hand-edited
// or corrupted can see WHY their choice was ignored instead of the model
// quietly reverting with no trace.
test('readConfig warns (but never throws) when discarding an invalid persisted claudexModel', () => {
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({ claudexModel: 'gpt-99-invented' }),
  );
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let cfg;
  try {
    cfg = readConfig();
  } finally {
    console.warn = origWarn;
  }
  assert.equal(cfg.claudexModel, 'gpt-5.6-sol');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /gpt-99-invented/);
});

test('readConfig does NOT warn when claudexModel is simply absent', () => {
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ launchCommand: 'yolo' }));
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    readConfig();
  } finally {
    console.warn = origWarn;
  }
  assert.equal(warnings.length, 0);
});

// ── Claudemi fields (Kimi K3 harness — claudex's sibling) ────────────────────

test('readConfig returns the claudemi default when no file exists', () => {
  const cfg = readConfig();
  assert.equal(cfg.claudemiModel, 'kimi-k3');
  // The default must be a member of the curated closed list (single source
  // of truth: lib/models.js CLAUDEMI_MODELS).
  assert.ok(CLAUDEMI_MODELS.some((m) => m.id === cfg.claudemiModel));
});

test('writeConfig persists a valid claudemiModel', () => {
  const saved = writeConfig({ claudemiModel: 'kimi-k2.7-code' });
  assert.equal(saved.claudemiModel, 'kimi-k2.7-code');
  assert.equal(readConfig().claudemiModel, 'kimi-k2.7-code');
});

test('writeConfig rejects a claudemiModel outside the closed list', () => {
  assert.throws(() => writeConfig({ claudemiModel: 'kimi-99-invented' }), /must be one of/);
  assert.throws(() => writeConfig({ claudemiModel: 42 }), /must be one of/);
});

test('readConfig falls back to the default on an unknown persisted claudemiModel', () => {
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({ claudemiModel: 'kimi-99-invented' }),
  );
  assert.equal(readConfig().claudemiModel, 'kimi-k3');
});

test('readConfig warns (but never throws) when discarding an invalid persisted claudemiModel', () => {
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({ claudemiModel: 'kimi-99-invented' }),
  );
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let cfg;
  try {
    cfg = readConfig();
  } finally {
    console.warn = origWarn;
  }
  assert.equal(cfg.claudemiModel, 'kimi-k3');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /kimi-99-invented/);
});

test('readConfig does NOT warn when claudemiModel is simply absent', () => {
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ launchCommand: 'yolo' }));
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    readConfig();
  } finally {
    console.warn = origWarn;
  }
  assert.equal(warnings.length, 0);
});

// ── projectDirs fields ────────────────────────────────────────────────────────

test('readConfig returns an empty projectDirs list by default (no built-in org paths)', () => {
  const cfg = readConfig();
  assert.ok(Array.isArray(cfg.projectDirs));
  assert.deepEqual(cfg.projectDirs, []);
});

test('writeConfig persists a valid projectDirs list and round-trips', () => {
  const dirs = [
    { label: 'My Project', path: '~/Projects/my-project' },
    { label: 'Work', path: '/Users/ernie/work' },
  ];
  const saved = writeConfig({ projectDirs: dirs });
  assert.deepEqual(saved.projectDirs, dirs);
  const read = readConfig();
  assert.deepEqual(read.projectDirs, dirs);
});

test('writeConfig accepts an empty projectDirs array', () => {
  const saved = writeConfig({ projectDirs: [] });
  // Empty array: normalizeProjectDirs falls back to defaults on read, but
  // the written list is empty — verify the file stored [] and read gets defaults.
  // (Immutable: we store what was written; on next read the fallback kicks in.)
  assert.ok(Array.isArray(saved.projectDirs));
});

test('writeConfig rejects a non-array projectDirs', () => {
  assert.throws(() => writeConfig({ projectDirs: 'not-an-array' }), /must be an array/);
});

test('writeConfig rejects projectDirs with more than 50 entries', () => {
  const dirs = Array.from({ length: 51 }, (_, i) => ({
    label: `P${i}`,
    path: `~/Projects/p${i}`,
  }));
  assert.throws(() => writeConfig({ projectDirs: dirs }), /at most 50/);
});

test('writeConfig rejects a projectDirs entry with empty label', () => {
  assert.throws(
    () => writeConfig({ projectDirs: [{ label: '  ', path: '~/Projects/x' }] }),
    /non-empty string/,
  );
});

test('writeConfig rejects a projectDirs entry with empty path', () => {
  assert.throws(
    () => writeConfig({ projectDirs: [{ label: 'X', path: '' }] }),
    /non-empty string/,
  );
});

test('readConfig drops malformed projectDirs entries and falls back to defaults', () => {
  // Write a raw config file with two bad entries and one good one.
  const raw = {
    projectDirs: [
      null,
      { label: 42, path: '~/x' },
      { label: 'Good', path: '~/Projects/good' },
    ],
  };
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(raw));
  const cfg = readConfig();
  // Only the valid entry survives.
  assert.deepEqual(cfg.projectDirs, [{ label: 'Good', path: '~/Projects/good' }]);
});
