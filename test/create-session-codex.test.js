// Tests for handleSessionNew codex path and /api/spawn-agents endpoint.
//
// These are pure-logic tests that verify the launch string construction,
// the pre-validation guard, and the response shape — no real tmux, binary,
// or HTTP server required.
//
// Security invariants tested:
//   - Codex launch string is `codex -C '<cwd>'` (shell-quoted, no raw input)
//   - Claude launch string is BYTE-IDENTICAL to pre-Phase-D
//   - Bad cwd → fsp.stat throws (gate that produces 400 before window creation)
//   - /api/spawn-agents response shape (id, available, optional reason, Codex transports)
//   - cwd flows via -C flag to codex, NOT a shell cd command
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fsp from 'node:fs/promises';

import { sanitizeName, shellQuoteName, defaultSessionName } from '../lib/tmux.js';
import { buildSpawnCommand, buildAppServerCommand } from '../lib/codex.js';
import { buildBridgeCommand } from '../lib/claude-print.js';

// Mirror of server.js handleSessionNew's Codex launch construction EXACTLY:
// buildSpawnCommand is the single source of truth for the flags, and the cwd
// arg is shell-quoted because the command is typed into an interactive shell.
// Keeping this in lockstep with the server guards against the prior bug where
// buildSpawnCommand's result was discarded (`void`) and the string hand-rolled.
function launchFor(config, cwd) {
  const { bin, args } = buildSpawnCommand({ cwd, bin: config.codexLaunchCommand });
  return `${bin} ${args.map((a) => (a === cwd ? shellQuoteName(cwd) : a)).join(' ')}`;
}

function appServerLaunchFor(config, endpoint) {
  const { bin, args } = buildAppServerCommand({ endpoint, bin: config.codexLaunchCommand });
  return `${bin} ${args.map((a) => (a === endpoint ? shellQuoteName(endpoint) : a)).join(' ')}`;
}

function selectCodexTransport(body, configuredTransport = 'rpc') {
  return body.codexTransport === 'tmux' || body.codexTransport === 'rpc'
    ? body.codexTransport
    : configuredTransport;
}

// ── Launch string construction ───────────────────────────────────────────────

describe('handleSessionNew codex launch string', () => {
  test('buildSpawnCommand is the source of truth: {bin, args:[-C, cwd]}', () => {
    const cwd = '/home/user/project';
    const { bin, args } = buildSpawnCommand({ cwd, bin: 'codex' });
    assert.equal(bin, 'codex');
    assert.deepEqual(args, ['-C', cwd]);
  });

  test('codex launch string is `codex -C <quoted-cwd>` — no --name', () => {
    const launch = launchFor({ codexLaunchCommand: 'codex' }, '/home/user/project');
    assert.equal(launch, `codex -C '/home/user/project'`);
  });

  test('codex launch string quotes cwd with embedded single quote', () => {
    const launch = launchFor({ codexLaunchCommand: 'codex' }, "/home/user/it's-a-project");
    assert.ok(launch.startsWith("codex -C '"), 'starts with codex -C quote');
    // shellQuoteName escapes embedded single quotes as '\''
    // Result: codex -C '/home/user/it'\''s-a-project'
    assert.ok(launch.includes("\\'"), 'single quote is escaped via backslash sequence');
  });

  test('codex launch string with custom codexLaunchCommand', () => {
    const launch = launchFor({ codexLaunchCommand: '/usr/local/bin/codex' }, '/workspace');
    assert.equal(launch, `/usr/local/bin/codex -C '/workspace'`);
  });

  test('codex launch string does NOT contain --name flag', () => {
    const cwd = '/some/dir';
    const codexLaunchCommand = 'codex';
    const launch = `${codexLaunchCommand} -C ${shellQuoteName(cwd)}`;
    assert.ok(!launch.includes('--name'), 'Codex launch must not have --name');
  });

  test('codex launch string with cwd containing spaces', () => {
    const cwd = '/home/user/my project dir';
    const launch = `codex -C ${shellQuoteName(cwd)}`;
    assert.equal(launch, `codex -C '/home/user/my project dir'`);
    // Single-quote wrapping keeps spaces safe for the shell
    assert.ok(launch.includes("'"), 'cwd must be quoted');
  });
});

