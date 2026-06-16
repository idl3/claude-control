import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// We'll override os.homedir by monkey-patching via a custom env; since the
// module is ESM with a module-level os.homedir() call in listSkills(), we use
// _bustCache to force re-reads and set HOME env so os.homedir() returns the
// fixture dir.
import { listSkills, _bustCache } from '../lib/skills.js';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-skills-'));
}

function makeSkill(root, name, description, extraFm = '') {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const frontMatter = description
    ? `---\nname: ${name}\ndescription: ${description}${extraFm ? '\n' + extraFm : ''}\n---\n\n# Skill body\n`
    : `---\n${extraFm || 'title: no-desc'}\n---\n\n# Body\n`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), frontMatter);
  return dir;
}

// ── tests ────────────────────────────────────────────────────────────────────

test('listSkills returns empty array when skills dir missing', () => {
  _bustCache();
  const orig = process.env.HOME;
  const tmp = makeTmp(); // empty — no .claude/skills subdir
  process.env.HOME = tmp;
  try {
    const skills = listSkills();
    assert.deepEqual(skills, []);
  } finally {
    process.env.HOME = orig;
    _bustCache();
  }
});

test('listSkills discovers user skills with SKILL.md', () => {
  _bustCache();
  const orig = process.env.HOME;
  const tmp = makeTmp();
  const skillsDir = path.join(tmp, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  makeSkill(skillsDir, 'brainstorm', 'Generate ideas and explore possibilities');
  makeSkill(skillsDir, 'plan-hard', 'Deep implementation planning');

  process.env.HOME = tmp;
  try {
    const skills = listSkills();
    assert.equal(skills.length, 2);
    // Sorted alphabetically
    assert.equal(skills[0].name, 'brainstorm');
    assert.equal(skills[0].description, 'Generate ideas and explore possibilities');
    assert.equal(skills[0].source, 'user');
    assert.equal(skills[1].name, 'plan-hard');
    assert.equal(skills[1].source, 'user');
  } finally {
    process.env.HOME = orig;
    _bustCache();
  }
});

test('listSkills skips directories without SKILL.md', () => {
  _bustCache();
  const orig = process.env.HOME;
  const tmp = makeTmp();
  const skillsDir = path.join(tmp, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  makeSkill(skillsDir, 'real-skill', 'I have a SKILL.md');

  // A directory without SKILL.md — should be ignored
  const noMd = path.join(skillsDir, 'not-a-skill');
  fs.mkdirSync(noMd, { recursive: true });
  fs.writeFileSync(path.join(noMd, 'README.md'), '# Not a skill');

  // A plain file at the skills root — should be ignored
  fs.writeFileSync(path.join(skillsDir, '10x-INDEX.md'), '# Index');

  process.env.HOME = tmp;
  try {
    const skills = listSkills();
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'real-skill');
  } finally {
    process.env.HOME = orig;
    _bustCache();
  }
});

test('listSkills discovers plugin skills', () => {
  _bustCache();
  const orig = process.env.HOME;
  const tmp = makeTmp();
  const skillsDir = path.join(tmp, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  // Plugin cache: ~/.claude/plugins/cache/<plugin>/skills/<name>/SKILL.md
  const pluginSkillsDir = path.join(
    tmp,
    '.claude',
    'plugins',
    'cache',
    'my-plugin',
    'skills',
  );
  fs.mkdirSync(pluginSkillsDir, { recursive: true });
  makeSkill(pluginSkillsDir, 'plugin-skill', 'A plugin-provided skill');

  process.env.HOME = tmp;
  try {
    const skills = listSkills();
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'plugin-skill');
    assert.equal(skills[0].source, 'plugin');
  } finally {
    process.env.HOME = orig;
    _bustCache();
  }
});

test('user skill wins over plugin skill with same name (de-dup)', () => {
  _bustCache();
  const orig = process.env.HOME;
  const tmp = makeTmp();
  const skillsDir = path.join(tmp, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  makeSkill(skillsDir, 'shared-skill', 'User version');

  const pluginSkillsDir = path.join(
    tmp,
    '.claude',
    'plugins',
    'cache',
    'plugin-a',
    'skills',
  );
  fs.mkdirSync(pluginSkillsDir, { recursive: true });
  makeSkill(pluginSkillsDir, 'shared-skill', 'Plugin version');

  process.env.HOME = tmp;
  try {
    const skills = listSkills();
    assert.equal(skills.length, 1);
    assert.equal(skills[0].source, 'user');
    assert.equal(skills[0].description, 'User version');
  } finally {
    process.env.HOME = orig;
    _bustCache();
  }
});

test('listSkills result is sorted by name', () => {
  _bustCache();
  const orig = process.env.HOME;
  const tmp = makeTmp();
  const skillsDir = path.join(tmp, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  makeSkill(skillsDir, 'zebra', 'Last');
  makeSkill(skillsDir, 'alpha', 'First');
  makeSkill(skillsDir, 'middle', 'Mid');

  process.env.HOME = tmp;
  try {
    const skills = listSkills();
    assert.deepEqual(
      skills.map((s) => s.name),
      ['alpha', 'middle', 'zebra'],
    );
  } finally {
    process.env.HOME = orig;
    _bustCache();
  }
});

test('cache is used on repeated calls within TTL', () => {
  _bustCache();
  const orig = process.env.HOME;
  const tmp = makeTmp();
  const skillsDir = path.join(tmp, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  makeSkill(skillsDir, 'cached-skill', 'Cached');

  process.env.HOME = tmp;
  try {
    const first = listSkills();
    // Add another skill to disk — should NOT appear in cached result
    makeSkill(skillsDir, 'new-skill', 'New');
    const second = listSkills();
    // Same reference (cache hit)
    assert.equal(first, second);
    assert.equal(second.length, 1);
  } finally {
    process.env.HOME = orig;
    _bustCache();
  }
});

test('skill with no description front-matter gets empty string', () => {
  _bustCache();
  const orig = process.env.HOME;
  const tmp = makeTmp();
  const skillsDir = path.join(tmp, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  // SKILL.md with front-matter but no description key
  const dir = path.join(skillsDir, 'no-desc-skill');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    '---\ntitle: Something\nauthor: test\n---\n\n# Body\n',
  );

  process.env.HOME = tmp;
  try {
    const skills = listSkills();
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'no-desc-skill');
    assert.equal(skills[0].description, '');
  } finally {
    process.env.HOME = orig;
    _bustCache();
  }
});
