import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeRoots, deriveProjectsRoots } from '../lib/projects-roots.js';

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-roots-'));
}

test('deriveProjectsRoots globs siblings that have a projects/ subdir, excludes ones without', () => {
  const home = mkHome();
  const primary = path.join(home, '.claude', 'projects');
  fs.mkdirSync(primary, { recursive: true });
  const grain = path.join(home, '.claude-grain', 'projects');
  fs.mkdirSync(grain, { recursive: true });
  const atlas = path.join(home, '.claude-atlas', 'projects');
  fs.mkdirSync(atlas, { recursive: true });
  // .claude-nope has no projects/ subdir — should be excluded
  fs.mkdirSync(path.join(home, '.claude-nope'), { recursive: true });

  const roots = deriveProjectsRoots({ homeDir: home, primaryRoot: primary });
  assert.ok(roots.includes(grain), 'includes grain sibling');
  assert.ok(roots.includes(atlas), 'includes atlas sibling');
  assert.ok(!roots.some((r) => r.includes('.claude-nope')), 'excludes sibling without projects/');
});

test('deriveProjectsRoots hard-excludes ~/.claude-control/projects even if it exists', () => {
  const home = mkHome();
  const primary = path.join(home, '.claude', 'projects');
  fs.mkdirSync(primary, { recursive: true });
  const controlProjects = path.join(home, '.claude-control', 'projects');
  fs.mkdirSync(controlProjects, { recursive: true });

  const roots = deriveProjectsRoots({ homeDir: home, primaryRoot: primary });
  assert.ok(!roots.includes(controlProjects), 'excludes .claude-control/projects');
});

test('deriveProjectsRoots excludes an explicit dataDir', () => {
  const home = mkHome();
  const primary = path.join(home, '.claude', 'projects');
  fs.mkdirSync(primary, { recursive: true });
  const mineDir = path.join(home, '.claude-mine');
  const mineProjects = path.join(mineDir, 'projects');
  fs.mkdirSync(mineProjects, { recursive: true });

  const roots = deriveProjectsRoots({ homeDir: home, primaryRoot: primary, dataDir: mineDir });
  assert.ok(!roots.includes(mineProjects), 'excludes the passed dataDir');
});

test('deriveProjectsRoots singleRoot:true returns exactly [primaryRoot]', () => {
  const home = mkHome();
  const primary = path.join(home, '.claude', 'projects');
  fs.mkdirSync(primary, { recursive: true });
  const grain = path.join(home, '.claude-grain', 'projects');
  fs.mkdirSync(grain, { recursive: true });

  const roots = deriveProjectsRoots({ homeDir: home, primaryRoot: primary, singleRoot: true });
  assert.deepEqual(roots, [primary]);
});

test('deriveProjectsRoots: primary is always first, result is deduped', () => {
  const home = mkHome();
  // primary IS the same path as a would-be sibling's projects dir.
  const shared = path.join(home, '.claude-shared', 'projects');
  fs.mkdirSync(shared, { recursive: true });

  const roots = deriveProjectsRoots({ homeDir: home, primaryRoot: shared });
  assert.equal(roots[0], shared);
  assert.equal(roots.filter((r) => r === shared).length, 1, 'deduped, appears once');
});

test('deriveProjectsRoots on unreadable/nonexistent homeDir returns [primaryRoot], no throw', () => {
  const primary = path.join(os.tmpdir(), 'nonexistent-primary-projects');
  const badHome = path.join(os.tmpdir(), 'cc-roots-nonexistent-home-' + Date.now());
  assert.doesNotThrow(() => {
    const roots = deriveProjectsRoots({ homeDir: badHome, primaryRoot: primary });
    assert.deepEqual(roots, [primary]);
  });
});

test('normalizeRoots dedupes an array, falls back to single, handles undefined', () => {
  assert.deepEqual(normalizeRoots(['/a', '/a', '/b'], null), ['/a', '/b']);
  assert.deepEqual(normalizeRoots([], '/x'), ['/x']);
  assert.deepEqual(normalizeRoots(undefined, null), []);
});