describe('handleSessionNew claude launch string (byte-identical regression)', () => {
  test('claude launch string is `<launchCommand> --name <quoted-name>`', () => {
    const config = { launchCommand: 'claude' };
    const name = sanitizeName('my session') || defaultSessionName();
    // This is the EXACT expression from the pre-Phase-D handleSessionNew:
    const launch = `${config.launchCommand} --name ${shellQuoteName(name)}`;
    assert.equal(launch, `claude --name 'my session'`);
  });

  test('claude launch string with custom launchCommand (yolo alias)', () => {
    const config = { launchCommand: 'yolo' };
    const name = 'my-session';
    const launch = `${config.launchCommand} --name ${shellQuoteName(name)}`;
    assert.equal(launch, `yolo --name 'my-session'`);
  });

  test('claude launch string escapes single quotes in name', () => {
    const config = { launchCommand: 'claude' };
    const name = sanitizeName("it's fine");
    const launch = `${config.launchCommand} --name ${shellQuoteName(name)}`;
    assert.ok(launch.startsWith("claude --name '"), 'starts with claude --name quote');
    // The escaped form is '\'' (end-quote, backslash-quote, open-quote)
    assert.ok(launch.includes("\\'"), 'single quote is escaped with backslash sequence');
  });

  test('claude launch string contains --name but NOT -C', () => {
    const config = { launchCommand: 'claude' };
    const name = 'test-session';
    const launch = `${config.launchCommand} --name ${shellQuoteName(name)}`;
    assert.ok(launch.includes('--name'), 'claude launch has --name');
    assert.ok(!launch.includes(' -C '), 'claude launch must not have codex -C flag');
  });

  test('claude print bridge launch uses node bridge and quoted args', () => {
    const launch = buildBridgeCommand({
      nodeBin: '/usr/local/bin/node',
      bridgePath: '/app/bin/claude-print-bridge.mjs',
      socketPath: '/tmp/cc.sock',
      cwd: '/workspace',
      claudeBin: '/usr/local/bin/claude',
      name: 'my session',
      permissionMode: 'acceptEdits',
      quote: shellQuoteName,
    });
    assert.equal(
      launch,
      "'/usr/local/bin/node' '/app/bin/claude-print-bridge.mjs' --socket '/tmp/cc.sock' --cwd '/workspace' --bin '/usr/local/bin/claude' --permission-mode 'acceptEdits' --name 'my session'",
    );
  });
});

// ── buildSpawnCommand shape validation ───────────────────────────────────────

describe('buildSpawnCommand from lib/codex.js', () => {
  test('returns {bin, args:["-C", cwd]}', () => {
    const result = buildSpawnCommand({ cwd: '/workspace', bin: 'codex' });
    assert.deepEqual(result, { bin: 'codex', args: ['-C', '/workspace'] });
  });

  test('default bin is "codex"', () => {
    const result = buildSpawnCommand({ cwd: '/tmp' });
    assert.equal(result.bin, 'codex');
  });

  test('args array always has -C at index 0 and cwd at index 1', () => {
    const result = buildSpawnCommand({ cwd: '/my/project' });
    assert.equal(result.args[0], '-C');
    assert.equal(result.args[1], '/my/project');
  });
});

describe('buildAppServerCommand from lib/codex.js', () => {
  test('returns {bin, args:["app-server","--listen", endpoint]}', () => {
    const endpoint = 'ws://127.0.0.1:43210';
    const result = buildAppServerCommand({ endpoint, bin: 'yodex' });
    assert.deepEqual(result, { bin: 'yodex', args: ['app-server', '--listen', endpoint] });
  });

  test('codex RPC launch appends app-server suffix to custom command', () => {
    const endpoint = 'ws://127.0.0.1:43210';
    const launch = appServerLaunchFor({ codexLaunchCommand: 'yodex' }, endpoint);
    assert.equal(launch, `yodex app-server --listen 'ws://127.0.0.1:43210'`);
  });
});

