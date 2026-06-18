#!/usr/bin/env node
/**
 * install-pane-hook.mjs — idempotently register the pane-recording hook
 * (hooks/record-pane.mjs) as a Claude Code SessionStart + SessionEnd hook in
 * ~/.claude/settings.json. Lets Claude Control bind each tmux pane to its EXACT
 * transcript with zero guessing.
 *
 * Safe to re-run: detects an existing record-pane hook (by command substring)
 * and leaves the file untouched if already installed. Preserves all other hooks.
 */
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SETTINGS = path.join(homedir(), '.claude', 'settings.json');
const SRC_SCRIPT = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'hooks', 'record-pane.mjs');
// Deploy to ~/.claude/scripts/ and reference it by $HOME — IDENTICAL to the
// atlas-toolbox olam-skills hook (members/idl3/hooks/record-pane.json), so the
// two install paths produce the same settings entry and never double-register.
const DEST_SCRIPT = path.join(homedir(), '.claude', 'scripts', 'record-pane.mjs');
const COMMAND = 'node "$HOME/.claude/scripts/record-pane.mjs"';
const EVENTS = ['SessionStart', 'SessionEnd'];
const MARKER = 'record-pane.mjs';

async function readSettings() {
  try {
    return JSON.parse(await readFile(SETTINGS, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Could not parse ${SETTINGS}: ${err.message}`);
  }
}

function alreadyInstalled(groups) {
  return (groups || []).some((g) =>
    (g.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes(MARKER)),
  );
}

async function main() {
  // Deploy the script to ~/.claude/scripts/ (idempotent — always refresh it).
  await mkdir(path.dirname(DEST_SCRIPT), { recursive: true });
  await copyFile(SRC_SCRIPT, DEST_SCRIPT);

  const settings = await readSettings();
  settings.hooks ??= {};
  let changed = false;

  for (const event of EVENTS) {
    const groups = (settings.hooks[event] ??= []);
    if (alreadyInstalled(groups)) continue;
    groups.push({ hooks: [{ type: 'command', command: COMMAND }] });
    changed = true;
  }

  if (!changed) {
    console.log(`✓ pane-recording hook already installed (${SETTINGS})`);
    return;
  }

  await mkdir(path.dirname(SETTINGS), { recursive: true });
  await writeFile(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  console.log(`✓ installed pane-recording hook → ${SETTINGS}`);
  console.log(`  command: ${COMMAND}`);
  console.log('  Applies to Claude sessions started from now on.');
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
