/**
 * lib/projects-roots.js — multi-root projects discovery.
 *
 * claude-control historically scanned a single `~/.claude/projects`. Sessions
 * launched under an alternate CLAUDE_CONFIG_DIR (org-isolated dirs like
 * ~/.claude-grain, ~/.claude-atlas) write their transcripts under
 * ~/.claude-<org>/projects/<slug>/<id>.jsonl. We discover those sibling roots
 * so a pane's transcript is found regardless of which config dir wrote it.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Dedupe + normalize a roots list, preserving order. Accepts an array
 * (`roots`) and/or a single string (`single`, appended if the array is empty).
 * Back-compat shim for callers migrating from a single `projectsRoot`.
 *
 * @param {string[]|undefined} roots
 * @param {string|null|undefined} single
 * @returns {string[]}
 */
export function normalizeRoots(roots, single) {
  const list = Array.isArray(roots) ? roots.slice() : [];
  if (list.length === 0 && single) list.push(single);
  return [...new Set(list.filter((r) => typeof r === 'string' && r.length > 0))];
}

/**
 * Derive the ordered list of projects roots to scan: the primary root first,
 * then every existing sibling `~/.claude-*/projects` directory.
 *
 * A sibling qualifies only if `<homeDir>/.claude-*/projects` is a directory —
 * which naturally excludes the cockpit's own data dir `~/.claude-control`
 * (it holds media/logs, not projects/). We ALSO hard-exclude `~/.claude-control`
 * and an optional `dataDir` defensively so the server never scans its own state.
 *
 * @param {{homeDir: string, primaryRoot: string, singleRoot?: boolean, dataDir?: string|null}} opts
 * @returns {string[]} deduped, primary-first
 */
export function deriveProjectsRoots({ homeDir, primaryRoot, singleRoot = false, dataDir = null } = {}) {
  const roots = normalizeRoots([primaryRoot]);
  if (singleRoot) return roots;

  const excluded = new Set(
    [path.join(homeDir, '.claude-control'), dataDir]
      .filter(Boolean)
      .map((p) => path.resolve(p)),
  );

  let entries;
  try {
    entries = fs.readdirSync(homeDir, { withFileTypes: true });
  } catch {
    return roots; // unreadable home → primary only
  }

  const siblings = [];
  for (const e of entries) {
    if (!e.name.startsWith('.claude-')) continue; // NOTE: '.claude' (primary parent) does not match
    const dir = path.resolve(path.join(homeDir, e.name));
    if (excluded.has(dir)) continue;
    const projects = path.join(dir, 'projects');
    try {
      if (!fs.statSync(projects).isDirectory()) continue; // statSync follows symlinks (symlinked org dirs OK)
    } catch {
      continue;
    }
    siblings.push(projects);
  }
  siblings.sort(); // stable order

  return normalizeRoots([...roots, ...siblings]);
}
