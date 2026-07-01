import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installCollab } from '../lib/collab-install.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'collab-install-'));
}

test('installCollab writes both agent configs and is idempotent', () => {
  const home = tmpHome();
  const shimPath = '/opt/claude-control/bin/collab-mcp.js';

  const r1 = installCollab({ shimPath, node: '/usr/bin/node', home });
  assert.match(r1.claude, /added/);
  assert.match(r1.codex, /added/);

  // Claude: valid JSON, our entry present, command/args correct.
  const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(claude.mcpServers['claude-collab'], { command: '/usr/bin/node', args: [shimPath] });

  // Codex: the TOML block is present.
  const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /\[mcp_servers\.claude-collab\]/);
  assert.match(toml, /args = \["\/opt\/claude-control\/bin\/collab-mcp\.js"\]/);

  // Re-run: Codex block not duplicated; Claude entry updated in place.
  const r2 = installCollab({ shimPath, node: '/usr/bin/node', home });
  assert.match(r2.claude, /updated/);
  assert.match(r2.codex, /already present/);
  const toml2 = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.equal(toml2.match(/\[mcp_servers\.claude-collab\]/g).length, 1);
});

test('installCollab preserves existing Claude settings + other mcpServers', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }),
  );
  installCollab({ shimPath: '/s/bin/collab-mcp.js', node: 'node', home });
  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(cfg.theme, 'dark'); // untouched
  assert.ok(cfg.mcpServers.other); // sibling server preserved
  assert.ok(cfg.mcpServers['claude-collab']);
});
