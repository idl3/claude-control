#!/usr/bin/env node
// claude-control CLI entry. Default action starts the server (server.js runs on
// import); subcommands wrap the launchd service scripts and version/help.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const cmd = process.argv[2];

function runScript(name) {
  const child = spawn('/bin/bash', [path.join(ROOT, 'bin', name)], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

switch (cmd) {
  case '-v':
  case '--version':
    console.log(pkg.version);
    break;

  case '-h':
  case '--help':
    console.log(`claude-control v${pkg.version}
Local web UI to watch and drive Claude Code tmux sessions.

Usage:
  claude-control [start]        Start the server (default)
  claude-control setup              Install local deps (ffmpeg + whisper.cpp + model) for voice input
  claude-control install-service    Install the launchd service (macOS): auto-start + restart
  claude-control uninstall-service  Remove the launchd service
  claude-control --version
  claude-control --help

Config (env vars, all optional):
  CLAUDE_CONTROL_PORT     (default 4317)
  CLAUDE_CONTROL_HOST     (default 127.0.0.1)
  CLAUDE_CONTROL_TOKEN    token auth; also read from ~/.claude-control/token.
                          Unset + no file = tokenless (relies on bind/tailnet).
  CLAUDE_CONTROL_PROJECTS (default ~/.claude/projects)

Requires: Node >=20 and tmux on PATH.`);
    break;

  case 'setup':
    runScript('setup.sh');
    break;

  case 'install-service':
    runScript('install-service.sh');
    break;

  case 'uninstall-service':
    runScript('uninstall-service.sh');
    break;

  case undefined:
  case 'start':
    // server.js executes main() on import.
    await import(path.join(ROOT, 'server.js'));
    break;

  default:
    console.error(`unknown command: ${cmd}\nrun "claude-control --help"`);
    process.exit(1);
}