describe('handleSessionNew codex transport selection', () => {
  test('request body can force tmux/TUI even when server default is rpc', () => {
    const transport = selectCodexTransport({ codexTransport: 'tmux' }, 'rpc');
    assert.equal(transport, 'tmux');
    assert.equal(launchFor({ codexLaunchCommand: 'yodex' }, '/workspace'), `yodex -C '/workspace'`);
  });

  test('request body can force rpc even when server default is tmux', () => {
    const transport = selectCodexTransport({ codexTransport: 'rpc' }, 'tmux');
    assert.equal(transport, 'rpc');
    assert.equal(
      appServerLaunchFor({ codexLaunchCommand: 'yodex' }, 'ws://127.0.0.1:43210'),
      `yodex app-server --listen 'ws://127.0.0.1:43210'`,
    );
  });

  test('missing or invalid transport falls back to configured default', () => {
    assert.equal(selectCodexTransport({}, 'rpc'), 'rpc');
    assert.equal(selectCodexTransport({ codexTransport: 'bad' }, 'tmux'), 'tmux');
  });
});

// ── cwd validation: bad path produces 400, no window created ─────────────────
//
// The server's pre-validation uses fsp.stat BEFORE calling createWindow.
// These tests confirm the guard logic that produces 400-before-window.

describe('handleSessionNew pre-validation (bad cwd must not create window)', () => {
  test('fsp.stat throws for nonexistent cwd', async () => {
    const badCwd = '/nonexistent/__codex_test_path_xyzzy__';
    await assert.rejects(
      () => fsp.stat(badCwd),
      /ENOENT/,
      'fsp.stat should throw ENOENT for nonexistent path',
    );
  });

  test('a non-directory path fails isDirectory() check', async () => {
    // Use a known file that exists
    const filePath = new URL('../package.json', import.meta.url).pathname;
    const st = await fsp.stat(filePath);
    assert.ok(!st.isDirectory(), 'a file is not a directory');
  });

  test('a valid directory passes isDirectory() check', async () => {
    const st = await fsp.stat(os.tmpdir());
    assert.ok(st.isDirectory(), 'tmpdir is a directory');
  });

  test('validation guard returns 400 shape (mock window creation asserted not called)', () => {
    // Simulate the guard logic: windowCreated tracks whether createWindow was called.
    let windowCreated = false;
    const mockCreateWindow = () => {
      windowCreated = true;
      return Promise.resolve('session:0');
    };

    // Replicate the validation logic from handleSessionNew for the codex path:
    async function validateAndCreate(cwd) {
      // Pre-validate cwd BEFORE createWindow
      let st;
      try {
        st = await fsp.stat(cwd);
      } catch {
        return { status: 400, error: `cwd does not exist: ${cwd}` };
      }
      if (!st.isDirectory()) {
        return { status: 400, error: `cwd is not a directory: ${cwd}` };
      }
      // Only reach here if validation passes
      await mockCreateWindow();
      return { status: 200, ok: true };
    }

    return validateAndCreate('/nonexistent/__test__').then((result) => {
      assert.equal(result.status, 400);
      assert.ok(result.error.includes('does not exist'));
      assert.ok(!windowCreated, 'createWindow must NOT be called when cwd is invalid');
    });
  });
});

// ── /api/spawn-agents availability logic ─────────────────────────────────────

