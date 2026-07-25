#!/usr/bin/env node
/**
 * install-pane-hook.mjs — idempotently register the pane-recording hook
 * (hooks/record-pane.mjs) as a Claude Code SessionStart + SessionEnd hook in
 * EVERY Claude config dir. Lets Claude Control bind each tmux pane to its EXACT
 * transcript with zero guessing.
 *
 * Multi-config-dir: sessions for other orgs run with CLAUDE_CONFIG_DIR pointed
 * at ~/.claude-grain, ~/.claude-atlas, etc. A hook registered only in ~/.claude
 * never fires for those, so their panes stay unbound and the cockpit falls back
 * to fuzzy matching — which mis-routes/flip-flops the transcript. Installing the
 * SAME shared script (referenced via $HOME so one copy serves all dirs) into
 * each config dir's settings.json fixes those sessions deterministically.
 *
 * Safe to re-run: detects an existing record-pane hook (by command substring)
 * and leaves each file untouched if already installed. Preserves all other hooks.
 */
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_SCRIPT = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'hooks', 'record-pane.mjs');
// One shared copy under ~/.claude/scripts/, referenced by $HOME — IDENTICAL to
// the atlas-toolbox olam-skills hook (members/idl3/hooks/record-pane.json), so
// the two install paths produce the same settings entry and never double-register.
// The script writes to ~/.claude-control/panes/ regardless of CLAUDE_CONFIG_DIR,
// so a single copy correctly serves grain/atlas/pleri sessions alike.
const DEST_SCRIPT = path.join(homedir(), '.claude', 'scripts', 'record-pane.mjs');
const COMMAND = 'node "$HOME/.claude/scripts/record-pane.mjs"';
const EVENTS = ['SessionStart', 'SessionEnd'];
const MARKER = 'record-pane.mjs';

/**
 * Discover every Claude config dir: ~/.claude plus each ~/.claude-<org> sibling
 * that is actually a config dir (has settings.json or a projects/ dir). We never
 * create a new org config dir — only register into ones the user already uses.
 */
async function configDirs() {
  const home = homedir();
  const dirs = new Set([path.join(home, '.claude')]);
  let siblings = [];
  try {
    siblings = await readdir(home);
  } catch {
    /* ignore */
  }
  for (const name of siblings) {
    if (!/^\.claude-[A-Za-z0-9._-]+$/.test(name)) continue;
    const dir = path.join(home, name);
    const hasSettings = await readFile(path.join(dir, 'settings.json'), 'utf8').then(() => true).catch(() => false);
    const hasProjects = await readdir(path.join(dir, 'projects')).then(() => true).catch(() => false);
    if (hasSettings || hasProjects) dirs.add(dir);
  }
  return [...dirs];
}

async function readSettings(settingsPath) {
  try {
    return JSON.parse(await readFile(settingsPath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Could not parse ${settingsPath}: ${err.message}`);
  }
}

function alreadyInstalled(groups) {
  return (groups || []).some((g) =>
    (g.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes(MARKER)),
  );
}

/** Install (idempotently) into one config dir's settings.json. Returns true if it changed. */
async function installInto(dir) {
  const settingsPath = path.join(dir, 'settings.json');
  const settings = await readSettings(settingsPath);
  settings.hooks ??= {};
  let changed = false;
  for (const event of EVENTS) {
    const groups = (settings.hooks[event] ??= []);
    if (alreadyInstalled(groups)) continue;
    groups.push({ hooks: [{ type: 'command', command: COMMAND }] });
    changed = true;
  }
  if (!changed) {
    console.log(`✓ already installed (${settingsPath})`);
    return false;
  }
  await mkdir(dir, { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  console.log(`✓ installed → ${settingsPath}`);
  return true;
}

async function main() {
  // Deploy the ONE shared script to ~/.claude/scripts/ (idempotent — always refresh it).
  await mkdir(path.dirname(DEST_SCRIPT), { recursive: true });
  await copyFile(SRC_SCRIPT, DEST_SCRIPT);

  const dirs = await configDirs();
  let any = false;
  for (const dir of dirs) any = (await installInto(dir)) || any;

  console.log(`  command: ${COMMAND}`);
  console.log(`  config dirs: ${dirs.length} (${dirs.map((d) => path.basename(d)).join(', ')})`);
  console.log(any ? '  Applies to Claude sessions started from now on.' : '  Nothing to change.');
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
