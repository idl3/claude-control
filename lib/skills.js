/**
 * lib/skills.js — discover and list available Claude slash-command skills.
 *
 * Skills live in two places:
 *   1. ~/.claude/skills/<name>/SKILL.md  — user-installed skills
 *   2. ~/.claude/plugins/cache/.../skills/<name>/SKILL.md — plugin skills (recursive, depth-bounded)
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

/** @type {{ skills: SkillEntry[], ts: number } | null} */
let _cache = null;

/**
 * @typedef {{ name: string, description: string, source: 'user' | 'plugin' }} SkillEntry
 */

/**
 * Parse YAML-style front-matter from a markdown file. Same approach as
 * subagents.js — scalar values only, no yaml dep. Returns null when no valid
 * front-matter block is found.
 *
 * @param {string} content
 * @returns {Record<string,string>|null}
 */
function _parseFrontMatter(content) {
  const lines = content.split('\n');
  if (lines[0].trim() !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;
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
  return Object.keys(result).length > 0 ? result : null;
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
  const fm = _parseFrontMatter(content);
  return fm?.description ?? '';
}

/**
 * Collect skills from a single root directory. Each sub-directory that contains
 * a SKILL.md is treated as a skill; directories without SKILL.md (and plain
 * files) are skipped.
 *
 * @param {string} dir
 * @param {'user' | 'plugin'} source
 * @param {Map<string, SkillEntry>} into  de-dup map keyed by skill name
 */
function _collectFrom(dir, source, into) {
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
    // De-dup: first discovery wins (user skills before plugin).
    if (into.has(skillName)) continue;
    const description = _readDescription(skillDir);
    into.set(skillName, { name: skillName, description, source });
  }
}

/**
 * Walk the plugin cache for `skills/` directories at any depth up to maxDepth.
 * Calls _collectFrom on each `skills/` directory found.
 *
 * @param {string} dir
 * @param {number} depth
 * @param {number} maxDepth
 * @param {Map<string, SkillEntry>} into
 */
function _walkPluginCache(dir, depth, maxDepth, into) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(dir, entry.name);
    if (entry.name === 'skills') {
      _collectFrom(sub, 'plugin', into);
    } else {
      _walkPluginCache(sub, depth + 1, maxDepth, into);
    }
  }
}

/**
 * Discover all available skills. Returns a de-duped, name-sorted array.
 * Result is cached for 30 s.
 *
 * @returns {SkillEntry[]}
 */
export function listSkills() {
  const now = Date.now();
  if (_cache && now - _cache.ts < CACHE_TTL_MS) {
    return _cache.skills;
  }

  const home = os.homedir();
  /** @type {Map<string, SkillEntry>} */
  const byName = new Map();

  // 1. User skills: ~/.claude/skills/<name>/SKILL.md
  const userSkillsDir = path.join(home, '.claude', 'skills');
  _collectFrom(userSkillsDir, 'user', byName);

  // 2. Plugin skills: ~/.claude/plugins/cache/**/skills/<name>/SKILL.md
  const pluginCacheDir = path.join(home, '.claude', 'plugins', 'cache');
  _walkPluginCache(pluginCacheDir, 0, 8, byName);

  const skills = [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  _cache = { skills, ts: now };
  return skills;
}

/**
 * Bust the in-process cache. Used in tests.
 */
export function _bustCache() {
  _cache = null;
}
