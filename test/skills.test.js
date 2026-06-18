import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// We'll override os.homedir by monkey-patching via a custom env; since the
// module is ESM with a module-level os.homedir() call in listSkills(), we use
// _bustCache to force re-reads and set HOME env so os.homedir() returns the
// fixture dir.
import { listSkills, readSkill, _bustCache } from '../lib/skills.js';

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

test('listSkills discovers prefixed (colon) skill names verbatim', () => {
  _bustCache();
  const orig = process.env.HOME;
  const tmp = makeTmp();
  const skillsDir = path.join(tmp, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  // Synced skills keep their prefixed invocation name (the dir name IS the slash
  // command). Discovery must surface the colon name verbatim.
  makeSkill(skillsDir, '100x:brainstorm', 'Expand ideas');

  process.env.HOME = tmp;
  try {
    const skills = listSkills();
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, '100x:brainstorm');
    assert.equal(skills[0].source, 'user');
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

// ── New tests: project skills, readSkill, body parsing, traversal guard ───────

test('listSkills merges project skills and they take precedence over user', () => {
  _bustCache();
  const orig = process.env.HOME;
  const tmp = makeTmp();
  const userSkillsDir = path.join(tmp, '.claude', 'skills');
  fs.mkdirSync(userSkillsDir, { recursive: true });

  // User skill "shared" with description A.
  makeSkill(userSkillsDir, 'shared', 'user description');
  makeSkill(userSkillsDir, 'user-only', 'user only');

  // Project directory with its own .claude/skills.
  const projectDir = makeTmp();
  const projectSkillsDir = path.join(projectDir, '.claude', 'skills');
  fs.mkdirSync(projectSkillsDir, { recursive: true });
  // Project skill "shared" overrides user; "project-only" is additive.
  makeSkill(projectSkillsDir, 'shared', 'project description');
  makeSkill(projectSkillsDir, 'project-only', 'project only');

  process.env.HOME = tmp;
  try {
    const skills = listSkills(projectDir);
    const names = skills.map((s) => s.name);
    assert.ok(names.includes('shared'), 'shared must be present');
    assert.ok(names.includes('user-only'), 'user-only must be present');
    assert.ok(names.includes('project-only'), 'project-only must be present');
    const shared = skills.find((s) => s.name === 'shared');
    assert.equal(shared.source, 'project', 'project skill overrides user');
    assert.equal(shared.description, 'project description', 'project desc wins');
    const projectOnly = skills.find((s) => s.name === 'project-only');
    assert.equal(projectOnly.source, 'project');
    const userOnly = skills.find((s) => s.name === 'user-only');
    assert.equal(userOnly.source, 'user');
  } finally {
    process.env.HOME = orig;
    _bustCache();
  }
});

test('readSkill returns front-matter and body', () => {
  _bustCache();
  const orig = process.env.HOME;
  const tmp = makeTmp();
  const skillsDir = path.join(tmp, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  const dir = path.join(skillsDir, 'my-skill');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    '---\nname: my-skill\ndescription: Does things\nmodel: claude-sonnet-4\n---\n\n# My Skill\n\nDoes **cool** things.\n',
  );

  process.env.HOME = tmp;
  try {
    const result = readSkill('my-skill', null);
    assert.ok(result !== null, 'readSkill must return a result');
    assert.equal(result.name, 'my-skill');
    assert.equal(result.source, 'user');
    assert.equal(result.frontMatter.description, 'Does things');
    assert.equal(result.frontMatter.model, 'claude-sonnet-4');
    assert.ok(result.body.includes('# My Skill'), 'body must include heading');
    assert.ok(result.body.includes('Does **cool** things.'), 'body must include content');
    // Front-matter must NOT appear in body.
    assert.ok(!result.body.includes('---'), 'body must not include front-matter delimiters');
  } finally {
    process.env.HOME = orig;
    _bustCache();
  }
});

test('readSkill returns null for unknown skill name', () => {
  _bustCache();
  const orig = process.env.HOME;
  const tmp = makeTmp();
  const skillsDir = path.join(tmp, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  makeSkill(skillsDir, 'real-skill', 'Real');

  process.env.HOME = tmp;
  try {
    const result = readSkill('nonexistent', null);
    assert.equal(result, null, 'unknown skill must return null');
  } finally {
    process.env.HOME = orig;
    _bustCache();
  }
});

test('readSkill rejects path-traversal attempts in skill name', () => {
  _bustCache();
  const orig = process.env.HOME;
  const tmp = makeTmp();
  const skillsDir = path.join(tmp, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  makeSkill(skillsDir, 'real-skill', 'Real');

  // Plant a sensitive file one level above the skills root.
  fs.writeFileSync(path.join(tmp, '.claude', 'secret.txt'), 'SECRET');

  process.env.HOME = tmp;
  try {
    // Even if an attacker somehow got '../secret' into the skill name, it
    // must not be discoverable (not in the skill list → readSkill returns null).
    const result = readSkill('../secret', null);
    assert.equal(result, null, 'path traversal must be rejected');

    // Also test with an absolute path-like name.
    const result2 = readSkill('/etc/passwd', null);
    assert.equal(result2, null, 'absolute path must be rejected');
  } finally {
    process.env.HOME = orig;
    _bustCache();
  }
});

test('readSkill prefers project skill over user skill when both exist', () => {
  _bustCache();
  const orig = process.env.HOME;
  const tmp = makeTmp();
  const userSkillsDir = path.join(tmp, '.claude', 'skills');
  fs.mkdirSync(userSkillsDir, { recursive: true });
  makeSkill(userSkillsDir, 'shared', 'user version');

  const projectDir = makeTmp();
  const projectSkillsDir = path.join(projectDir, '.claude', 'skills');
  fs.mkdirSync(projectSkillsDir, { recursive: true });

  const projDir = path.join(projectSkillsDir, 'shared');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(
    path.join(projDir, 'SKILL.md'),
    '---\ndescription: project version\n---\n\nProject body.\n',
  );

  process.env.HOME = tmp;
  try {
    const result = readSkill('shared', projectDir);
    assert.ok(result !== null);
    assert.equal(result.source, 'project');
    assert.ok(result.body.includes('Project body.'), 'must read project SKILL.md');
  } finally {
    process.env.HOME = orig;
    _bustCache();
  }
});
