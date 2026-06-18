/**
 * lib/skills.js — discover and list available Claude slash-command skills.
 *
 * Skills are discovered from ~/.claude/skills/<name>/SKILL.md — the synced,
 * authoritative set of invocable slash commands. (Plugin skills are materialised
 * INTO this directory by `olam skills sync` with their correct prefixed names,
 * e.g. `100x:brainstorm`; we deliberately do NOT walk ~/.claude/plugins/cache,
 * whose raw dir names use dashes — `100x-debug` — and are NOT valid slash
 * commands, so prefilling them would not resolve.)
 *
 * For each directory that contains a SKILL.md, the skill's invocation name is
 * the directory name (e.g. `100x:brainstorm`, `api-design`). We parse the
 * SKILL.md YAML front-matter for `description` (and optionally `name`, but the
 * dir name is always the invocation slug).
 *
 * Results are de-duped by name, sorted alphabetically, and cached for 30 s so
 * repeated opens don't cause repeated disk scans.
 *
 * Uses the same simple front-matter parser as lib/subagents.js — no yaml dep.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CACHE_TTL_MS = 30_000;

/**
 * Per-cwd cache so different sessions (different cwds) each get their own
 * merged skill list. Key: cwd string (or '' for the global user-only list).
 * @type {Map<string, { skills: SkillEntry[], ts: number }>}
 */
const _cache = new Map();

/**
 * @typedef {{ name: string, description: string, source: 'user' | 'project' }} SkillEntry
 */

/**
 * Parse YAML-style front-matter from a markdown file. Same approach as
 * subagents.js — scalar values only, no yaml dep. Returns null when no valid
 * front-matter block is found.
 *
 * Returns both the key/value map AND the body text after the closing `---`.
 *
 * @param {string} content
 * @returns {{ fm: Record<string,string>|null, body: string }}
 */
function _parseFrontMatter(content) {
  const lines = content.split('\n');
  if (lines[0].trim() !== '---') return { fm: null, body: content };
  const end = lines.indexOf('---', 1);
  if (end === -1) return { fm: null, body: content };
  /** @type {Record<string,string>} */
  const result = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (key) result[key] = val;
  }
  const body = lines.slice(end + 1).join('\n');
  return {
    fm: Object.keys(result).length > 0 ? result : null,
    body,
  };
}

/**
 * Read and parse the SKILL.md in a skill directory. Returns the description
 * string, or an empty string when no description front-matter key is present.
 *
 * @param {string} skillDir  absolute path to the skill directory
 * @returns {string}
 */
function _readDescription(skillDir) {
  const mdPath = path.join(skillDir, 'SKILL.md');
  let content;
  try {
    content = fs.readFileSync(mdPath, 'utf8');
  } catch {
    return '';
  }
  const { fm } = _parseFrontMatter(content);
  return fm?.description ?? '';
}

/**
 * Collect skills from a single root directory. Each sub-directory that contains
 * a SKILL.md is treated as a skill; directories without SKILL.md (and plain
 * files) are skipped.
 *
 * @param {string} dir
 * @param {'user' | 'project'} source
 * @param {Map<string, SkillEntry>} into  de-dup map keyed by skill name
 * @param {boolean} overwrite  when true, existing entries are replaced (project > user)
 */
function _collectFrom(dir, source, into, overwrite = false) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillName = entry.name;
    const skillDir = path.join(dir, skillName);
    // Must have a SKILL.md to be a skill.
    const mdPath = path.join(skillDir, 'SKILL.md');
    try {
      fs.accessSync(mdPath, fs.constants.R_OK);
    } catch {
      continue;
    }
    // De-dup: project skills override same-named user skills when overwrite=true.
    if (!overwrite && into.has(skillName)) continue;
    const description = _readDescription(skillDir);
    into.set(skillName, { name: skillName, description, source });
  }
}

/**
 * Discover all available skills for a given session cwd. Merges project skills
 * (from <cwd>/.claude/skills/) on top of user skills (from ~/.claude/skills/).
 * Project skills take precedence over same-named user skills.
 * Results are cached per-cwd for 30 s.
 *
 * @param {string|null} [cwd]  the session's working directory; null/undefined = user skills only
 * @returns {SkillEntry[]}
 */
export function listSkills(cwd) {
  const cacheKey = cwd ?? '';
  const now = Date.now();
  const hit = _cache.get(cacheKey);
  if (hit && now - hit.ts < CACHE_TTL_MS) {
    return hit.skills;
  }

  const home = os.homedir();
  /** @type {Map<string, SkillEntry>} */
  const byName = new Map();

  // 1. User skills first (lower priority).
  const userSkillsDir = path.join(home, '.claude', 'skills');
  _collectFrom(userSkillsDir, 'user', byName, false);

  // 2. Project skills override same-named user skills.
  if (cwd) {
    const projectSkillsDir = path.join(cwd, '.claude', 'skills');
    _collectFrom(projectSkillsDir, 'project', byName, true);
  }

  const skills = [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  _cache.set(cacheKey, { skills, ts: now });
  return skills;
}

/**
 * Read a single skill's SKILL.md content, validated against the discovered set
 * for the given session cwd (traversal guard: only reads files in known dirs).
 *
 * @param {string} name  skill name (directory name, e.g. '100x:brainstorm')
 * @param {string|null} [cwd]  session working directory
 * @returns {{ name: string, source: 'user'|'project', frontMatter: Record<string,string>, body: string }|null}
 */
export function readSkill(name, cwd) {
  // Validate name: must appear in the discovered set for this cwd.
  const discovered = listSkills(cwd);
  const entry = discovered.find((s) => s.name === name);
  if (!entry) return null;

  // Resolve the correct directory WITHOUT interpolating `name` or `cwd` into
  // an arbitrary path. We only look in the two known roots.
  const home = os.homedir();
  const userSkillsDir = path.join(home, '.claude', 'skills');
  const projectSkillsDir = cwd ? path.join(cwd, '.claude', 'skills') : null;

  // Security: resolve the canonical path of the SKILL.md and ensure it stays
  // inside the expected root (prevents any path-traversal via name).
  function safeRead(root) {
    if (!root) return null;
    // path.join normalises '..' segments; then we check the result is still
    // inside root.
    const candidate = path.join(root, name, 'SKILL.md');
    const resolvedRoot = path.resolve(root);
    const resolvedCandidate = path.resolve(candidate);
    if (!resolvedCandidate.startsWith(resolvedRoot + path.sep)) return null;
    let content;
    try {
      content = fs.readFileSync(resolvedCandidate, 'utf8');
    } catch {
      return null;
    }
    return content;
  }

  // Prefer project skill over user skill (matches listing precedence).
  const content =
    (projectSkillsDir ? safeRead(projectSkillsDir) : null) ??
    safeRead(userSkillsDir);
  if (content === null) return null;

  const { fm, body } = _parseFrontMatter(content);

  return {
    name,
    source: entry.source,
    frontMatter: fm ?? {},
    body: body.trimStart(),
  };
}

/**
 * Bust the in-process cache. Used in tests.
 */
export function _bustCache() {
  _cache.clear();
}
