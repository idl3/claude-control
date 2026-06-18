/**
 * lib/skills.js — discover and list available Claude slash-command skills.
 *
 * Skills come from three places, lowest → highest priority:
 *   1. PLUGIN skills — installed Claude Code plugins listed in
 *      ~/.claude/plugins/installed_plugins.json. Each plugin `<name>@<market>`
 *      has an installPath under which nested `skills/<skill>/SKILL.md` files
 *      live; the slash command is `<name>:<skill>` (e.g. `100x` → `100x:plan-hard`).
 *   2. USER skills — ~/.claude/skills/<name>/SKILL.md (synced/authored). The
 *      directory name IS the slash slug (e.g. `olam:create`, `api-design`).
 *   3. PROJECT skills — <cwd>/.claude/skills/<name>/SKILL.md for the session's
 *      working directory; these override same-named user skills.
 *
 * We parse each SKILL.md's YAML front-matter for `description`. Plugin SKILL.md
 * paths aren't derivable from the slug, so we remember them in `_pluginPaths`
 * for readSkill().
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
 * The Claude config home. Honors CLAUDE_HOME_DIR (Claude Code relocates ~/.claude
 * via this env var — the user sets it per project, e.g. atlas / grain / pleri-org
 * / personal), falling back to ~/.claude. Skills + plugins are read from here.
 *
 * @returns {string}
 */
function claudeHome() {
  const override = process.env.CLAUDE_HOME_DIR;
  return override && override.trim() ? override : path.join(os.homedir(), '.claude');
}

/**
 * Per-cwd cache so different sessions (different cwds) each get their own
 * merged skill list. Key: cwd string (or '' for the global user-only list).
 * @type {Map<string, { skills: SkillEntry[], ts: number }>}
 */
const _cache = new Map();

/**
 * Plugin skill command-name → absolute SKILL.md path. Plugin paths can't be
 * derived from the slug (they live deep under installPath), so we remember them
 * here during discovery for readSkill(). Rebuilt on each plugin scan.
 * @type {Map<string, string>}
 */
const _pluginPaths = new Map();

// Directories never worth descending into when scanning a plugin tree.
const _PLUGIN_SKIP = new Set(['node_modules', '.git', '.github', 'dist', 'build', 'coverage']);
const _PLUGIN_MAX_DEPTH = 6;

/**
 * @typedef {{ name: string, description: string, source: 'user' | 'project' | 'plugin' }} SkillEntry
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
 * Register every `<skillsDir>/<skill>/SKILL.md` as `<pluginSlug>:<skill>`.
 * Lowest priority — never overwrites a user/project (or earlier-plugin) entry.
 *
 * @param {string} skillsDir
 * @param {string} pluginSlug
 * @param {Map<string, SkillEntry>} into
 */
function _registerPluginSkillsIn(skillsDir, pluginSlug, into) {
  let entries;
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const mdPath = path.join(skillsDir, ent.name, 'SKILL.md');
    let content;
    try {
      content = fs.readFileSync(mdPath, 'utf8');
    } catch {
      continue;
    }
    const cmd = `${pluginSlug}:${ent.name}`;
    if (into.has(cmd)) continue; // user/project or an earlier plugin path wins
    const { fm } = _parseFrontMatter(content);
    into.set(cmd, { name: cmd, description: fm?.description ?? '', source: 'plugin' });
    _pluginPaths.set(cmd, mdPath);
  }
}

/**
 * Recursively walk a plugin install dir looking for `skills/` directories (the
 * tree nests them under members/<x>/skills, shared/<x>/skills, etc.). Bounded
 * depth + skip-list keep it cheap.
 *
 * @param {string} dir
 * @param {string} pluginSlug
 * @param {Map<string, SkillEntry>} into
 * @param {number} depth
 */
function _scanPluginDir(dir, pluginSlug, into, depth) {
  if (depth > _PLUGIN_MAX_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || _PLUGIN_SKIP.has(ent.name)) continue;
    const sub = path.join(dir, ent.name);
    if (ent.name === 'skills') _registerPluginSkillsIn(sub, pluginSlug, into);
    else _scanPluginDir(sub, pluginSlug, into, depth + 1);
  }
}

/**
 * Discover skills from every installed Claude Code plugin. The slash command is
 * `<pluginName>:<skillDir>` where pluginName is the part before `@` in the
 * installed_plugins.json key (e.g. `100x@atlas-one` → `100x:plan-hard`).
 *
 * @param {Map<string, SkillEntry>} into
 */
function _collectPluginSkills(into) {
  _pluginPaths.clear();
  const jsonPath = path.join(claudeHome(), 'plugins', 'installed_plugins.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    return;
  }
  const plugins = manifest?.plugins;
  if (!plugins || typeof plugins !== 'object') return;
  for (const [key, arr] of Object.entries(plugins)) {
    const pluginSlug = String(key).split('@')[0];
    if (!pluginSlug) continue;
    for (const e of Array.isArray(arr) ? arr : []) {
      const installPath = e?.installPath;
      if (typeof installPath === 'string' && installPath) {
        _scanPluginDir(installPath, pluginSlug, into, 0);
      }
    }
  }
}

/**
 * Discover all available skills for a given session cwd. Merges project skills
 * (from <cwd>/.claude/skills/) on top of user skills (from ~/.claude/skills/),
 * with plugin skills as the base layer. Project > user > plugin on name clash.
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

  /** @type {Map<string, SkillEntry>} */
  const byName = new Map();

  // 1. Plugin skills — the base layer (e.g. 100x:plan-hard from installed plugins).
  _collectPluginSkills(byName);

  // 2. User skills override plugins on name clash.
  const userSkillsDir = path.join(claudeHome(), 'skills');
  _collectFrom(userSkillsDir, 'user', byName, true);

  // 3. Project skills override user + plugin.
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

  // Plugin skills: resolve from the remembered SKILL.md path, guarded to stay
  // under the claude home plugins dir (defence in depth — path came from our scan).
  if (entry.source === 'plugin') {
    const md = _pluginPaths.get(name);
    if (!md) return null;
    const pluginsRoot = path.resolve(path.join(claudeHome(), 'plugins'));
    const resolved = path.resolve(md);
    if (!resolved.startsWith(pluginsRoot + path.sep)) return null;
    let content;
    try {
      content = fs.readFileSync(resolved, 'utf8');
    } catch {
      return null;
    }
    const { fm, body } = _parseFrontMatter(content);
    return { name, source: 'plugin', frontMatter: fm ?? {}, body: body.trimStart() };
  }

  // User/project skills: resolve the correct directory WITHOUT interpolating
  // `name` or `cwd` into an arbitrary path. We only look in the two known roots.
  const userSkillsDir = path.join(claudeHome(), 'skills');
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
  _pluginPaths.clear();
}