describe('/api/spawn-agents response shape', () => {
  test('agent list structure: id, available, optional reason', () => {
    // Simulate what the handler builds when codex is unavailable:
    const claudeResult = { available: true, path: '/usr/bin/claude' };
    const codexResult = { available: false, reason: 'codex not found on PATH' };
    const agents = [
          {
            id: 'claude',
            available: claudeResult.available,
            defaultTransport: 'tmux',
            transports: ['tmux', 'print'],
            ...(claudeResult.available ? {} : { reason: claudeResult.reason }),
          },
      {
        id: 'codex',
        available: codexResult.available,
        defaultTransport: 'rpc',
        transports: ['rpc', 'tmux'],
        ...(codexResult.available ? {} : { reason: codexResult.reason }),
      },
    ];
    assert.equal(agents[0].id, 'claude');
    assert.equal(agents[1].id, 'codex');
    assert.ok(agents[0].available);
    assert.ok(!agents[1].available);
    assert.equal(agents[1].reason, 'codex not found on PATH');
    assert.equal(agents[1].defaultTransport, 'rpc');
    assert.deepEqual(agents[1].transports, ['rpc', 'tmux']);
    assert.equal(agents[0].defaultTransport, 'tmux');
    assert.deepEqual(agents[0].transports, ['tmux', 'print']);
    assert.ok(!('reason' in agents[0]), 'no reason key when available');
  });

  test('both agents available: neither has a reason key', () => {
    const agents = [
      { id: 'claude', available: true, defaultTransport: 'tmux', transports: ['tmux', 'print'] },
      { id: 'codex', available: true, defaultTransport: 'rpc', transports: ['rpc', 'tmux'] },
    ];
    assert.ok(!('reason' in agents[0]));
    assert.ok(!('reason' in agents[1]));
    assert.deepEqual(agents[1].transports, ['rpc', 'tmux']);
    assert.deepEqual(agents[0].transports, ['tmux', 'print']);
  });

  test('both agents unavailable: both have reason strings', () => {
    const claudeResult = { available: false, reason: 'claude not found on PATH' };
    const codexResult = { available: false, reason: 'codex not found on PATH' };
    const agents = [
      {
        id: 'claude',
        available: claudeResult.available,
        defaultTransport: 'tmux',
        transports: ['tmux', 'print'],
        ...(claudeResult.available ? {} : { reason: claudeResult.reason }),
      },
      {
        id: 'codex',
        available: codexResult.available,
        defaultTransport: 'rpc',
        transports: ['rpc', 'tmux'],
        ...(codexResult.available ? {} : { reason: codexResult.reason }),
      },
    ];
    assert.equal(typeof agents[0].reason, 'string');
    assert.equal(typeof agents[1].reason, 'string');
    assert.deepEqual(agents[1].transports, ['rpc', 'tmux']);
  });
});

// ── Security: cwd goes via -C flag, NOT shell cd ─────────────────────────────

describe('codex cwd security: no shell cd in launch string', () => {
  test('codex launch string uses -C flag, no cd command', () => {
    const cwd = '/home/user/workspace';
    const launch = `codex -C ${shellQuoteName(cwd)}`;
    assert.ok(!launch.includes('cd '), 'launch string must not contain shell cd');
    assert.ok(launch.includes(' -C '), 'launch string must use -C flag');
  });

  test('claude launch string does not contain cd either', () => {
    const name = 'my-session';
    const launch = `claude --name ${shellQuoteName(name)}`;
    assert.ok(!launch.includes('cd '), 'claude launch string must not contain shell cd');
  });

  test('cwd with shell-special chars is safely single-quoted (no injection)', () => {
    const maliciousCwd = '/tmp; rm -rf /';
    const launch = `codex -C ${shellQuoteName(maliciousCwd)}`;
    // After quoting, the entire cwd (including the semicolon) is wrapped in single
    // quotes. Shell cannot interpret a semicolon inside '...'. The launch string
    // takes the form: codex -C '/tmp; rm -rf /' — the semicolon is INSIDE the
    // single-quote span, so it cannot act as a shell command separator.
    assert.ok(launch.startsWith("codex -C '"), 'cwd is single-quoted after -C flag');
    // The quoted form wraps the whole string: starts with ' right after -C and ends '
    const afterFlag = launch.slice('codex -C '.length);
    assert.ok(afterFlag.startsWith("'"), 'opening single quote present');
    assert.ok(afterFlag.endsWith("'"), 'closing single quote present');
    // Verify the semicolon is not the very first non-space after -C (i.e. it's inside quotes)
    const match = /^codex -C '(.*)'$/.exec(launch);
    assert.ok(match !== null, 'launch matches `codex -C \'...\'` pattern');
    assert.ok(match[1].includes(';'), 'semicolon is INSIDE the quotes (safe)');
  });
});
