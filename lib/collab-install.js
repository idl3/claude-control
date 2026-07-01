/**
 * lib/collab-install.js — register the claude-collab MCP shim in both agents'
 * config so interactive Claude and Codex sessions expose the collab_* tools.
 *
 * Touches the user's GLOBAL agent configs, so it's an explicit `claude-control
 * collab install` step, never automatic. Idempotent.
 *   - Claude: ~/.claude/settings.json  → mcpServers["claude-collab"]  (JSON merge)
 *   - Codex:  ~/.codex/config.toml      → [mcp_servers.claude-collab]  (appended once)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {{ shimPath: string, node?: string, home?: string }} opts
 * @returns {{ claude: string, codex: string }} human-readable per-target result
 */
export function installCollab({ shimPath, node = process.execPath, home = os.homedir() }) {
  if (!shimPath) throw new Error('installCollab: shimPath required');

  // --- Claude: JSON merge (preserve all other settings) ---
  const claudePath = path.join(home, '.claude', 'settings.json');
  let claudeCfg = {};
  try {
    claudeCfg = JSON.parse(fs.readFileSync(claudePath, 'utf8')) || {};
  } catch {
    /* fresh file */
  }
  claudeCfg.mcpServers = claudeCfg.mcpServers || {};
  const claudeExisted = !!claudeCfg.mcpServers['claude-collab'];
  claudeCfg.mcpServers['claude-collab'] = { command: node, args: [shimPath] };
  fs.mkdirSync(path.dirname(claudePath), { recursive: true });
  fs.writeFileSync(claudePath, `${JSON.stringify(claudeCfg, null, 2)}\n`);
  const claude = `${claudeExisted ? 'updated' : 'added'} mcpServers.claude-collab in ${claudePath}`;

  // --- Codex: append a TOML block once (skip if already present) ---
  const codexPath = path.join(home, '.codex', 'config.toml');
  let toml = '';
  try {
    toml = fs.readFileSync(codexPath, 'utf8');
  } catch {
    /* fresh file */
  }
  let codex;
  if (/\[mcp_servers\.claude-collab\]/.test(toml)) {
    codex = `already present in ${codexPath} (edit manually to change the path)`;
  } else {
    const block = `\n[mcp_servers.claude-collab]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(shimPath)}]\n`;
    fs.mkdirSync(path.dirname(codexPath), { recursive: true });
    fs.appendFileSync(codexPath, block);
    codex = `added [mcp_servers.claude-collab] to ${codexPath}`;
  }

  return { claude, codex };
}
